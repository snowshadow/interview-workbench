import { StickyNote } from "lucide-react";

export function ResumeMarkerLayer({
  coordinateMode,
  markMode,
  noteDraft,
  notes,
  onCancelDraft,
  onDraftChange,
  onFocusNote,
  onMark,
  onSaveDraft,
  pageNumber = null,
  selectedNoteId,
}) {
  const layerNotes = notes.filter((note) => {
    const noteMode = note.coordinateMode || "content";
    if (noteMode !== coordinateMode) return false;
    return coordinateMode !== "page" || Number(note.pageNumber) === Number(pageNumber);
  });
  const draftVisible =
    noteDraft?.coordinateMode === coordinateMode &&
    (coordinateMode !== "page" || Number(noteDraft.pageNumber) === Number(pageNumber));

  return (
    <div
      className={`resume-mark-layer ${markMode ? "marking" : ""}`}
      onClick={(event) =>
        onMark(event, {
          coordinateMode,
          pageNumber,
        })
      }
    >
      {layerNotes.map((note) => (
        <button
          type="button"
          className={`resume-note-marker ${selectedNoteId === note.id ? "selected" : ""}`}
          data-resume-note-id={note.id}
          key={note.id}
          style={{ left: `${note.x * 100}%`, top: `${note.y * 100}%` }}
          title={note.text}
          onClick={(event) => {
            event.stopPropagation();
            onFocusNote(note);
          }}
        >
          <StickyNote size={13} />
        </button>
      ))}

      {draftVisible ? (
        <div
          className="note-popover"
          style={{
            left: `clamp(128px, ${noteDraft.x * 100}%, calc(100% - 128px))`,
            top: `clamp(8px, ${noteDraft.y * 100}%, calc(100% - 126px))`,
          }}
          onClick={(event) => event.stopPropagation()}
        >
          <textarea
            autoFocus
            value={noteDraft.text}
            onChange={(event) => onDraftChange(event.target.value)}
            placeholder="写一句关键词备注"
          />
          <div className="note-actions">
            <button type="button" className="primary" onClick={onSaveDraft}>
              保存
            </button>
            <button type="button" onClick={onCancelDraft}>
              取消
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
