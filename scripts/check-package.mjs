#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { access, readFile, stat, readdir } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { constants, existsSync, readdirSync } from "node:fs";
import { basename, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { parseArgs } from "node:util";
// Self-contained: throws on symlinks, returns sorted relative file list of a directory.
const relativeFiles = (directory) => {
  const entries = readdirSync(directory, { recursive: true, withFileTypes: true });
  const unsupported = entries.find((entry) => entry.isSymbolicLink());
  if (unsupported) throw new Error(`Packaged resource symlink is not allowed: ${resolve(unsupported.parentPath, unsupported.name)}`);
  return entries.filter((entry) => entry.isFile() && entry.name !== ".DS_Store")
    .map((entry) => relative(directory, resolve(entry.parentPath, entry.name)))
    .sort();
};
const assertMatchingDirectory = (source, shipped) => {
  const files = relativeFiles(source);
  if (JSON.stringify(files) !== JSON.stringify(relativeFiles(shipped))) throw new Error(`Packaged resource file list differs: ${shipped}`);
  return files;
};

const { values } = parseArgs({ options: { resources: { type: 'string' }, platform: { type: 'string' }, arch: { type: 'string' } } });
const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const readJson = async (path) => JSON.parse(await readFile(resolve(root, path), "utf8"));
const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};

execFileSync(process.execPath, [resolve(root, "scripts/build-notices.mjs"), "--check"], { stdio: "inherit" });
const pkg = await readJson("package.json");
const config = await readJson("build/electron-builder.json");
assert(pkg.name === "donwells.ai", "package name must be donwells.ai");
assert(pkg.license === "UNLICENSED", "the private project must not advertise a blanket open-source license");
assert(pkg.packageManager === "pnpm@12.0.0", "package manager must remain pinned to pnpm 12");
assert(pkg.bin?.donwells === "./cli/donwells.mjs", "donwells CLI bin mapping is missing");
assert(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(pkg.version), `package version must be semver, got ${pkg.version}`);
// Two different builds must never share one version identity. Untagged work
// (local packaging, CI runs) skips this; a tagged release must agree.
let releaseTag = "";
try {
  releaseTag = execFileSync("git", ["describe", "--tags", "--exact-match"], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
} catch {
  releaseTag = "";
}
if (releaseTag) {
  assert(releaseTag.replace(/^v/, "") === pkg.version, `HEAD tag ${releaseTag} does not match package version ${pkg.version}`);
}
assert(pkg.dependencies?.["pdfjs-dist"], "pdfjs-dist must be a runtime dependency");
assert(pkg.devDependencies?.["electron-builder"], "electron-builder must be a development dependency");
assert(pkg.scripts?.build === "electron-vite build && pnpm run build:cli", "desktop build must also compile the CLI");
assert(config.appId === "ai.donwells.desktop", "unexpected application ID");
assert(config.productName === "donwells.ai", "unexpected product name");
assert(config.artifactName.startsWith("donwells-"), "artifact names must use the donwells executable identity");
assert(config.asar === true, "asar packaging must remain enabled");
assert(config.asarUnpack.includes("node_modules/node-pty/**/*"), "node-pty native helpers must be unpacked from asar");
for (const platform of ["mac", "linux", "win"]) {
  assert(config[platform]?.executableName === "donwells", `${platform} executable name must be donwells`);
}
const resources = new Map(config.extraResources.map(({ from, to }) => [from, to]));
assert(resources.get("scripts/profile-recovery.mjs") === "recovery/profile-recovery.mjs", "packaged recovery engine is missing");
assert(resources.get("resources/native") === "native", "native resources are not packaged");
const requestedPlatform = values.platform ?? process.platform;
const requestedArch = values.arch ?? process.arch;
assert(['darwin', 'linux', 'win32'].includes(requestedPlatform), 'Unsupported runtime identity platform');
assert(['arm64', 'x64'].includes(requestedArch), 'Unsupported runtime identity architecture');
const stagedIdentityPath = resolve(root, 'resources/native/runtime-identity.node');
const stagedIdentityManifestPath = resolve(root, 'resources/native/runtime-identity-build.json');
await access(stagedIdentityPath, constants.R_OK);
await access(stagedIdentityManifestPath, constants.R_OK);
const stagedIdentityBytes = await readFile(stagedIdentityPath);
const stagedIdentityManifestBytes = await readFile(stagedIdentityManifestPath);
const stagedIdentityManifest = JSON.parse(stagedIdentityManifestBytes.toString('utf8'));
assert(stagedIdentityManifest.identityContractVersion === 1, 'Runtime identity contract version must be 1');
assert(stagedIdentityManifest.runtimeFileSecurityContractVersion === 2, 'Runtime file security contract version must be 2');
assert(stagedIdentityManifest.platform === requestedPlatform, 'Runtime identity platform differs from requested platform');
assert(stagedIdentityManifest.arch === requestedArch, 'Runtime identity architecture differs from requested architecture');
assert(typeof stagedIdentityManifest.sha256 === 'string' && /^[a-f0-9]{64}$/.test(stagedIdentityManifest.sha256), 'Runtime identity manifest hash is malformed');
assert(createHash('sha256').update(stagedIdentityBytes).digest('hex') === stagedIdentityManifest.sha256, 'Runtime identity addon hash differs from manifest');
if (requestedPlatform === process.platform && requestedArch === process.arch) {
  execFileSync(process.execPath, [resolve(root, 'scripts/check-runtime-identity.mjs')], { stdio: 'inherit' });
}
if (values.resources) {
  const shippedIdentityPath = resolve(values.resources, 'native/runtime-identity.node');
  const shippedIdentityManifestPath = resolve(values.resources, 'native/runtime-identity-build.json');
  await access(shippedIdentityPath, constants.R_OK);
  await access(shippedIdentityManifestPath, constants.R_OK);
  assert((await readFile(shippedIdentityPath)).equals(stagedIdentityBytes), 'Shipped runtime identity addon differs from staged bytes');
  assert((await readFile(shippedIdentityManifestPath)).equals(stagedIdentityManifestBytes), 'Shipped runtime identity manifest differs from staged bytes');
}
if ((values.platform ?? process.platform) === 'darwin' && (values.arch ?? process.arch) === 'arm64') {
  const history = await readJson('native/history/build.json');
  const binary = await readFile(resolve(values.resources ?? resolve(root, 'resources'), 'native/history/agentsview'));
  assert(createHash('sha256').update(binary).digest('hex') === history.binarySha256, 'Bundled history engine is missing or differs from the tested build');
  await access(resolve(values.resources ?? resolve(root, 'resources'), 'native/history/LICENSE'), constants.R_OK);
}
assert(resources.get("cli") === "cli", "packaged CLI loader directory is missing");
assert(resources.get("dist-cli") === "dist-cli", "packaged compiled CLI directory is missing");
assert(resources.get("resources/bin") === "bin", "packaged CLI launchers are missing");
assert(resources.get("resources/THIRD_PARTY_DEPENDENCIES.txt") === "THIRD_PARTY_DEPENDENCIES.txt", "dependency notices are not packaged");
assert(resources.get("resources/THIRD_PARTY_NOTICES.txt") === "THIRD_PARTY_NOTICES.txt", "third-party notices are not packaged");
for (const compiledCliPath of ["dist-cli/cli/index.js", "dist-cli/shared/command-catalog.js"]) {
  await access(resolve(root, compiledCliPath), constants.R_OK);
}

const png = await readFile(resolve(root, "build/icon.png"));
assert(png.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])), "build/icon.png is not PNG data");
assert(png.readUInt32BE(16) === 1024 && png.readUInt32BE(20) === 1024, "build/icon.png must be 1024x1024");
const icns = await readFile(resolve(root, "build/icon.icns"));
assert(icns.subarray(0, 4).toString("ascii") === "icns", "build/icon.icns is invalid");
const ico = await readFile(resolve(root, "build/icon.ico"));
assert(ico.readUInt16LE(0) === 0 && ico.readUInt16LE(2) === 1 && ico.readUInt16LE(4) >= 1, "build/icon.ico is invalid");
for (const size of [16, 32, 48, 64, 128, 256, 512, 1024]) {
  await access(resolve(root, `build/icons/${size}x${size}.png`), constants.R_OK);
}
const cliPath = resolve(root, "cli/donwells.mjs");
const cli = await readFile(cliPath, "utf8");
assert(cli.startsWith("#!/usr/bin/env node\n"), "CLI must retain its node shebang");
const launcherPath = resolve(root, "resources/bin/donwells");
const launcher = await readFile(launcherPath, "utf8");
assert(launcher.includes("ELECTRON_RUN_AS_NODE=1 exec"), "Unix CLI launcher must use bundled Electron's Node mode");
const windowsLauncher = await readFile(resolve(root, "resources/bin/donwells.cmd"), "utf8");
assert(windowsLauncher.includes("set \"ELECTRON_RUN_AS_NODE=1\""), "Windows CLI launcher must use bundled Electron's Node mode");
if (process.platform !== "win32") {
  for (const executablePath of [cliPath, launcherPath]) {
    const mode = (await stat(executablePath)).mode;
    assert((mode & 0o111) !== 0, `${executablePath} must be executable`);
  }
}
for (const suffix of ['', '.cmd']) {
  const path = resolve(root, 'resources/bin/donwells-profile-recovery' + suffix);
  const script = await readFile(path, 'utf8');
  assert(script.includes('ELECTRON_RUN_AS_NODE=1') && script.includes('profile-recovery.mjs'), 'Recovery launcher must invoke the shipped engine through bundled Electron');
  if (!suffix && process.platform !== 'win32') assert(((await stat(path)).mode & 0o111) !== 0, 'Recovery launcher must be executable');
}
const packagedMac = values.resources && existsSync(resolve(values.resources, '../MacOS/donwells'));
const platform = packagedMac ? 'darwin' : values.platform ?? (values.resources ? 'other' : process.platform);
assert(!values.platform || ['darwin', 'linux', 'win32'].includes(values.platform), 'Unsupported --platform');
assert(!values.arch || ['arm64', 'x64'].includes(values.arch), 'Unsupported --arch');
if (platform === 'darwin') {
  const native = resolve(values.resources ?? resolve(root, 'resources'), 'native');
  for (const name of ['ghostty.node', 'libDonwellsGhostty.dylib', 'build.json', 'Ghostty-LICENSE.txt', 'GhosttyTerminal-LICENSE.txt', 'MSDisplayLink-LICENSE.txt', 'notices/z2d-COPYING.txt', 'notices/z2d-LICENSE.txt', 'notices/z2d-source/COPYING', 'notices/z2d-source/LICENSE']) {
    assert((await stat(resolve(native, name))).size > 0, `Missing or empty native resource: ${name}`);
  }
  assert((await readdir(resolve(native, 'GhosttyKit_GhosttyTerminal.bundle'))).length > 0, 'Native terminal resource bundle is empty');
  // Shell integration ships for these shells. Bash and zsh come from the
  // wrapper's MIT implementations because upstream's incorporate GPLv3 shell
  // code; fish, elvish and nushell come from the pinned MIT core.
  const integration = resolve(native, 'GhosttyKit_GhosttyTerminal.bundle/Ghostty/shell-integration');
  for (const shell of ['bash', 'zsh', 'fish', 'elvish', 'nushell']) {
    assert(existsSync(resolve(integration, shell)), `Missing shell integration for ${shell}`);
  }
  const permissiveIntegration = new Set(['MIT', 'Apache-2.0', 'BSD-2-Clause', 'BSD-3-Clause', 'ISC']);
  for (const entry of readdirSync(integration, { recursive: true, withFileTypes: true }).filter((item) => item.isFile())) {
    const text = await readFile(resolve(entry.parentPath, entry.name), 'utf8');
    assert(!/under the terms of the GNU General Public License/i.test(text), `Non-permissive shell integration shipped: ${entry.name}`);
    const spdx = /SPDX-License-Identifier:\s*([A-Za-z0-9.+-]+)/i.exec(text);
    assert(spdx === null || permissiveIntegration.has(spdx[1]), `Non-permissive shell integration shipped: ${entry.name}`);
  }
  assert((await readdir(resolve(native, 'notices/z2d-source'))).length > 2, 'z2d covered source is missing');
  const build = JSON.parse(await readFile(resolve(native, 'build.json'), 'utf8'));
  assert(/^[a-f0-9]{40}$/.test(build.wrapper) && /^[a-f0-9]{40}$/.test(build.core) && typeof build.z2dHash === 'string' && build.z2dHash.startsWith('z2d-'), 'Invalid native source provenance');
  assert(build.flags?.includes('-Di18n=false'), 'Native build must disable gettext');
  // Ghostty ships feature areas that a size-conscious embedder can compile out.
  // Trimming them would silently drop terminal capabilities this app advertises,
  // notably the kitty graphics protocol, so the manifest must record no trimming.
  assert(!(build.flags ?? []).some((flag) => String(flag).startsWith('-Dvt-features')), 'Native build must not trim VT features (kitty graphics and other terminal capabilities would be compiled out)');
  const targetArch = { 'aarch64-macos.13.0': 'arm64', 'x86_64-macos.13.0': 'x86_64' }[build.target];
  assert(targetArch, 'Unsupported native target');
  const expected = values.arch ?? (!values.resources ? process.arch : undefined);
  if (expected) assert(targetArch === (expected === 'x64' ? 'x86_64' : expected), 'Native build target differs from requested architecture');
  // ponytail: macOS binary qualification uses Apple tooling; cross-host mac checks fail explicitly rather than infer linkage from filenames.
  for (const binary of ['ghostty.node', 'libDonwellsGhostty.dylib']) {
    const path = resolve(native, binary);
    assert(execFileSync('lipo', ['-archs', path], { encoding: 'utf8' }).trim() === targetArch, `Native architecture mismatch: ${binary}`);
    const links = execFileSync('otool', ['-L', path], { encoding: 'utf8' });
    assert(!/libintl|gettext/.test(links), `gettext dependency in ${binary}`);
    // The first entry is this dylib's install ID, not an external dependency.
    for (const line of links.trim().split('\n').slice(2)) {
      const dependency = line.trim().split(' (')[0];
      assert(dependency.startsWith('/usr/lib/') || dependency.startsWith('/System/Library/') || dependency === '@rpath/libDonwellsGhostty.dylib', `Nonportable native dependency: ${dependency}`);
    }
  }
  if (packagedMac) assert(execFileSync('lipo', ['-archs', resolve(values.resources, '../MacOS/donwells')], { encoding: 'utf8' }).trim().split(/\s+/).includes(targetArch), 'App executable does not support native library architecture');

  // Ghostty is the terminal, so a present-but-dead module must fail packaging
  // rather than ship and silently degrade every pane to xterm. Loading resolves
  // libDonwellsGhostty through dyld and runs the N-API initializer, so a
  // successful require proves the whole native stack is usable.
  if (targetArch === process.arch) {
    process.env.GHOSTTY_RESOURCE_BUNDLE = resolve(native, 'GhosttyKit_GhosttyTerminal.bundle');
    const nativeTerminal = createRequire(import.meta.url)(resolve(native, 'ghostty.node'));
    for (const name of ['request', 'listen']) {
      assert(typeof nativeTerminal?.[name] === 'function', `Native terminal module does not expose ${name}; Ghostty could not initialize`);
    }
  } else {
    console.log(`Skipping native terminal load check: built for ${targetArch}, running on ${process.arch}.`);
  }
}
const notices = await readFile(resolve(root, "resources/THIRD_PARTY_NOTICES.txt"), "utf8");
for (const required of ["Copyright (c) 2026 Lovecast Inc.", "Permission is hereby granted", "THE SOFTWARE IS PROVIDED \"AS IS\""]) {
  assert(notices.includes(required), `third-party notice is missing: ${required}`);
}
console.log("Package identity, native unpacking, CLI, icons, and notices are ready.");

// Compare actual shipped bytes, not just the packaging configuration.
if (values.resources) {
  const require = createRequire(import.meta.url);
  const asar = require(require.resolve('@electron/asar', { paths: [require.resolve('electron-builder')] }));
  const packaged = resolve(values.resources), archive = resolve(packaged, 'app.asar');
  const files = async directory => (await readdir(resolve(root, directory), { recursive: true, withFileTypes: true }))
    .filter(entry => entry.isFile() && entry.name !== '.DS_Store')
    .map(entry => resolve(entry.parentPath, entry.name).slice(resolve(root, directory).length + 1));
  assert(!asar.listPackage(archive).some(name => name.startsWith('/node_modules/@napi-rs/canvas')), 'Unused Node canvas binaries must not ship');
  // Provider credentials live only in the per-profile encrypted store, which the
  // app creates at runtime. A secret-bearing file inside the archive would ship
  // the same bytes to every installation, so any such member fails the gate.
  const secretBearing = /(provider-secrets|secrets\.enc\.json|\.credentials\.json|auth\.json)$/
  const leaked = asar.listPackage(archive).filter(name => secretBearing.test(name))
  assert(leaked.length === 0, `Secret-bearing files must not ship in the archive: ${leaked.join(', ')}`);
  // The same rule applies to everything actually shipped outside the archive.
  // The packaged tree is scanned directly rather than only its sources, because
  // an entry may name a file, and a loose file that reached Resources by any
  // route is exactly what this must catch.
  const packagedNames = await readdir(packaged, { recursive: true, withFileTypes: true })
    .then(entries => entries.filter(entry => entry.isFile()).map(entry => entry.name))
  const packagedLeaked = packagedNames.filter(name => secretBearing.test(name))
  assert(packagedLeaked.length === 0, `Secret-bearing files must not ship in resources: ${packagedLeaked.join(', ')}`);
  for (const { from } of config.extraResources) {
    const source = resolve(root, from)
    const names = (await stat(source)).isDirectory()
      ? await readdir(source, { recursive: true, withFileTypes: true }).then(entries => entries.filter(entry => entry.isFile()).map(entry => entry.name))
      : [basename(source)]
    for (const name of names) {
      assert(!secretBearing.test(name), `Secret-bearing resource must not ship: ${from}/${name}`);
    }
  }
  const built = await files('out');
  const shipped = asar.listPackage(archive).filter(name => name.startsWith('/out/') && !asar.statFile(archive, name.slice(1)).files).map(name => name.slice(5));
  assert(JSON.stringify(built.sort()) === JSON.stringify(shipped.sort()), 'Packaged application file list differs from the current build');
  for (const name of built) assert((await readFile(resolve(root, 'out', name))).equals(asar.extractFile(archive, 'out/' + name)), `Stale packaged application file: ${name}`);
  let resourceCount = 0;
  for (const { from, to } of config.extraResources) {
    const directory = (await stat(resolve(root, from))).isDirectory();
    const names = directory ? assertMatchingDirectory(resolve(root, from), resolve(packaged, to)) : [''];
    for (const name of names) {
      assert((await readFile(resolve(root, from, name))).equals(await readFile(resolve(packaged, to, name))), `Stale packaged resource: ${to}/${name}`);
      resourceCount++;
    }
  }
  console.log(`${built.length} application files and ${resourceCount} external resources match the current build.`);
}
