import WordExtractor from "word-extractor";

const MAX_PREVIEW_CHARS = 500000;
const extractor = new WordExtractor();

export function isWordAttachment(file) {
  const name = String(file?.name || "").toLowerCase();
  return (
    name.endsWith(".doc") ||
    name.endsWith(".docx") ||
    file?.type === "application/msword" ||
    file?.type === "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
  );
}

export async function extractWordPreviewText(source) {
  const document = await extractor.extract(source);
  return normalizePreviewText(document.getBody());
}

export function normalizePreviewText(value) {
  return String(value || "")
    .replaceAll("\u0000", "")
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.trimEnd())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
    .slice(0, MAX_PREVIEW_CHARS);
}
