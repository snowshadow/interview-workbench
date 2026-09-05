import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Check, Plus, X } from "lucide-react";
import { DEFAULT_APPLICATION_STATUS, STATUS_COLOR_OPTIONS, interviewStatusTone, statusColorFor } from "../interview-domain.js";

export function ApplicationStatusPicker({ value, options, colors, disabled, open, onOpenChange, draft, onDraftChange, onSelect, onColorChange }) {
  const triggerRef = useRef(null);
  const popoverRef = useRef(null);
  const focusedOnOpen = useRef(false);
  const [position, setPosition] = useState(null);
  const popoverId = useId();

  function close() {
    onOpenChange(false);
    triggerRef.current?.focus({ preventScroll: true });
  }

  useLayoutEffect(() => {
    if (!open) { setPosition(null); focusedOnOpen.current = false; return; }
    let frame = 0;
    function measure() {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const anchor = triggerRef.current.getBoundingClientRect();
        const popup = popoverRef.current.getBoundingClientRect();
        const left = Math.max(12, Math.min(anchor.left, window.innerWidth - popup.width - 12));
        const below = anchor.bottom + 8;
        const above = anchor.top - popup.height - 8;
        const top = below + popup.height <= window.innerHeight - 12 ? below : above >= 12 ? above :
          Math.max(12, window.innerHeight - popup.height - 12);
        setPosition({ left, top });
      });
    }
    const observer = new ResizeObserver(measure);
    observer.observe(triggerRef.current);
    observer.observe(popoverRef.current);
    window.addEventListener("resize", measure);
    window.addEventListener("scroll", measure, true);
    measure();
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      window.removeEventListener("resize", measure);
      window.removeEventListener("scroll", measure, true);
    };
  }, [open]);

  useEffect(() => {
    if (!open || !position || focusedOnOpen.current) return;
    focusedOnOpen.current = true;
    const option = popoverRef.current.querySelector('[aria-checked="true"]') || popoverRef.current.querySelector('[role="menuitemradio"]');
    option?.focus({ preventScroll: true });
    option?.scrollIntoView({ block: "nearest" });
  }, [open, position]);

  useEffect(() => {
    if (!open) return;
    function outside(event) {
      if (!popoverRef.current?.contains(event.target) && !triggerRef.current?.contains(event.target)) onOpenChange(false);
    }
    function escape(event) {
      if (event.key === "Escape" && !event.isComposing) {
        event.preventDefault();
        onOpenChange(false);
        triggerRef.current?.focus({ preventScroll: true });
      }
    }
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("keydown", escape);
    };
  }, [open, onOpenChange]);

  function navigateOptions(event) {
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const items = [...event.currentTarget.querySelectorAll('[role="menuitemradio"]')];
    const current = items.indexOf(document.activeElement);
    const next = event.key === "Home" ? 0 : event.key === "End" ? items.length - 1 :
      (current + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
    items[next]?.focus();
  }

  return <div className="status-picker">
    <button ref={triggerRef} className={`session-status status-picker-trigger ${interviewStatusTone(value, colors)}`}
      disabled={disabled} aria-expanded={open} aria-controls={open ? popoverId : undefined} aria-haspopup="dialog"
      onClick={() => onOpenChange(!open)} title="修改应聘流程状态">
      {value || DEFAULT_APPLICATION_STATUS}
    </button>
    {open && createPortal(<div ref={popoverRef} id={popoverId} className="status-picker-popover" role="dialog" aria-label="应聘流程状态"
      style={{ left: position?.left || 12, top: position?.top || 12, visibility: position ? "visible" : "hidden" }}>
      <div className="status-picker-heading"><strong>应聘流程状态</strong><button className="icon-button" aria-label="关闭状态选择" onClick={close}><X size={15} /></button></div>
      <div className="status-picker-options" role="menu" aria-label="可选流程状态" onKeyDown={navigateOptions}>
        {options.map((option) => <button type="button" role="menuitemradio" aria-checked={option === value}
          className={`status-picker-option ${option === value ? "selected" : ""}`} key={option}
          onClick={() => { onSelect(option); triggerRef.current?.focus({ preventScroll: true }); }}>
          <span className={`session-status ${interviewStatusTone(option, colors)}`}>{option}</span>
          <Check size={14} className="status-option-check" aria-hidden="true" />
        </button>)}
      </div>
      <form className="status-picker-custom" onSubmit={(event) => { event.preventDefault(); onSelect(draft, { keepPickerOpen: true }); }}>
        <label htmlFor={`${popoverId}-custom`}>自定义状态</label>
        <div><input id={`${popoverId}-custom`} aria-label="自定义流程状态" maxLength={24} placeholder="输入新状态" value={draft}
          onChange={(event) => onDraftChange(event.target.value)} />
          <button aria-label="添加自定义流程状态" className="icon-button" disabled={!draft.trim()} title="添加并使用" type="submit"><Plus size={15} /></button></div>
      </form>
      <div className="status-color-field"><span>标签颜色</span><div className="status-color-swatches" role="group" aria-label="标签颜色">
        {STATUS_COLOR_OPTIONS.map((option) => <button aria-label={option.label} aria-pressed={statusColorFor(value, colors) === option.value}
          className={`status-color-swatch color-${option.value}`} key={option.value}
          onClick={() => { onColorChange(option.value); triggerRef.current?.focus({ preventScroll: true }); }} title={option.label} type="button" />)}
      </div></div>
    </div>, document.body)}
  </div>;
}
