#!/usr/bin/env node
import {
  chmod,
  lstat,
  mkdir,
  open,
  readdir,
  rename,
  rm,
  rmdir,
} from "node:fs/promises";
import { constants } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { parseArgs } from "node:util";

const MANIFEST_LIMIT = 1024 * 1024;
const DEFAULT_MAX_BYTES = 64 * 1024 * 1024;
const DEFAULT_MAX_FILES = 10_000;
const MAX_ROOT_ENTRIES = 10_000;
const RECOVERY_DIRECTORY = ".profile-recovery";

function usage() {
  console.log(`Usage:
  profile-recovery --source <profile> --destination <profile> --state-file <manifest.json> [--class <id>]
  profile-recovery --source <profile> --destination <profile> --state-file <manifest.json> --apply --class <id> --confirm-target <exact-destination>
  profile-recovery --source <profile> --destination <profile> --state-file <manifest.json> --rollback <receipt.json> --confirm-target <exact-destination>

The default action is a read-only inventory and collision plan. Apply transfers exactly one
explicitly selected, manifest-owned class only when its destination path is absent.`);
}

const VALUE_OPTIONS = ["source", "destination", "state-file", "class", "confirm-target", "rollback", "quiescence-ms"];

function parseArguments(argv) {
  const { values } = parseArgs({
    args: argv,
    allowPositionals: false,
    options: {
      help: { type: "boolean", short: "h" },
      apply: { type: "boolean" },
      ...Object.fromEntries(VALUE_OPTIONS.map((name) => [name, { type: "string", multiple: true }])),
    },
  });
  if (values.help) return { help: true };
  const options = { apply: values.apply === true };
  for (const name of VALUE_OPTIONS) {
    if (values[name]?.length > 1) throw new Error(`--${name} may be supplied only once`);
    if (values[name]) options[name] = values[name][0];
  }
  for (const required of ["source", "destination", "state-file"]) {
    if (!options[required]) throw new Error(`--${required} is required`);
  }
  const quiescenceMs = Number(options["quiescence-ms"] ?? 750);
  if (!Number.isInteger(quiescenceMs) || quiescenceMs < 250 || quiescenceMs > 60_000) {
    throw new Error("--quiescence-ms must be an integer from 250 through 60000");
  }
  options.quiescenceMs = quiescenceMs;
  if (options.apply && options.rollback) throw new Error("--apply and --rollback are mutually exclusive");
  if ((options.apply || options.rollback) && !options["confirm-target"]) {
    throw new Error("mutating operations require --confirm-target with the exact destination path");
  }
  if (options.apply && !options.class) throw new Error("--apply requires exactly one --class");
  if (options.rollback && options.class) throw new Error("--class is not accepted with --rollback");
  return options;
}

function assertPlainRelativePath(value, label) {
  if (typeof value !== "string" || value.length === 0 || value === "." || isAbsolute(value)) {
    throw new Error(`${label} must be a non-empty relative path`);
  }
  const normalized = value.split(/[\\/]+/u);
  if (normalized.some((segment) => segment === "" || segment === "." || segment === "..")) {
    throw new Error(`${label} contains an unsafe path segment`);
  }
  if (normalized[0] === RECOVERY_DIRECTORY) throw new Error(`${label} uses the reserved recovery directory`);
  return normalized.join(sep);
}

function assertInside(root, target, label) {
  const pathRelative = relative(root, target);
  if (pathRelative === "" || pathRelative.startsWith(`..${sep}`) || pathRelative === ".." || isAbsolute(pathRelative)) {
    throw new Error(`${label} escapes or replaces its profile root`);
  }
}


async function assertRootDirectory(path, label) {
  const details = await lstatNoFollow(path);
  if (!details?.isDirectory()) throw new Error(`${label} must be an existing directory`);
}

async function lstatNoFollow(path) {
  try {
    return await lstat(path);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

async function profilePathDetails(root, relativePath, label) {
  let current = root;
  const segments = relativePath.split(sep);
  for (let index = 0; index < segments.length; index += 1) {
    current = join(current, segments[index]);
    const details = await lstatNoFollow(current);
    if (!details) return null;
    if (details.isSymbolicLink()) throw new Error(`${label} contains a symbolic link`);
    if (index < segments.length - 1 && !details.isDirectory()) throw new Error(`${label} has a non-directory parent`);
    if (index === segments.length - 1) return details;
  }
  return null;
}

async function readBoundedRegularFile(path, limit, label) {
  const flags = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0);
  const handle = await open(path, flags);
  try {
    const details = await handle.stat();
    if (!details.isFile()) throw new Error(`${label} must be a regular file`);
    if (details.size > limit) throw new Error(`${label} exceeds its ${limit}-byte read limit`);
    const data = Buffer.alloc(details.size);
    let offset = 0;
    while (offset < data.length) {
      const { bytesRead } = await handle.read(data, offset, data.length - offset, offset);
      if (bytesRead === 0) throw new Error(`${label} changed while being read`);
      offset += bytesRead;
    }
    const after = await handle.stat();
    if (after.size !== details.size || after.mtimeMs !== details.mtimeMs) throw new Error(`${label} changed while being read`);
    return data;
  } finally {
    await handle.close();
  }
}
function assertKnownKeys(value, allowed, label) {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new Error(`${label} contains unknown key ${key}`);
  }
}

function validateManifest(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("state file must contain a JSON object");
  assertKnownKeys(raw, new Set(["schemaVersion", "classes", "activeMarkers"]), "state file");
  if (raw.schemaVersion !== 1) throw new Error("state file schemaVersion must be 1");
  if (!Array.isArray(raw.classes) || raw.classes.length === 0) throw new Error("state file must declare at least one owned class");
  if (raw.classes.length > 100) throw new Error("state file declares too many classes");
  const ids = new Set();
  const paths = new Set();
  const classes = raw.classes.map((entry, index) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new Error(`classes[${index}] must be an object`);
    assertKnownKeys(
      entry,
      new Set(["id", "path", "format", "encryption", "maxBytes", "maxFiles", "requiredTopLevelKeys"]),
      `classes[${index}]`,
    );
    if (typeof entry.id !== "string" || !/^[a-z][a-z0-9-]{0,63}$/u.test(entry.id)) {
      throw new Error(`classes[${index}].id is invalid`);
    }
    if (ids.has(entry.id)) throw new Error(`duplicate class id: ${entry.id}`);
    ids.add(entry.id);
    const path = assertPlainRelativePath(entry.path, `classes[${index}].path`);
    if (paths.has(path)) throw new Error(`duplicate class path: ${entry.path}`);
    paths.add(path);
    if (!["file", "json", "directory"].includes(entry.format)) {
      throw new Error(`classes[${index}].format must be file, json, or directory`);
    }
    if (entry.encryption !== "none" && entry.encryption !== "encrypted") {
      throw new Error(`classes[${index}].encryption must explicitly be none or encrypted`);
    }
    const maxBytes = entry.maxBytes ?? DEFAULT_MAX_BYTES;
    const maxFiles = entry.maxFiles ?? DEFAULT_MAX_FILES;
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 1024 * 1024 * 1024) {
      throw new Error(`classes[${index}].maxBytes is invalid`);
    }
    if (!Number.isSafeInteger(maxFiles) || maxFiles < 1 || maxFiles > 100_000) {
      throw new Error(`classes[${index}].maxFiles is invalid`);
    }
    const requiredTopLevelKeys = entry.requiredTopLevelKeys ?? [];
    if (!Array.isArray(requiredTopLevelKeys) || requiredTopLevelKeys.some((key) => typeof key !== "string" || key.length === 0)) {
      throw new Error(`classes[${index}].requiredTopLevelKeys must contain non-empty strings`);
    }
    if (requiredTopLevelKeys.length > 0 && entry.format !== "json") {
      throw new Error(`classes[${index}] may require JSON keys only for format json`);
    }
    return { id: entry.id, path, format: entry.format, encryption: entry.encryption, maxBytes, maxFiles, requiredTopLevelKeys };
  });
  const activeMarkers = (raw.activeMarkers ?? []).map((path, index) =>
    assertPlainRelativePath(path, `activeMarkers[${index}]`),
  );
  if (activeMarkers.length > 100) throw new Error("state file declares too many activity markers");
  return { schemaVersion: 1, classes, activeMarkers };
}

async function loadManifest(path) {
  const data = await readBoundedRegularFile(path, MANIFEST_LIMIT, "state file");
  let raw;
  try {
    raw = JSON.parse(data.toString("utf8"));
  } catch {
    throw new Error("state file is not valid JSON");
  }
  return {
    manifest: validateManifest(raw),
    digest: createHash("sha256").update(data).digest("hex"),
  };
}

async function scanPath(path, spec) {
  const records = [];
  let bytes = 0;
  let files = 0;
  let entries = 0;
  async function walk(current, relativePath) {
    const details = await lstatNoFollow(current);
    if (!details) throw new Error(`${spec.id} disappeared during inventory`);
    if (details.isSymbolicLink()) throw new Error(`${spec.id} contains a symbolic link`);
    if (relativePath) {
      entries += 1;
      if (entries > spec.maxFiles) throw new Error(`${spec.id} exceeds its ${spec.maxFiles}-entry limit`);
    }
    if (details.isDirectory()) {
      records.push(["directory", relativePath, details.mode & 0o777]);
      const names = await readdir(current);
      names.sort();
      for (const name of names) await walk(join(current, name), relativePath ? join(relativePath, name) : name);
      return;
    }
    if (!details.isFile()) throw new Error(`${spec.id} contains a socket, device, or other unsupported entry`);
    files += 1;
    bytes += details.size;
    if (files > spec.maxFiles) throw new Error(`${spec.id} exceeds its ${spec.maxFiles}-file limit`);
    if (bytes > spec.maxBytes) throw new Error(`${spec.id} exceeds its ${spec.maxBytes}-byte limit`);
    const data = await readBoundedRegularFile(current, spec.maxBytes - (bytes - details.size), `${spec.id}/${relativePath || basename(current)}`);
    records.push(["file", relativePath, details.mode & 0o777, data.length, createHash("sha256").update(data).digest("hex")]);
  }
  await walk(path, "");
  const rootDetails = await lstatNoFollow(path);
  if (spec.format === "directory" && !rootDetails?.isDirectory()) throw new Error(`${spec.id} must be a directory`);
  if (spec.format !== "directory" && !rootDetails?.isFile()) throw new Error(`${spec.id} must be a regular file`);
  if (spec.format === "json") {
    const data = await readBoundedRegularFile(path, spec.maxBytes, spec.id);
    let value;
    try {
      value = JSON.parse(data.toString("utf8"));
    } catch {
      throw new Error(`${spec.id} is not valid JSON`);
    }
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${spec.id} JSON must be an object`);
    for (const key of spec.requiredTopLevelKeys) {
      if (!Object.prototype.hasOwnProperty.call(value, key)) throw new Error(`${spec.id} JSON is missing required key ${key}`);
    }
  }
  return {
    type: rootDetails.isDirectory() ? "directory" : "file",
    files,
    bytes,
    digest: createHash("sha256").update(JSON.stringify(records)).digest("hex"),
  };
}

async function destinationStatus(root, relativePath) {
  const details = await profilePathDetails(root, relativePath, "destination class path");
  if (!details) return { exists: false };
  if (details.isSymbolicLink()) return { exists: true, type: "symbolic-link" };
  if (details.isDirectory()) return { exists: true, type: "directory" };
  if (details.isFile()) return { exists: true, type: "file", bytes: details.size };
  return { exists: true, type: "unsupported" };
}

async function rootSignature(root, manifest) {
  const rootDetails = await lstatNoFollow(root);
  const entries = await readdir(root);
  if (entries.length > MAX_ROOT_ENTRIES) throw new Error(`profile root exceeds the ${MAX_ROOT_ENTRIES}-entry inventory limit`);
  const classes = [];
  for (const spec of manifest.classes) {
    const path = join(root, spec.path);
    const details = await lstatNoFollow(path);
    if (!details) classes.push([spec.id, "missing"]);
    else classes.push([spec.id, details.mode, details.size, details.mtimeMs, details.ctimeMs]);
  }
  return createHash("sha256")
    .update(JSON.stringify([rootDetails.mode, rootDetails.mtimeMs, rootDetails.ctimeMs, entries.length, classes]))
    .digest("hex");
}

async function assertNoActiveMarkers(source, destination, manifest) {
  for (const marker of manifest.activeMarkers) {
    for (const [label, root] of [["source", source], ["destination", destination]]) {
      if (await lstatNoFollow(join(root, marker))) throw new Error(`${label} profile has active marker declared by the state file: ${marker}`);
    }
  }
}

async function waitForQuiescence(source, destination, manifest, milliseconds) {
  await assertNoActiveMarkers(source, destination, manifest);
  const first = await Promise.all([rootSignature(source, manifest), rootSignature(destination, manifest)]);
  await new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
  await assertNoActiveMarkers(source, destination, manifest);
  const second = await Promise.all([rootSignature(source, manifest), rootSignature(destination, manifest)]);
  if (first[0] !== second[0] || first[1] !== second[1]) throw new Error("profile metadata changed during the quiescence window");
}

async function countUnknownEntries(root, manifest) {
  const ownedTopLevels = new Set(manifest.classes.map((entry) => entry.path.split(sep)[0]));
  const entries = await readdir(root);
  if (entries.length > MAX_ROOT_ENTRIES) throw new Error(`profile root exceeds the ${MAX_ROOT_ENTRIES}-entry inventory limit`);
  return entries.filter((name) => !ownedTopLevels.has(name) && name !== RECOVERY_DIRECTORY).length;
}

async function buildPlan(source, destination, manifest, selectedClass) {
  const selected = selectedClass ? manifest.classes.filter((entry) => entry.id === selectedClass) : manifest.classes;
  if (selectedClass && selected.length === 0) throw new Error(`state file does not own class: ${selectedClass}`);
  const classes = [];
  for (const spec of selected) {
    const sourcePath = join(source, spec.path);
    const destinationEntry = await destinationStatus(destination, spec.path);
    let sourceDetails;
    let sourceEntry = { exists: false };
    let error;
    try {
      sourceDetails = await profilePathDetails(source, spec.path, `${spec.id} source path`);
    } catch (pathError) {
      sourceEntry = { exists: true, type: "rejected" };
      error = pathError.message;
    }
    if (sourceDetails && spec.encryption === "encrypted") {
      sourceEntry = { exists: true, type: "preserved-encrypted" };
      error = "encrypted state is preserved in place; no native decryption verification is available";
    } else if (sourceDetails) {
      try {
        sourceEntry = { exists: true, ...(await scanPath(sourcePath, spec)) };
      } catch (scanError) {
        sourceEntry = { exists: true, type: "rejected" };
        error = scanError.message;
      }
    }
    classes.push({
      id: spec.id,
      path: spec.path.split(sep).join("/"),
      encryption: spec.encryption,
      source: sourceEntry,
      destination: destinationEntry,
      action: !sourceEntry.exists ? "unavailable" : destinationEntry.exists ? "collision-preserve-destination" : error ? "rejected" : "copy-missing",
      ...(error ? { reason: error } : {}),
    });
  }
  return {
    mode: "plan",
    source,
    destination,
    unknownEntries: {
      source: await countUnknownEntries(source, manifest),
      destination: await countUnknownEntries(destination, manifest),
      action: "untouched",
    },
    staleStagingOperations: await countStagingOperations(destination),
    classes,
  };
}

async function countStagingOperations(destination) {
  const recoveryRoot = join(destination, RECOVERY_DIRECTORY);
  const recoveryDetails = await lstatNoFollow(recoveryRoot);
  if (!recoveryDetails) return 0;
  if (!recoveryDetails.isDirectory() || recoveryDetails.isSymbolicLink()) throw new Error("destination recovery metadata path is unsafe");
  const stagingPath = join(recoveryRoot, "staging");
  const stagingDetails = await lstatNoFollow(stagingPath);
  if (!stagingDetails) return 0;
  if (!stagingDetails.isDirectory() || stagingDetails.isSymbolicLink()) throw new Error("destination staging metadata path is unsafe");
  return (await readdir(stagingPath)).length;
}
async function pathHasLiveProcess(lockPath) {
  let raw;
  try {
    raw = await readBoundedRegularFile(lockPath, 4096, "recovery lock");
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
  let lock;
  try {
    lock = JSON.parse(raw.toString("utf8"));
  } catch {
    return false;
  }
  if (!Number.isSafeInteger(lock.pid) || lock.pid < 1) return false;
  try {
    process.kill(lock.pid, 0);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    if (error?.code === "EPERM") return true;
    throw error;
  }
}

async function ensurePrivateDirectory(path, label) {
  const details = await lstatNoFollow(path);
  if (details) {
    if (!details.isDirectory() || details.isSymbolicLink()) throw new Error(`${label} is not a safe directory`);
    if (process.platform !== "win32" && (details.mode & 0o077) !== 0) throw new Error(`${label} grants access outside its owner`);
    return;
  }
  await mkdir(path, { mode: 0o700 });
  await chmod(path, 0o700);
}

async function atomicWriteJson(path, value) {
  const parent = await lstatNoFollow(dirname(path));
  if (!parent?.isDirectory() || parent.isSymbolicLink()) throw new Error("receipt parent is not a safe directory");
  const temporary = `${path}.${randomUUID()}.tmp`;
  const handle = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporary, path);
}

async function acquireLock(destination) {
  const recoveryRoot = join(destination, RECOVERY_DIRECTORY);
  const lockPath = join(recoveryRoot, "lock");
  await ensurePrivateDirectory(recoveryRoot, "recovery metadata path");
  await ensurePrivateDirectory(join(recoveryRoot, "backups"), "recovery backup path");
  await ensurePrivateDirectory(join(recoveryRoot, "receipts"), "recovery receipt path");
  await ensurePrivateDirectory(join(recoveryRoot, "staging"), "recovery staging path");
  if (await lstatNoFollow(lockPath)) {
    if (await pathHasLiveProcess(lockPath)) throw new Error("another recovery process owns the destination lock");
    await rename(lockPath, join(recoveryRoot, "backups", `stale-lock-${Date.now()}-${randomUUID()}.json`));
  }
  const handle = await open(lockPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
  await handle.writeFile(`${JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() })}\n`, "utf8");
  await handle.sync();
  await handle.close();
  return async () => rm(lockPath, { force: true });
}

async function ensureSafeParents(destination, relativePath) {
  const created = [];
  let current = destination;
  for (const segment of dirname(relativePath).split(sep).filter((entry) => entry !== "." && entry !== "")) {
    current = join(current, segment);
    const details = await lstatNoFollow(current);
    if (details) {
      if (!details.isDirectory() || details.isSymbolicLink()) throw new Error(`destination parent is unsafe: ${relative(destination, current)}`);
    } else {
      await mkdir(current, { mode: 0o700 });
      created.push(relative(destination, current));
    }
  }
  return created;
}

async function copyRegularFile(source, destination, maximumBytes, label) {
  const sourceHandle = await open(source, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  let destinationHandle;
  try {
    const sourceDetails = await sourceHandle.stat();
    if (!sourceDetails.isFile()) throw new Error(`${label} is not a regular file`);
    if (sourceDetails.size > maximumBytes) throw new Error(`${label} exceeds its byte limit`);
    destinationHandle = await open(destination, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, sourceDetails.mode & 0o777);
    const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, Math.max(sourceDetails.size, 1)));
    let offset = 0;
    while (offset < sourceDetails.size) {
      const { bytesRead } = await sourceHandle.read(buffer, 0, Math.min(buffer.length, sourceDetails.size - offset), offset);
      if (bytesRead === 0) throw new Error(`${label} changed while being copied`);
      await destinationHandle.write(buffer, 0, bytesRead, offset);
      offset += bytesRead;
    }
    await destinationHandle.sync();
    const after = await sourceHandle.stat();
    if (after.size !== sourceDetails.size || after.mtimeMs !== sourceDetails.mtimeMs) throw new Error(`${label} changed while being copied`);
    await chmod(destination, sourceDetails.mode & 0o777);
    return sourceDetails.size;
  } finally {
    await destinationHandle?.close();
    await sourceHandle.close();
  }
}

async function copyPath(source, destination, spec) {
  let files = 0;
  let entries = 0;
  let bytes = 0;
  async function copy(currentSource, currentDestination, relativePath) {
    const details = await lstatNoFollow(currentSource);
    if (!details) throw new Error(`${spec.id} disappeared while being copied`);
    if (details.isSymbolicLink()) throw new Error(`${spec.id} contains a symbolic link`);
    if (relativePath) {
      entries += 1;
      if (entries > spec.maxFiles) throw new Error(`${spec.id} exceeds its entry limit while being copied`);
    }
    if (details.isDirectory()) {
      await mkdir(currentDestination, { mode: details.mode & 0o777 });
      await chmod(currentDestination, details.mode & 0o777);
      const names = await readdir(currentSource);
      names.sort();
      for (const name of names) await copy(join(currentSource, name), join(currentDestination, name), relativePath ? join(relativePath, name) : name);
      return;
    }
    if (!details.isFile()) throw new Error(`${spec.id} contains a socket, device, or other unsupported entry`);
    files += 1;
    if (files > spec.maxFiles) throw new Error(`${spec.id} exceeds its file limit while being copied`);
    const copied = await copyRegularFile(currentSource, currentDestination, spec.maxBytes - bytes, `${spec.id}/${relativePath || basename(currentSource)}`);
    bytes += copied;
    if (bytes > spec.maxBytes) throw new Error(`${spec.id} exceeds its byte limit while being copied`);
  }
  await copy(source, destination, "");
}

function exactTargetConfirmed(options, destination) {
  return resolve(options["confirm-target"]) === destination && options["confirm-target"] === destination;
}

async function applyClass(options, source, destination, manifest, manifestDigest) {
  if (!exactTargetConfirmed(options, destination)) {
    throw new Error(`--confirm-target must exactly equal the resolved destination: ${destination}`);
  }
  const spec = manifest.classes.find((entry) => entry.id === options.class);
  if (!spec) throw new Error(`state file does not own class: ${options.class}`);
  if (spec.encryption !== "none") throw new Error("encrypted state cannot be transferred without native decryption verification");
  const sourcePath = join(source, spec.path);
  const destinationPath = join(destination, spec.path);
  assertInside(source, sourcePath, "source class path");
  assertInside(destination, destinationPath, "destination class path");
  if (!(await profilePathDetails(source, spec.path, `${spec.id} source path`))) throw new Error("source class does not exist");
  if (await profilePathDetails(destination, spec.path, "destination class path")) throw new Error("destination class already exists; collisions are never overwritten or merged");
  await waitForQuiescence(source, destination, manifest, options.quiescenceMs);
  const releaseLock = await acquireLock(destination);
  const operationId = `${new Date().toISOString().replaceAll(/[:.]/gu, "-")}-${randomUUID()}`;
  const stageRoot = join(destination, RECOVERY_DIRECTORY, "staging", operationId);
  const stagedPath = join(stageRoot, spec.id);
  const receiptPath = join(destination, RECOVERY_DIRECTORY, "receipts", `${operationId}.json`);
  let committed = false;
  try {
    if (await profilePathDetails(destination, spec.path, "destination class path")) throw new Error("destination class appeared after the recovery lock was acquired");
    const before = await scanPath(sourcePath, spec);
    await mkdir(stageRoot, { mode: 0o700 });
    await copyPath(sourcePath, stagedPath, spec);
    const staged = await scanPath(stagedPath, spec);
    const sourceAfterCopy = await scanPath(sourcePath, spec);
    if (before.digest !== staged.digest || before.digest !== sourceAfterCopy.digest) {
      throw new Error("source or staged copy changed during transfer verification");
    }
    const createdParents = await ensureSafeParents(destination, spec.path);
    const receipt = {
      schemaVersion: 1,
      operationId,
      status: "prepared",
      createdAt: new Date().toISOString(),
      source,
      destination,
      stateFile: resolve(options["state-file"]),
      stateFileDigest: manifestDigest,
      class: { id: spec.id, path: spec.path.split(sep).join("/"), type: before.type, files: before.files, bytes: before.bytes, digest: before.digest },
      createdParents,
      backupDirectory: join(destination, RECOVERY_DIRECTORY, "backups", operationId),
    };
    await atomicWriteJson(receiptPath, receipt);
    if (process.env.NODE_ENV === "test" && process.env.DONWELLS_RECOVERY_TEST_FAILPOINT === "after-stage") {
      process.exit(86);
    }
    await assertNoActiveMarkers(source, destination, manifest);
    if (await profilePathDetails(destination, spec.path, "destination class path")) throw new Error("destination class appeared before atomic activation");
    await rename(stagedPath, destinationPath);
    committed = true;
    receipt.status = "committed";
    receipt.completedAt = new Date().toISOString();
    await atomicWriteJson(receiptPath, receipt);
    await rm(stageRoot, { recursive: true, force: true });
    return { mode: "apply", status: "committed", class: spec.id, destination: destinationPath, digest: before.digest, receipt: receiptPath };
  } catch (error) {
    if (!committed) await rm(stageRoot, { recursive: true, force: true });
    throw error;
  } finally {
    await releaseLock();
  }
}

async function rollbackReceipt(options, source, destination, manifest, manifestDigest) {
  if (!exactTargetConfirmed(options, destination)) {
    throw new Error(`--confirm-target must exactly equal the resolved destination: ${destination}`);
  }
  const receiptPath = resolve(options.rollback);
  const data = await readBoundedRegularFile(receiptPath, MANIFEST_LIMIT, "rollback receipt");
  let receipt;
  try {
    receipt = JSON.parse(data.toString("utf8"));
  } catch {
    throw new Error("rollback receipt is not valid JSON");
  }
  if (receipt?.schemaVersion !== 1 || !["prepared", "committed"].includes(receipt.status)) throw new Error("rollback receipt is not a recoverable receipt");
  if (receipt.source !== source || receipt.destination !== destination) throw new Error("rollback receipt does not match the explicit source and destination");
  if (receipt.stateFileDigest !== manifestDigest) throw new Error("state file does not match the rollback receipt");
  const relativePath = assertPlainRelativePath(receipt.class?.path, "rollback receipt class path");
  const spec = manifest.classes.find((entry) => entry.id === receipt.class?.id && entry.path === relativePath);
  if (!spec || spec.encryption !== "none") throw new Error("rollback receipt class is not an unencrypted class owned by the state file");
  if (typeof receipt.class.digest !== "string" || !/^[a-f0-9]{64}$/u.test(receipt.class.digest)) {
    throw new Error("rollback receipt digest is invalid");
  }
  if (typeof receipt.operationId !== "string" || !/^[A-Za-z0-9-]{1,128}$/u.test(receipt.operationId)) {
    throw new Error("rollback receipt operation ID is invalid");
  }
  const allowedParents = [];
  let parent = "";
  for (const segment of dirname(relativePath).split(sep).filter((entry) => entry !== "." && entry !== "")) {
    parent = parent ? join(parent, segment) : segment;
    allowedParents.push(parent);
  }
  const createdParents = receipt.createdParents ?? [];
  if (!Array.isArray(createdParents) || createdParents.some((entry) => !allowedParents.includes(entry))) {
    throw new Error("rollback receipt parent list is invalid");
  }
  const target = join(destination, relativePath);
  assertInside(destination, target, "rollback target");
  if (!(await profilePathDetails(destination, relativePath, "rollback target path"))) throw new Error("rollback target does not exist");
  const current = await scanPath(target, spec);
  if (current.digest !== receipt.class.digest) throw new Error("recovered class changed after transfer; rollback refuses to move it");
  await waitForQuiescence(source, destination, { classes: [spec], activeMarkers: manifest.activeMarkers }, options.quiescenceMs);
  const releaseLock = await acquireLock(destination);
  try {
    const backupDirectory = join(destination, RECOVERY_DIRECTORY, "backups", receipt.operationId);
    await mkdir(backupDirectory, { mode: 0o700 });
    const backupPath = join(backupDirectory, receipt.class.id);
    if (await lstatNoFollow(backupPath)) throw new Error("rollback backup already exists");
    await rename(target, backupPath);
    for (const parent of [...createdParents].reverse()) {
      try {
        await rmdir(join(destination, parent));
      } catch (error) {
        if (error?.code !== "ENOTEMPTY" && error?.code !== "ENOENT") throw error;
      }
    }
    const rollbackPath = join(destination, RECOVERY_DIRECTORY, "receipts", `${receipt.operationId}.rollback.json`);
    await atomicWriteJson(rollbackPath, {
      schemaVersion: 1,
      operationId: receipt.operationId,
      status: "rolled-back",
      rolledBackAt: new Date().toISOString(),
      destination,
      class: receipt.class,
      backup: backupPath,
      originalReceipt: receiptPath,
    });
    return { mode: "rollback", status: "rolled-back", class: receipt.class.id, backup: backupPath, receipt: rollbackPath };
  } finally {
    await releaseLock();
  }
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) {
    usage();
    return;
  }
  const source = resolve(options.source);
  const destination = resolve(options.destination);
  const stateFile = resolve(options["state-file"]);
  if (source === destination) throw new Error("source and destination must be different directories");
  await Promise.all([assertRootDirectory(source, "source"), assertRootDirectory(destination, "destination")]);
  const { manifest, digest } = await loadManifest(stateFile);
  if (options.rollback) {
    console.log(JSON.stringify(await rollbackReceipt(options, source, destination, manifest, digest), null, 2));
    return;
  }
  if (options.apply) {
    console.log(JSON.stringify(await applyClass(options, source, destination, manifest, digest), null, 2));
    return;
  }
  console.log(JSON.stringify(await buildPlan(source, destination, manifest, options.class), null, 2));
}

main().catch((error) => {
  console.error(`Profile recovery refused: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
