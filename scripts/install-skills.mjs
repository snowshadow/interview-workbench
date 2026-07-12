#!/usr/bin/env node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sourceDir = path.join(projectDir, "skills");
const targetName = process.argv[2];
const customIndex = process.argv.indexOf("--target-dir");
const customDir = customIndex >= 0 ? process.argv[customIndex + 1] : "";
const targets = {
  codex: path.join(process.env.CODEX_HOME || path.join(os.homedir(), ".codex"), "skills"),
  claude: path.join(os.homedir(), ".claude", "skills"),
  codebuddy: path.join(os.homedir(), ".codebuddy", "skills"),
};

const targetDir = customDir ? path.resolve(customDir) : targets[targetName];
if (!targetDir) {
  process.stderr.write(
    "Usage: node scripts/install-skills.mjs <codex|claude|codebuddy> [--target-dir <path>]\n",
  );
  process.exit(1);
}

fs.mkdirSync(targetDir, { recursive: true });
for (const entry of fs.readdirSync(sourceDir, { withFileTypes: true })) {
  if (!entry.isDirectory()) continue;
  const source = path.join(sourceDir, entry.name);
  const target = path.join(targetDir, entry.name);
  fs.rmSync(target, { recursive: true, force: true });
  fs.cpSync(source, target, { recursive: true });
  process.stdout.write(`Installed ${entry.name} -> ${target}\n`);
}
