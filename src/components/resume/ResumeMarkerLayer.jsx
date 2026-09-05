function belongsToLayer(note, coordinateMode, pageNumber) {
  const noteMode = note?.coordinateMode || "content";
  if (noteMode !== coordinateMode) return false;
  return coordinateMode !== "page" || Number(note.pageNumber) === Number(pageNumber);
}

export function ResumeMarkerLayer({
  coordinateMode,
  noteDraft,
  notes,
  onFocusNote,
  onPreviewNote,
  onLeaveNote,
  pageNumber = null,
  selectedNoteId,
}) {
  const visibleNotes = noteDraft && !notes.some((note) => note.id === noteDraft.id) ? [...notes, noteDraft] : notes;
  const layerNotes = visibleNotes.filter((note) => belongsToLayer(note, coordinateMode, pageNumber));
  const noteNumbers = new Map(notes.map((note, index) => [note.id, index + 1]));
  return (
    <div className="annotation-layer">
      {layerNotes.map((note) => (
        <div key={note.id}>
        {(note.rects || []).map((rect, index) => <span key={index}
          className={`annotation-highlight ${selectedNoteId === note.id ? "active" : ""}`}
          style={{ left: `${rect.x * 100}%`, top: `${rect.y * 100}%`, width: `${rect.width * 100}%`, height: `${rect.height * 100}%` }} />)}
        <button
          type="button"
          className={`annotation-marker ${selectedNoteId === note.id ? "selected" : ""}`}
          data-resume-note-id={note.id}
          style={{ left: `${note.x * 100}%`, top: `${note.y * 100}%` }}
          aria-label={`标注 ${noteNumbers.get(note.id) || "新"}：${note.text || "添加批注"}`}
          aria-pressed={selectedNoteId === note.id}
          onPointerEnter={() => onPreviewNote(note)} onPointerLeave={onLeaveNote}
          onFocus={() => onPreviewNote(note)} onBlur={onLeaveNote}
          onClick={(event) => {
            event.stopPropagation();
            onFocusNote(note);
          }}
        >
          {noteNumbers.has(note.id) ? String(noteNumbers.get(note.id)).padStart(2, "0") : "+"}
        </button>
        </div>
      ))}
    </div>
  );
}
