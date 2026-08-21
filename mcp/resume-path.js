import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TYPES = {
  ".pdf": "application/pdf",
  ".doc": "application/msword",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
};
const MAX_BYTES = 10 * 1024 * 1024;

export function defaultResumeRoots(homedir = os.homedir()) {
  return ["Downloads", "Documents", "Desktop"].map((name) => path.join(homedir, name));
}

export function parseResumeRoots(value) {
  return String(value || "")
    .split(/[,:]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

export function isPathInside(child, parent) {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

export function readAllowedResumeFile(resumePath, options = {}) {
  const env = options.env || process.env;
  const homedir = options.homedir || os.homedir();
  const roots = [
    ...defaultResumeRoots(homedir),
    ...parseResumeRoots(env.WORKBENCH_RESUME_ROOTS),
    ...(options.extraRoots || []),
  ].map((root) => resolveRoot(root));

  const absolutePath = path.resolve(String(resumePath || ""));
  const extension = path.extname(absolutePath).toLowerCase();
  if (!TYPES[extension]) throw new Error("Resume must be a PDF, DOC, or DOCX file");

  let realPath;
  try {
    realPath = fs.realpathSync(absolutePath);
  } catch {
    throw new Error("简历路径不在允许的目录内");
  }

  const stat = fs.statSync(realPath);
  if (!stat.isFile() || stat.size < 1 || stat.size > MAX_BYTES) {
    throw new Error("Resume must be a file between 1 byte and 10MB");
  }

  if (!roots.some((root) => isPathInside(realPath, root))) {
    throw new Error("简历路径不在允许的目录内");
  }

  return {
    name: path.basename(absolutePath),
    type: TYPES[extension],
    size: stat.size,
    bytes: fs.readFileSync(realPath),
  };
}

function resolveRoot(root) {
  try {
    return fs.realpathSync(root);
  } catch {
    return path.resolve(root);
  }
}
