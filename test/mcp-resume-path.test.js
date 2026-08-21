import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { readAllowedResumeFile } from "../mcp/resume-path.js";

test("resume upload only reads files inside allowed directories", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "resume-home-"));
  const downloads = path.join(home, "Downloads");
  const extra = fs.mkdtempSync(path.join(os.tmpdir(), "resume-extra-"));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "resume-outside-"));
  fs.mkdirSync(downloads);
  const allowed = path.join(downloads, "candidate.pdf");
  const extraFile = path.join(extra, "other.docx");
  const blocked = path.join(outside, "secret.pdf");
  const prefixBypass = path.join(`${downloads}-evil`, "candidate.pdf");
  fs.mkdirSync(`${downloads}-evil`);
  fs.writeFileSync(allowed, "%PDF-1.4\nallowed");
  fs.writeFileSync(extraFile, "docx");
  fs.writeFileSync(blocked, "%PDF-1.4\nsecret");
  fs.writeFileSync(prefixBypass, "%PDF-1.4\nbypass");

  try {
    const file = readAllowedResumeFile(allowed, { homedir: home, env: {} });
    assert.equal(file.name, "candidate.pdf");
    assert.equal(file.type, "application/pdf");
    assert.equal(file.bytes.includes("secret"), false);

    assert.throws(
      () => readAllowedResumeFile(blocked, { homedir: home, env: {} }),
      /不在允许的目录内/,
    );
    assert.throws(
      () => readAllowedResumeFile(prefixBypass, { homedir: home, env: {} }),
      /不在允许的目录内/,
    );
    assert.throws(
      () => readAllowedResumeFile(path.join(outside, "note.txt"), { homedir: home, env: {} }),
      /PDF, DOC, or DOCX/,
    );

    const fromExtra = readAllowedResumeFile(extraFile, {
      homedir: home,
      env: { WORKBENCH_RESUME_ROOTS: extra },
    });
    assert.equal(fromExtra.name, "other.docx");

    const link = path.join(downloads, "linked.pdf");
    fs.symlinkSync(blocked, link);
    assert.throws(
      () => readAllowedResumeFile(link, { homedir: home, env: {} }),
      /不在允许的目录内/,
    );
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(extra, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});
