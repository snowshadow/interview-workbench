import { spawnSync } from "node:child_process";

const result = spawnSync("npm", ["pack", "--dry-run", "--json"], {
  encoding: "utf8",
  shell: process.platform === "win32",
});
if (result.status !== 0) {
  process.stderr.write(result.stderr || result.stdout);
  process.exit(result.status || 1);
}

const report = JSON.parse(result.stdout)[0];
const files = report.files.map((entry) => entry.path);
const publicRootDocuments = new Set([
  "README.md", "ARCHITECTURE.md", "CONTRIBUTING.md", "PRIVACY.md", "RELEASE_CHECKLIST.md", "SECURITY.md",
]);
const publicSkills = new Set([
  "interview-create-session", "interview-preparation", "interview-resume-screening", "interview-summary",
]);
const forbidden = files.filter((file) => {
  if (file === ".env.example") return false;
  if (!file.includes("/") && file.endsWith(".md")) return !publicRootDocuments.has(file);
  if (file.startsWith("skills/")) return !publicSkills.has(file.split("/")[1]);
  if (/^docs\/(design|assets\/logo-candidates)\//.test(file)) return true;
  return /(^|\/)(data|logs|private|coverage)(\/|$)|(^|\/)\.env($|\.)|-面试准备\.md$|火山文档\.md$/.test(file);
});
if (forbidden.length) {
  process.stderr.write(`Private files would enter the package:\n${forbidden.join("\n")}\n`);
  process.exit(1);
}

process.stdout.write(`Package check passed: ${files.length} files, ${report.size} bytes.\n`);
