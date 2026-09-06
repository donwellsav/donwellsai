#!/usr/bin/env node
import { access, readFile, stat, readdir } from "node:fs/promises";
import { constants } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { parseArgs } from "node:util";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const readJson = async (path) => JSON.parse(await readFile(resolve(root, path), "utf8"));
const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};

const pkg = await readJson("package.json");
const config = await readJson("build/electron-builder.json");
assert(pkg.name === "donwells.ai", "package name must be donwells.ai");
assert(pkg.license === "UNLICENSED", "the private project must not advertise a blanket open-source license");
assert(pkg.packageManager === "pnpm@12.0.0", "package manager must remain pinned to pnpm 12");
assert(pkg.bin?.donwells === "./cli/donwells.mjs", "donwells CLI bin mapping is missing");
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
assert(resources.get("cli") === "cli", "packaged CLI loader directory is missing");
assert(resources.get("dist-cli") === "dist-cli", "packaged compiled CLI directory is missing");
assert(resources.get("resources/bin") === "bin", "packaged CLI launchers are missing");
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
const notices = await readFile(resolve(root, "resources/THIRD_PARTY_NOTICES.txt"), "utf8");
for (const required of ["Copyright (c) 2026 Lovecast Inc.", "Permission is hereby granted", "THE SOFTWARE IS PROVIDED \"AS IS\""]) {
  assert(notices.includes(required), `third-party notice is missing: ${required}`);
}
console.log("Package identity, native unpacking, CLI, icons, and notices are ready.");

// Compare actual shipped bytes, not just the packaging configuration.
const { values } = parseArgs({ options: { resources: { type: 'string' } } });
if (values.resources) {
  const require = createRequire(import.meta.url);
  const asar = require(require.resolve('@electron/asar', { paths: [require.resolve('electron-builder')] }));
  const packaged = resolve(values.resources), archive = resolve(packaged, 'app.asar');
  const files = async directory => (await readdir(resolve(root, directory), { recursive: true, withFileTypes: true }))
    .filter(entry => entry.isFile() && entry.name !== '.DS_Store')
    .map(entry => resolve(entry.parentPath, entry.name).slice(resolve(root, directory).length + 1));
  const built = await files('out');
  const shipped = asar.listPackage(archive).filter(name => name.startsWith('/out/') && !asar.statFile(archive, name.slice(1)).files).map(name => name.slice(5));
  assert(JSON.stringify(built.sort()) === JSON.stringify(shipped.sort()), 'Packaged application file list differs from the current build');
  for (const name of built) assert((await readFile(resolve(root, 'out', name))).equals(asar.extractFile(archive, 'out/' + name)), `Stale packaged application file: ${name}`);
  let resourceCount = 0;
  for (const { from, to } of config.extraResources) {
    const names = (await stat(resolve(root, from))).isDirectory() ? await files(from) : [''];
    for (const name of names) {
      assert((await readFile(resolve(root, from, name))).equals(await readFile(resolve(packaged, to, name))), `Stale packaged resource: ${to}/${name}`);
      resourceCount++;
    }
  }
  console.log(`${built.length} application files and ${resourceCount} external resources match the current build.`);
}
