#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { version } = JSON.parse(await readFile(path.join(projectRoot, "package.json"), "utf8"));
const bundleRoot = path.join(
  projectRoot,
  "src-tauri",
  "target",
  "universal-apple-darwin",
  "release",
  "bundle",
);
const appPath = path.join(bundleRoot, "macos", "Codex Taskboard.app");
const dmgPath = path.join(bundleRoot, "dmg", `Codex Taskboard_${version}_universal.dmg`);
const nodePath = path.join(appPath, "Contents", "MacOS", "node");
const launcherPath = path.join(appPath, "Contents", "MacOS", "codex-taskboard-launcher");
const appEntitlements = path.join(projectRoot, "src-tauri", "Entitlements.plist");
const nodeEntitlements = path.join(projectRoot, "src-tauri", "NodeEntitlements.plist");

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: "utf8", ...options });
  if (result.status !== 0) {
    throw new Error(result.stderr.trim() || result.stdout.trim() || `${command} failed`);
  }
  return { stdout: result.stdout.trim(), stderr: result.stderr.trim() };
}

function readEntitlements(targetPath) {
  const { stdout } = run("/usr/bin/codesign", ["-d", "--entitlements", ":-", targetPath]);
  return JSON.parse(run("/usr/bin/plutil", ["-convert", "json", "-o", "-", "-"], {
    input: stdout,
  }).stdout);
}

function sign(targetPath, entitlementsPath) {
  run("/usr/bin/codesign", [
    "--force",
    "--options", "runtime",
    "--entitlements", entitlementsPath,
    "--sign", "-",
    targetPath,
  ]);
}

run("/usr/bin/xattr", ["-cr", appPath]);
sign(nodePath, nodeEntitlements);
sign(launcherPath, appEntitlements);
sign(appPath, appEntitlements);
run("/usr/bin/codesign", ["--verify", "--deep", "--strict", "--verbose=2", appPath]);

const signedNodeEntitlements = readEntitlements(nodePath);
for (const entitlement of [
  "com.apple.security.cs.allow-jit",
  "com.apple.security.cs.allow-unsigned-executable-memory",
]) {
  if (signedNodeEntitlements[entitlement] !== true) {
    throw new Error(`Locally signed Node.js is missing ${entitlement}`);
  }
}
run(nodePath, [
  "-e",
  "let n=0; const add=(v)=>v+1; for(let i=0;i<5000000;i+=1)n=add(n); if(n!==5000000)process.exit(1)",
]);

const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "codex-taskboard-local-dmg."));
try {
  const stagingPath = path.join(temporaryRoot, "staging");
  await mkdir(stagingPath);
  run("/usr/bin/ditto", [appPath, path.join(stagingPath, path.basename(appPath))]);
  await symlink("/Applications", path.join(stagingPath, "Applications"));
  await mkdir(path.dirname(dmgPath), { recursive: true });
  await rm(dmgPath, { force: true });
  run("/usr/bin/hdiutil", [
    "create", "-quiet",
    "-volname", "Codex Taskboard",
    "-fs", "HFS+",
    "-srcfolder", stagingPath,
    dmgPath,
  ]);
  run("/usr/bin/hdiutil", ["verify", dmgPath]);
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}

console.log(`Created locally signed installer: ${dmgPath}`);
