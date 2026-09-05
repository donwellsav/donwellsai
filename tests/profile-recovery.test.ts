import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";

const recoveryScript = resolve("scripts/profile-recovery.mjs");
const createdRoots: string[] = [];

afterEach(async () => {
  for (const root of createdRoots.splice(0)) await rm(root, { recursive: true, force: true });
});

function invoke(args: string[], environment: Record<string, string> = {}) {
  return spawnSync(process.execPath, [recoveryScript, ...args], {
    cwd: resolve("."),
    encoding: "utf8",
    env: { ...process.env, ...environment },
  });
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "profile-recovery-test-"));
  createdRoots.push(root);
  const source = join(root, "source");
  const destination = join(root, "destination");
  const stateFile = join(root, "state.json");
  await Promise.all([mkdir(source), mkdir(destination)]);
  await writeFile(join(source, "settings.json"), JSON.stringify({ version: 1, sourceOnly: true }));
  await writeFile(join(source, "session.json"), JSON.stringify({ version: 1, tabs: ["one"] }));
  await writeFile(join(source, "secrets.bin"), "encrypted-bytes");
  await mkdir(join(source, "unowned-source"));
  await writeFile(join(destination, "settings.json"), JSON.stringify({ version: 2, authoritative: true }));
  await mkdir(join(destination, "unowned-destination"));
  await writeFile(
    stateFile,
    JSON.stringify({
      schemaVersion: 1,
      activeMarkers: ["runtime.sock"],
      classes: [
        {
          id: "settings",
          path: "settings.json",
          format: "json",
          encryption: "none",
          maxBytes: 4096,
          maxFiles: 1,
          requiredTopLevelKeys: ["version"],
        },
        {
          id: "session",
          path: "session.json",
          format: "json",
          encryption: "none",
          maxBytes: 4096,
          maxFiles: 1,
          requiredTopLevelKeys: ["version"],
        },
        {
          id: "secrets",
          path: "secrets.bin",
          format: "file",
          encryption: "encrypted",
          maxBytes: 4096,
          maxFiles: 1,
        },
      ],
    }),
  );
  return { root, source, destination, stateFile };
}

function baseArguments(source: string, destination: string, stateFile: string) {
  return ["--source", source, "--destination", destination, "--state-file", stateFile, "--quiescence-ms", "250"];
}

describe("profile recovery", () => {
  it("plans collisions without exposing or changing unknown state, applies one missing class, and rolls it back", async () => {
    const { source, destination, stateFile } = await fixture();
    const beforeSettings = await readFile(join(destination, "settings.json"), "utf8");
    const args = baseArguments(source, destination, stateFile);

    const planned = invoke(args);
    expect(planned.status).toBe(0);
    const plan = JSON.parse(planned.stdout);
    expect(plan.classes.map((entry: { id: string; action: string }) => [entry.id, entry.action])).toEqual([
      ["settings", "collision-preserve-destination"],
      ["session", "copy-missing"],
      ["secrets", "rejected"],
    ]);
    expect(plan.unknownEntries).toEqual({ source: 1, destination: 1, action: "untouched" });
    expect(planned.stdout).not.toContain("unowned-source");
    expect(planned.stdout).not.toContain("unowned-destination");

    expect(plan.classes[2].source).toEqual({ exists: true, type: "preserved-encrypted" });
    const collision = invoke([...args, "--apply", "--class", "settings", "--confirm-target", destination]);
    expect(collision.status).toBe(1);
    const encrypted = invoke([...args, "--apply", "--class", "secrets", "--confirm-target", destination]);
    expect(encrypted.status).toBe(1);
    expect(existsSync(join(destination, "secrets.bin"))).toBe(false);
    const inexactTarget = invoke([...args, "--apply", "--class", "session", "--confirm-target", `${destination}/`]);
    expect(inexactTarget.status).toBe(1);

    const applied = invoke([...args, "--apply", "--class", "session", "--confirm-target", destination]);
    expect(applied.status).toBe(0);
    const result = JSON.parse(applied.stdout);
    expect(JSON.parse(await readFile(join(destination, "session.json"), "utf8"))).toEqual({ version: 1, tabs: ["one"] });
    expect(await readFile(join(destination, "settings.json"), "utf8")).toBe(beforeSettings);
    expect(existsSync(join(destination, "unowned-destination"))).toBe(true);

    const rolledBack = invoke([...args, "--rollback", result.receipt, "--confirm-target", destination]);
    expect(rolledBack.status).toBe(0);
    const rollback = JSON.parse(rolledBack.stdout);
    expect(existsSync(join(destination, "session.json"))).toBe(false);
    expect(JSON.parse(await readFile(rollback.backup, "utf8"))).toEqual({ version: 1, tabs: ["one"] });
    expect(await readFile(join(destination, "settings.json"), "utf8")).toBe(beforeSettings);
  });

  it("survives interruption after verified staging and rejects symbolic links", async () => {
    const { root, source, stateFile } = await fixture();
    const interruptedDestination = join(root, "interrupted-destination");
    await mkdir(interruptedDestination);
    const args = baseArguments(source, interruptedDestination, stateFile);

    const interrupted = invoke(
      [...args, "--apply", "--class", "session", "--confirm-target", interruptedDestination],
      { NODE_ENV: "test", DONWELLS_RECOVERY_TEST_FAILPOINT: "after-stage" },
    );
    expect(interrupted.status).toBe(86);
    expect(existsSync(join(interruptedDestination, "session.json"))).toBe(false);

    const resumed = invoke([...args, "--apply", "--class", "session", "--confirm-target", interruptedDestination]);
    expect(resumed.status).toBe(0);
    expect(JSON.parse(await readFile(join(interruptedDestination, "session.json"), "utf8"))).toEqual({ version: 1, tabs: ["one"] });

    const symlinkDestination = join(root, "symlink-destination");
    await mkdir(symlinkDestination);
    await symlink(join(source, "settings.json"), join(source, "linked.json"));
    const symlinkState = join(root, "symlink-state.json");
    await writeFile(
      symlinkState,
      JSON.stringify({
        schemaVersion: 1,
        classes: [
          { id: "linked", path: "linked.json", format: "json", encryption: "none", maxBytes: 4096, maxFiles: 1 },
        ],
      }),
    );
    const rejected = invoke(baseArguments(source, symlinkDestination, symlinkState));
    expect(rejected.status).toBe(0);
    expect(JSON.parse(rejected.stdout).classes[0]).toMatchObject({ action: "rejected", source: { type: "rejected" } });
  });
});
