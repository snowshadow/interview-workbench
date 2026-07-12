import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const sourceFiles = ["vite.config.js", ...["server", "src", "scripts", "mcp"]
  .flatMap((directory) => walk(path.join(root, directory)))
  .filter((file) => /\.(js|jsx|mjs)$/.test(file))
  .map((file) => path.relative(root, file))];

const uniqueFiles = [...new Set(sourceFiles)];
for (const file of uniqueFiles) {
  if (file.endsWith(".jsx")) continue;
  const result = spawnSync(process.execPath, ["--check", file], {
    cwd: root,
    encoding: "utf8",
  });
  if (result.status !== 0) {
    process.stderr.write(result.stderr || result.stdout);
    process.exit(result.status || 1);
  }
}

const forbiddenPublicFiles = fs
  .readdirSync(root)
  .filter((name) => /-面试准备\.md$/.test(name) || name === "火山文档.md");
if (forbiddenPublicFiles.length) {
  process.stdout.write(
    `Private files remain in the working directory and are excluded from packaging: ${forbiddenPublicFiles.length}\n`,
  );
}

process.stdout.write(`Checked ${uniqueFiles.length} source files.\n`);

function walk(directory) {
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const target = path.join(directory, entry.name);
    return entry.isDirectory() ? walk(target) : [target];
  });
}
