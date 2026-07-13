import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  extractWordPreviewText,
  isWordAttachment,
  normalizePreviewText,
} from "../server/services/resume-preview.js";

const fixtureDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");

test("legacy DOC files produce a local text preview", async () => {
  const preview = await extractWordPreviewText(path.join(fixtureDir, "sample-resume.doc"));
  assert.match(preview, /Candidate Resume/);
  assert.match(preview, /Agent runtime ownership/);
});

test("Word attachment detection accepts DOC and DOCX", () => {
  assert.equal(isWordAttachment({ name: "resume.doc" }), true);
  assert.equal(isWordAttachment({ name: "resume.docx" }), true);
  assert.equal(isWordAttachment({ name: "resume.pdf", type: "application/pdf" }), false);
});

test("preview text normalization removes binary nulls and excess blank lines", () => {
  assert.equal(normalizePreviewText("Title\u0000\r\n\r\n\r\nBody  \r"), "Title\n\nBody");
});
