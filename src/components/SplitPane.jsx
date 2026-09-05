import { useEffect, useRef, useState } from "react";
import { readUiPreferences, saveUiPreferences } from "../lib/ui-preferences.js";
import { SPLITTER_SIZE, constrainSplit, normalizeSplit, splitBounds, splitForKey } from "../lib/split-layout.js";

// Each boundary has its own size preference and pointer/keyboard controls.
export function SplitPane({
  id, label, children, className = "", direction = "horizontal", stackAt = 0,
  defaultSize = 60, minPrimary = 240, minSecondary = 220, collapsed = "",
  preferenceKey = id,
}) {
  const rootRef = useRef(null);
  const handleRef = useRef(null);
  const dragRef = useRef(null);
  const frameRef = useRef(0);
  const cleanupRef = useRef(null);
  const [initialSize] = useState(() => normalizeSplit(readUiPreferences()[preferenceKey], defaultSize));
  const requestedRef = useRef(initialSize);
  const currentRef = useRef(initialSize);
  const geometryRef = useRef({ direction, available: 1, bounds: { min: 0, max: 100 } });
  const [primary, secondary] = children;

  function applySize(value) {
    const root = rootRef.current;
    const handle = handleRef.current;
    if (!root || !handle) return;
    const { bounds } = geometryRef.current;
    const next = constrainSplit(value, bounds);
    currentRef.current = next;
    root.style.setProperty("--split-primary", `${next}fr`);
    root.style.setProperty("--split-secondary", `${100 - next}fr`);
    handle.setAttribute("aria-valuenow", String(Math.round(next)));
    handle.setAttribute("aria-valuemin", String(Math.round(bounds.min)));
    handle.setAttribute("aria-valuemax", String(Math.round(bounds.max)));
    handle.setAttribute("aria-valuetext", `前一区域 ${Math.round(next)}%`);
  }

  function commitSize(value) {
    requestedRef.current = value;
    applySize(value);
    saveUiPreferences({ [preferenceKey]: value });
  }

  useEffect(() => {
    const root = rootRef.current;
    function measure() {
      const actualDirection = stackAt && root.clientWidth < stackAt ? "vertical" : direction;
      const previous = geometryRef.current;
      const available = Math.max(1,
        (actualDirection === "horizontal" ? root.clientWidth : root.clientHeight) - SPLITTER_SIZE);
      if (dragRef.current && (previous.direction !== actualDirection || previous.available !== available)) {
        cleanupRef.current?.(true);
      }
      geometryRef.current = { direction: actualDirection, available, bounds: splitBounds(available, minPrimary, minSecondary) };
      root.dataset.direction = actualDirection;
      handleRef.current?.setAttribute("aria-orientation", actualDirection === "horizontal" ? "vertical" : "horizontal");
      applySize(requestedRef.current);
    }
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(root);
    return () => {
      cleanupRef.current?.(true);
      cancelAnimationFrame(frameRef.current);
      observer.disconnect();
    };
  }, [direction, stackAt, minPrimary, minSecondary, collapsed]);

  function startDrag(event) {
    if (event.button !== 0 || !event.isPrimary || collapsed) return;
    event.preventDefault();
    const handle = event.currentTarget;
    handle.focus({ preventScroll: true });
    handle.setPointerCapture(event.pointerId);
    const { direction: axis, available } = geometryRef.current;
    const coordinate = (e) => axis === "horizontal" ? e.clientX : e.clientY;
    const start = coordinate(event);
    const startSize = currentRef.current;
    let latest = startSize;
    dragRef.current = { pointerId: event.pointerId };
    rootRef.current.dataset.resizing = "true";
    document.body.dataset.resizeDirection = axis;

    function move(e) {
      if (e.pointerId !== event.pointerId) return;
      latest = startSize + (coordinate(e) - start) / available * 100;
      cancelAnimationFrame(frameRef.current);
      frameRef.current = requestAnimationFrame(() => applySize(latest));
    }
    function finish(cancelled = false) {
      if (!dragRef.current) return;
      cancelAnimationFrame(frameRef.current);
      dragRef.current = null;
      delete rootRef.current?.dataset.resizing;
      delete document.body.dataset.resizeDirection;
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", up);
      handle.removeEventListener("pointercancel", cancel);
      handle.removeEventListener("lostpointercapture", cancel);
      window.removeEventListener("blur", cancel);
      window.removeEventListener("keydown", escape);
      if (handle.hasPointerCapture(event.pointerId)) handle.releasePointerCapture(event.pointerId);
      if (cancelled) applySize(requestedRef.current);
      else commitSize(constrainSplit(latest, geometryRef.current.bounds));
      cleanupRef.current = null;
    }
    function up(e) {
      if (e.pointerId !== event.pointerId) return;
      latest = startSize + (coordinate(e) - start) / available * 100;
      finish();
    }
    function cancel() { finish(true); }
    function escape(e) {
      if (e.key === "Escape") { e.preventDefault(); finish(true); }
    }
    cleanupRef.current = finish;
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", up);
    handle.addEventListener("pointercancel", cancel);
    handle.addEventListener("lostpointercapture", cancel);
    window.addEventListener("blur", cancel);
    window.addEventListener("keydown", escape);
  }

  return (
    <div className={`split-pane ${className}`} ref={rootRef} data-direction={direction}
      data-collapsed={collapsed || undefined} id={id}
      style={{ "--split-primary": `${initialSize}fr`, "--split-secondary": `${100 - initialSize}fr` }}>
      <div className="split-panel min-h-0 min-w-0" id={`${id}-primary`} hidden={collapsed === "primary"}>{primary}</div>
      <div className="pane-splitter" ref={handleRef} role="separator" tabIndex={collapsed ? -1 : 0}
        hidden={Boolean(collapsed)} aria-label={label} aria-controls={`${id}-primary`}
        aria-orientation={direction === "horizontal" ? "vertical" : "horizontal"}
        aria-valuenow={Math.round(initialSize)} aria-valuemin={0} aria-valuemax={100}
        title={`${label}；双击复位，方向键微调`} onPointerDown={startDrag}
        onDoubleClick={() => commitSize(defaultSize)}
        onKeyDown={(event) => {
          const { direction: axis, bounds } = geometryRef.current;
          const next = splitForKey(event.key, axis, currentRef.current, bounds, defaultSize, event.shiftKey ? 10 : 2);
          if (next !== null) { event.preventDefault(); commitSize(next); }
        }}><span /></div>
      <div className="split-panel min-h-0 min-w-0" id={`${id}-secondary`} hidden={collapsed === "secondary"}>{secondary}</div>
    </div>
  );
}
