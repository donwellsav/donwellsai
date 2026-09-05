#!/usr/bin/env node
import { copyFile, mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const source = join(root, "build", "icon.svg");
const output = join(root, "build");
const pngOutput = join(output, "icons");

function run(command, args) {
  const result = spawnSync(command, args, { stdio: "inherit" });
  if (result.error?.code === "ENOENT") {
    throw new Error(`${command} is required to regenerate application icons`);
  }
  if (result.status !== 0) {
    throw new Error(`${command} exited with status ${result.status ?? "unknown"}`);
  }
}

await mkdir(pngOutput, { recursive: true });
for (const size of [16, 32, 48, 64, 128, 256, 512, 1024]) {
  run("magick", ["-background", "none", source, "-resize", `${size}x${size}`, join(pngOutput, `${size}x${size}.png`)]);
}
await mkdir(output, { recursive: true });
await copyFile(join(pngOutput, "1024x1024.png"), join(output, "icon.png"));
run("magick", [
  join(pngOutput, "16x16.png"),
  join(pngOutput, "32x32.png"),
  join(pngOutput, "48x48.png"),
  join(pngOutput, "64x64.png"),
  join(pngOutput, "128x128.png"),
  join(pngOutput, "256x256.png"),
  join(output, "icon.ico"),
]);

if (process.platform === "darwin") {
  const temporary = await mkdtemp(join(tmpdir(), "donwells-icon-"));
  const iconset = join(temporary, "icon.iconset");
  await mkdir(iconset);
  const iconsetFiles = new Map([
    ["icon_16x16.png", 16],
    ["icon_16x16@2x.png", 32],
    ["icon_32x32.png", 32],
    ["icon_32x32@2x.png", 64],
    ["icon_128x128.png", 128],
    ["icon_128x128@2x.png", 256],
    ["icon_256x256.png", 256],
    ["icon_256x256@2x.png", 512],
    ["icon_512x512.png", 512],
    ["icon_512x512@2x.png", 1024],
  ]);
  try {
    for (const [name, size] of iconsetFiles) {
      await copyFile(join(pngOutput, `${size}x${size}.png`), join(iconset, name));
    }
    run("iconutil", ["--convert", "icns", "--output", join(output, "icon.icns"), iconset]);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

console.log(`Generated application icons from ${source}`);
