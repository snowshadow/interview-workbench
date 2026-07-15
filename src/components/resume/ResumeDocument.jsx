import { FileText } from "lucide-react";
import { isPdfFile, isWordFile, resumeFileSource } from "../../lib/resume-files.js";
import { PdfPreview } from "./PdfPreview.jsx";
import { DocxPreview } from "./DocxPreview.jsx";

export function ResumeDocument({
  file,
  markMode,
  noteDraft,
  notes,
  onCancelDraft,
  onDraftChange,
  onFocusNote,
  onMark,
  onSaveDraft,
  previewError,
  selectedNoteId,
  zoom,
}) {
  const markerProps = {
    markMode,
    noteDraft,
    notes,
    onCancelDraft,
    onDraftChange,
    onFocusNote,
    onMark,
    onSaveDraft,
    selectedNoteId,
  };

  if (isPdfFile(file)) {
    return <PdfPreview file={file} markerProps={markerProps} zoom={zoom} />;
  }

  if (isWordFile(file) && file.previewText) {
    return <DocxPreview file={file} markerProps={markerProps} zoom={zoom} />;
  }

  if (isWordFile(file) && !previewError) {
    return (
      <div className="resume-file-placeholder">
        <FileText size={30} />
        <p>{file.name}</p>
        <span>正在生成 Word 预览...</span>
      </div>
    );
  }

  return (
    <div className="resume-file-placeholder">
      <FileText size={30} />
      <p>{file.name}</p>
      <span>{previewError || "文件已保存到当前面试；当前格式先用下载查看。"}</span>
      <a href={resumeFileSource(file)} download={file.name}>
        下载查看
      </a>
    </div>
  );
}
