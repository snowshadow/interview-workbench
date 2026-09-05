import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { FileText, Highlighter, Maximize2, Minimize2, RefreshCw, Search, StickyNote, X, ZoomIn, ZoomOut } from "lucide-react";
import { PanelTitle } from "../WorkbenchPrimitives.jsx";
import { ResumeDocument } from "./ResumeDocument.jsx";
import { AnnotationPopover } from "./AnnotationPopover.jsx";
import { formatFileSize, isPdfFile, isWordFile } from "../../lib/resume-files.js";
import { annotationPlacement, orderedNotes } from "../../lib/resume-annotations.js";
import { safeId } from "../../lib/store-normalize.js";
import "./annotations.css";

export function ResumePane({ file, notes, previewError, replacing, canReplace, onReplace, onUpsertNote, onDeleteNote, onRetryNotes, saveState = "saved" }) {
  const [zoom, setZoom] = useState(1);
  const [focused, setFocused] = useState(false);
  const [markMode, setMarkMode] = useState(false);
  const [overview, setOverview] = useState(false);
  const [query, setQuery] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  const [draft, setDraft] = useState(null);
  const [selection, setSelection] = useState(null);
  const [active, setActive] = useState(null);
  const [undo, setUndo] = useState(null);
  const [placement, setPlacement] = useState(null);
  const rootRef = useRef(null);
  const surfaceRef = useRef(null);
  const scrollerRef = useRef(null);
  const cardRef = useRef(null);
  const fileRef = useRef(null);
  const overviewButtonRef = useRef(null);
  const hoverTimer = useRef(null);
  const sorted = orderedNotes(notes);
  const activeNote = active ? notes.find((note) => note.id === active.id) || (draft?.id === active.id ? draft : null) : null;
  const canMark = Boolean(file && (isPdfFile(file) || (isWordFile(file) && file.previewText)));

  function cancelHover() { window.clearTimeout(hoverTimer.current); }
  function dismiss() { cancelHover(); setActive(null); setDraft(null); setSelection(null); }
  function pin(note, locate = false) {
    cancelHover(); setOverview(false); setSelection(null); setActive({ id: note.id, pinned: true });
    if (locate) requestAnimationFrame(() => {
      const marker = [...scrollerRef.current.querySelectorAll("[data-resume-note-id]")].find((el) => el.dataset.resumeNoteId === note.id);
      marker?.scrollIntoView({ block: "center", inline: "nearest", behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "instant" : "smooth" });
    });
  }
  function preview(note) {
    cancelHover(); if (active?.pinned || overview || markMode) return;
    hoverTimer.current = window.setTimeout(() => setActive((current) => current?.pinned ? current : { id: note.id, pinned: false }), 180);
  }
  function leave() {
    cancelHover(); hoverTimer.current = window.setTimeout(() => setActive((current) => current?.pinned ? current : null), 300);
  }
  function createDraft(anchor) {
    cancelHover(); const next = { ...anchor, id: safeId(), text: "" };
    setDraft(next); setSelection(null); setOverview(false); setActive({ id: next.id, pinned: true }); setMarkMode(false);
    window.getSelection()?.removeAllRanges();
  }
  function selectText(anchor) {
    if (markMode) createDraft(anchor);
    else { dismiss(); setSelection(anchor); }
  }

  useEffect(() => () => window.clearTimeout(hoverTimer.current), []);
  useEffect(() => {
    function escape(event) {
      if (event.key !== "Escape" || event.defaultPrevented || event.isComposing) return;
      if (overview) { setOverview(false); overviewButtonRef.current?.focus(); }
      else if (active || selection || markMode) { dismiss(); setMarkMode(false); window.getSelection()?.removeAllRanges(); }
      else setFocused(false);
    }
    function outside(event) {
      if (event.target.closest(".annotations-overview, .annotation-pane .panel-title, .pane-splitter, .annotation-floating, .annotation-marker, .annotation-selection-action")) return;
      setOverview(false); dismiss();
    }
    window.addEventListener("keydown", escape);
    document.addEventListener("pointerdown", outside);
    return () => { window.removeEventListener("keydown", escape); document.removeEventListener("pointerdown", outside); };
  }, [active, selection, overview, markMode]);

  useLayoutEffect(() => {
    if (!activeNote && !selection) { setPlacement(null); return; }
    const surface = surfaceRef.current;
    const scroller = scrollerRef.current;
    let frame = 0;
    function measure() {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const bounds = surface.getBoundingClientRect();
        const note = activeNote || selection;
        let box;
        if (activeNote) {
          const marker = [...scroller.querySelectorAll("[data-resume-note-id]")].find((el) => el.dataset.resumeNoteId === note.id);
          if (!marker) { setPlacement(null); return; }
          box = marker.getBoundingClientRect();
          if (note.rects?.length) {
            const layer = marker.closest(".annotation-layer").getBoundingClientRect();
            box = { left: layer.left + Math.min(...note.rects.map(r => r.x)) * layer.width,
              right: layer.left + Math.max(...note.rects.map(r => r.x + r.width)) * layer.width,
              top: layer.top + Math.min(...note.rects.map(r => r.y)) * layer.height,
              bottom: layer.top + Math.max(...note.rects.map(r => r.y + r.height)) * layer.height };
          }
        } else {
          const selected = window.getSelection();
          if (!selected?.rangeCount || selected.isCollapsed) { setPlacement(null); return; }
          box = selected.getRangeAt(0).getBoundingClientRect();
        }
        const relative = { left: box.left - bounds.left, right: box.right - bounds.left, top: box.top - bounds.top, bottom: box.bottom - bounds.top };
        const size = cardRef.current ? { width: 288, height: cardRef.current.offsetHeight } : { width: selection ? 132 : 288, height: selection ? 38 : 170 };
        setPlacement(annotationPlacement(relative, bounds, size));
      });
    }
    const observer = new ResizeObserver(measure);
    observer.observe(surface); observer.observe(scroller.firstElementChild || scroller);
    if (cardRef.current) observer.observe(cardRef.current);
    scroller.addEventListener("scroll", measure, { passive: true });
    window.addEventListener("resize", measure);
    measure();
    return () => { cancelAnimationFrame(frame); observer.disconnect(); scroller.removeEventListener("scroll", measure); window.removeEventListener("resize", measure); };
  }, [activeNote, selection, zoom, focused]);

  const search = query.trim().toLocaleLowerCase();
  const filtered = sorted.filter((note) => `${note.text} ${note.quote || ""}`.toLocaleLowerCase().includes(search));
  return <section ref={rootRef} className={`resume-pane pane annotation-pane ${focused ? "resume-focus-mode" : ""}`}>
    <PanelTitle icon={<FileText size={18} />} title="简历">
      <input type="file" className="file-input" ref={fileRef} accept=".pdf,.doc,.docx" onChange={onReplace} />
      <button className="resume-replace-action" disabled={!canReplace || replacing || saveState === "saving"} onClick={() => fileRef.current?.click()} title={file ? "更换当前简历附件" : "添加简历附件"}>
        <RefreshCw size={15} /><span className="tool-label">{replacing ? "处理中" : file ? "更换" : "添加"}</span>
      </button>
      <button className={`resume-mark-action ${markMode ? "active" : ""}`} aria-label="标记原文" aria-pressed={markMode} disabled={!canMark}
        title="选中原文或点击位置添加标注" onClick={() => { dismiss(); setOverview(false); setMarkMode(!markMode); }}>
        <Highlighter size={16} /><span className="tool-label">{markMode ? "标记中" : "标记"}</span>
      </button>
      <button ref={overviewButtonRef} className={`notes-toggle ${overview ? "selected-control" : ""}`} disabled={!file}
        aria-label="全部标注" aria-expanded={overview} aria-controls="annotations-overview" onClick={() => { dismiss(); setQuery(""); setSearchOpen(false); setOverview(!overview); }}>
        <StickyNote size={16} /><span className="tool-label">全部标注</span><span className="control-badge">{notes.length}</span>
      </button>
      <span className="toolbar-separator" />
      <button className="icon-button" aria-label="缩小简历" disabled={!file || zoom <= .5} onClick={() => setZoom(value => Math.max(.5, +(value - .1).toFixed(1)))}><ZoomOut size={16} /></button>
      <button className="zoom-value" title="恢复适合宽度" disabled={!file} onClick={() => setZoom(1)}>{Math.round(zoom * 100)}%</button>
      <button className="icon-button" aria-label="放大简历" disabled={!file || zoom >= 2} onClick={() => setZoom(value => Math.min(2, +(value + .1).toFixed(1)))}><ZoomIn size={16} /></button>
      <button className="icon-button" aria-label={focused ? "退出简历专注模式" : "最大化简历"} disabled={!file} onClick={() => setFocused(!focused)}>{focused ? <Minimize2 size={16} /> : <Maximize2 size={16} />}</button>
    </PanelTitle>
    {file && <div className="resume-filebar"><span>{file.name}</span><span>{formatFileSize(file.size)}</span></div>}
    <div className="resume-preview-surface" ref={surfaceRef}>
      <div className="resume-preview-scroller" ref={scrollerRef}>
        {file ? <ResumeDocument file={file} previewError={previewError} zoom={zoom} markMode={markMode} notes={sorted} noteDraft={draft}
          selectedNoteId={active?.id} onMark={createDraft} onSelectText={selectText} onPreviewNote={preview} onLeaveNote={leave} onFocusNote={pin} /> :
          <div className="resume-empty"><FileText size={30} /><p>添加 PDF 或 Word 简历后，即可标注原文。</p></div>}
      </div>
      {activeNote && <div ref={cardRef} className="annotation-floating" role="dialog" aria-label="原文批注"
        onPointerEnter={cancelHover} onPointerLeave={leave}
        style={{ left: placement?.x || 12, top: placement?.y || 12, width: placement?.width || 288, maxHeight: placement?.maxHeight,
          visibility: placement?.visible ? "visible" : "hidden" }}>
        <AnnotationPopover key={activeNote.id} note={activeNote} number={sorted.findIndex(note => note.id === activeNote.id) + 1}
          isDraft={!notes.some(note => note.id === activeNote.id)} saveState={saveState} onChange={onUpsertNote} onClose={dismiss}
          onPin={() => setActive(current => current ? { ...current, pinned: true } : current)} onRetry={onRetryNotes}
          onDelete={(note) => { onDeleteNote(note.id); setUndo(note); dismiss(); }} />
      </div>}
      {selection && placement?.visible && <button className="annotation-selection-action" style={{ left: placement.x, top: placement.y }}
        onPointerDown={event => event.preventDefault()} onClick={() => createDraft(selection)}><Highlighter size={15} />添加标注</button>}
      {markMode && <div className="annotation-mode-hint"><Highlighter size={14} />选中文字，或点击位置标注<button onClick={() => setMarkMode(false)}>退出 <kbd>Esc</kbd></button></div>}
      {saveState === "error" ? <div className="annotation-undo" role="status">标注未保存<button onClick={onRetryNotes}>重试保存</button></div> :
        undo && <div className="annotation-undo" role="status">已删除标注<button onClick={() => { onUpsertNote(undo); setUndo(null); }}>撤销</button><button className="icon-button" aria-label="关闭撤销提示" onClick={() => setUndo(null)}><X size={13} /></button></div>}
    </div>
    {overview && <div className="annotations-overview" id="annotations-overview" role="dialog" aria-label="全部标注总览">
      <div className="annotations-overview-head"><strong>全部标注 <span>{notes.length}</span><small>{saveState === "saving" ? "保存中…" : saveState === "error" ? "有修改未保存" : ""}</small></strong><div>
        {notes.length > 0 && <button className="icon-button" aria-label="查找标注" aria-expanded={searchOpen} onClick={() => { setSearchOpen(!searchOpen); setQuery(""); }}><Search size={15} /></button>}
        <button className="icon-button" aria-label="关闭标注总览" onClick={() => { setOverview(false); overviewButtonRef.current?.focus(); }}><X size={16} /></button></div></div>
      {searchOpen && <label className="annotations-search"><Search size={15} /><input autoFocus aria-label="搜索标注" placeholder="搜索标注或原文" value={query} onChange={event => setQuery(event.target.value)} /></label>}
      <div className="annotations-overview-list">
        {filtered.map(note => <button className="annotation-overview-row" key={note.id} onClick={() => pin(note, true)}>
          <span className="annotation-number">{String(sorted.indexOf(note) + 1).padStart(2, "0")}</span>
          <span className="annotation-overview-body"><span>{note.text}</span><small>{note.quote ? `“${note.quote}”` : "位置标注 · 点击查看"}</small></span>
          {note.pageNumber && <span className="annotation-page">第 {note.pageNumber} 页</span>}
        </button>)}
        {!filtered.length && <div className="annotations-empty">{notes.length ? "没有匹配的标注" : "还没有标注"}<p>{notes.length ? "试试其他关键词" : "选中一段原文，记下想追问的问题。"}</p></div>}
      </div>
      <div className="annotations-overview-footer">点击标注，回到原文位置</div>
    </div>}
  </section>;
}
