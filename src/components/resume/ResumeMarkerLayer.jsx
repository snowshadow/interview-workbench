import { StickyNote } from "lucide-react";

function belongsToLayer(note, coordinateMode, pageNumber) {
  const noteMode = note?.coordinateMode || "content";
  if (noteMode !== coordinateMode) return false;
  return coordinateMode !== "page" || Number(note.pageNumber) === Number(pageNumber);
}

function popoverPosition(anchor) {
  return {
    left: `clamp(128px, ${anchor.x * 100}%, calc(100% - 128px))`,
    top: `clamp(8px, ${anchor.y * 100}%, calc(100% - 126px))`,
  };
}

export function ResumeMarkerLayer({
  coordinateMode,
  markMode,
  noteDraft,
  noteEditor,
  notes,
  onCancelDraft,
  onCloseEditor,
  onDeleteNote,
  onDraftChange,
  onEditorChange,
  onFocusNote,
  onMark,
  onSaveDraft,
  onSaveEditor,
  pageNumber = null,
  selectedNoteId,
}) {
  const layerNotes = notes.filter((note) => belongsToLayer(note, coordinateMode, pageNumber));
  const draftVisible = noteDraft ? belongsToLayer(noteDraft, coordinateMode, pageNumber) : false;
  const editorVisible =
    !draftVisible && noteEditor ? belongsToLayer(noteEditor, coordinateMode, pageNumber) : false;

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
          style={popoverPosition(noteDraft)}
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

      {editorVisible ? (
        <div
          className="note-popover"
          style={popoverPosition(noteEditor)}
          onClick={(event) => event.stopPropagation()}
        >
          <textarea
            autoFocus
            value={noteEditor.text}
            onChange={(event) => onEditorChange(event.target.value)}
            placeholder="写一句关键词备注"
          />
          <div className="note-actions">
            <button type="button" className="primary" onClick={onSaveEditor}>
              保存
            </button>
            <button type="button" className="danger" onClick={() => onDeleteNote(noteEditor.id)}>
              删除
            </button>
            <button type="button" onClick={onCloseEditor}>
              关闭
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
