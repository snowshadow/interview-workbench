export const MAX_RESUME_FILE_SIZE = 4 * 1024 * 1024;

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error("读取文件失败"));
    reader.readAsDataURL(file);
  });
}

export async function serializeResumeFile(file) {
  if (file.size > MAX_RESUME_FILE_SIZE) {
    throw new Error("简历文件超过 4MB，当前 MVP 先支持小文件预览");
  }

  const dataUrl = await readFileAsDataUrl(file);
  const previewText = await extractDocxPreviewText(file);
  return {
    name: file.name,
    type: file.type || inferFileType(file.name),
    size: file.size,
    dataUrl,
    previewText,
    updatedAt: new Date().toISOString(),
  };
}

export function dataUrlToUint8Array(dataUrl) {
  const base64 = String(dataUrl).split(",")[1] || "";
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

export function resumeFileSource(file) {
  return file?.url || file?.dataUrl || "";
}

async function extractDocxPreviewText(file) {
  if (!isDocxFile(file)) return "";
  try {
    const mammoth = await import("mammoth");
    const result = await mammoth.extractRawText({ arrayBuffer: await file.arrayBuffer() });
    return result.value.trim();
  } catch {
    return "";
  }
}

function inferFileType(name) {
  const lower = name.toLowerCase();
  if (lower.endsWith(".pdf")) return "application/pdf";
  if (lower.endsWith(".doc")) return "application/msword";
  if (lower.endsWith(".docx")) {
    return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
  }
  return "application/octet-stream";
}

export function isPdfFile(file) {
  return file?.type === "application/pdf" || file?.name?.toLowerCase().endsWith(".pdf");
}

function isDocxFile(file) {
  return (
    file?.type === "application/vnd.openxmlformats-officedocument.wordprocessingml.document" ||
    file?.name?.toLowerCase().endsWith(".docx")
  );
}

export function isWordFile(file) {
  return (
    isDocxFile(file) ||
    file?.type === "application/msword" ||
    file?.name?.toLowerCase().endsWith(".doc")
  );
}

export function formatFileSize(size = 0) {
  if (size < 1024 * 1024) return `${Math.max(1, Math.round(size / 1024))}KB`;
  return `${(size / 1024 / 1024).toFixed(1)}MB`;
}
