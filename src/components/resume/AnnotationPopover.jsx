import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Check, Ellipsis, Pencil, Trash2, X } from "lucide-react";
import { noteLocation } from "../../lib/resume-annotations.js";

export function AnnotationPopover({ note, number, isDraft, saveState, onChange, onClose, onDelete, onPin, onRetry }) {
  const [editing, setEditing] = useState(isDraft);
  const [text, setText] = useState(note.text || "");
  const [menu, setMenu] = useState(false);
  const inputRef = useRef(null);
  const composingRef = useRef(false);
  useEffect(() => { if (!editing) setText(note.text || ""); }, [note.text, editing]);
  useLayoutEffect(() => {
    if (!editing || !inputRef.current) return;
    inputRef.current.style.height = "auto";
    inputRef.current.style.height = `${Math.min(220, Math.max(60, inputRef.current.scrollHeight))}px`;
  }, [text, editing]);
  useEffect(() => {
    if (!editing) return;
    const input = inputRef.current;
    input?.focus({ preventScroll: true });
    input?.setSelectionRange(input.value.length, input.value.length);
  }, [editing]);

  return <div className="annotation-card-content" onPointerDown={onPin} onKeyDown={(event) => {
    if (event.key === "Escape" && !event.nativeEvent.isComposing) { event.stopPropagation(); onClose(); }
  }}>
    <div className="annotation-card-head">
      <span className="annotation-number">{number ? String(number).padStart(2, "0") : "+"}</span>
      <span>{isDraft ? "添加批注" : "原文批注"}</span>
      <div className="annotation-card-actions">
        {!editing && <button className="icon-button" aria-label="编辑标注" title="编辑标注" onClick={() => setEditing(true)}><Pencil size={14} /></button>}
        {!isDraft && <button className="icon-button" aria-label="标注操作" aria-expanded={menu} onClick={() => setMenu(!menu)}><Ellipsis size={16} /></button>}
        <button className="icon-button" aria-label="关闭批注" onClick={onClose}><X size={15} /></button>
      </div>
    </div>
    {menu && <div className="annotation-actions-menu" role="menu">
      <button role="menuitem" onClick={() => { setMenu(false); onDelete(note); }}><Trash2 size={14} />删除标注</button>
    </div>}
    {note.quote && <blockquote className="annotation-quote" title={note.quote}>{note.quote}</blockquote>}
    {editing ? <textarea ref={inputRef} className="annotation-editor" aria-label="标注内容" value={text}
      placeholder="写下想追问的问题…" onChange={(event) => {
        setText(event.target.value);
        if (!composingRef.current && event.target.value.trim()) onChange({ ...note, text: event.target.value });
      }} onCompositionStart={() => { composingRef.current = true; }} onCompositionEnd={(event) => {
        composingRef.current = false;
        if (event.currentTarget.value.trim()) onChange({ ...note, text: event.currentTarget.value });
      }} onBlur={() => { if (text.trim()) setEditing(false); }}
      onKeyDown={(event) => {
        if (event.key === "Enter" && (event.metaKey || event.ctrlKey) && !event.nativeEvent.isComposing) {
          event.preventDefault(); if (text.trim()) setEditing(false);
        }
      }} /> : <button className="annotation-text" title="点击文字直接编辑" onClick={() => setEditing(true)}>{text}</button>}
    <div className="annotation-card-footer">
      <span>{noteLocation(note)}</span>
      <span className={`annotation-save-state ${saveState}`} role="status">
        {!text.trim() ? (isDraft ? "输入后自动保存" : "内容不能为空") : saveState === "error" ?
          <button onClick={onRetry}>保存失败 · 重试</button> : saveState === "saving" ? "保存中…" : <><Check size={12} />已保存</>}
      </span>
    </div>
  </div>;
}
