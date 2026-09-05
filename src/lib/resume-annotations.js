const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

export function orderedNotes(notes) {
  return [...notes].sort((a, b) => (a.pageNumber || 1) - (b.pageNumber || 1) || a.y - b.y || a.x - b.x);
}

export function noteLocation(note) {
  const page = note.coordinateMode === "page" ? `第 ${note.pageNumber || 1} 页` : "简历原文";
  return `${page} · ${note.quote ? "原文高亮" : "位置标注"}`;
}

export function upsertNote(notes, note) {
  const text = note.text.trim();
  if (!text) return notes;
  const existing = notes.find((item) => item.id === note.id);
  const next = { ...existing, ...note, text, createdAt: existing?.createdAt || note.createdAt || new Date().toISOString() };
  return existing ? notes.map((item) => item.id === note.id ? next : item) : [...notes, next];
}

// Store rectangles relative to the original page, so resizing never changes their attachment.
export function normalizeSelectionRects(rects, page) {
  if (!page.width || !page.height) return [];
  const normalized = [];
  for (const rect of rects) {
    const left = clamp(rect.left, page.left, page.right);
    const top = clamp(rect.top, page.top, page.bottom);
    const right = clamp(rect.right, page.left, page.right);
    const bottom = clamp(rect.bottom, page.top, page.bottom);
    if (right - left < 1 || bottom - top < 1) continue;
    const item = { x: (left - page.left) / page.width, y: (top - page.top) / page.height,
      width: (right - left) / page.width, height: (bottom - top) / page.height };
    const previous = normalized.at(-1);
    if (previous && Math.abs(previous.y - item.y) * page.height < 2 &&
      Math.abs(previous.height - item.height) * page.height < 3 &&
      item.x >= previous.x && (item.x - previous.x - previous.width) * page.width < 5) {
      previous.width = Math.max(previous.width, item.x + item.width - previous.x);
    } else normalized.push(item);
  }
  return normalized.slice(0, 300);
}

export function readTextAnchor(root, coordinateMode, pageNumber) {
  const selection = window.getSelection();
  if (!selection?.rangeCount || selection.isCollapsed || !selection.toString().trim()) return null;
  const range = selection.getRangeAt(0);
  const textRoot = root.querySelector(".pdf-text-layer, pre");
  if (!textRoot?.contains(range.startContainer) || !textRoot.contains(range.endContainer)) return null;
  const rects = normalizeSelectionRects([...range.getClientRects()], root.getBoundingClientRect());
  if (!rects.length) return null;
  const last = rects.at(-1);
  return { coordinateMode, pageNumber, rects, quote: selection.toString().trim().slice(0, 4000),
    x: Math.min(.98, last.x + last.width), y: last.y + last.height / 2 };
}

export function handleDocumentPointerUp(event, markerProps, coordinateMode, pageNumber = null) {
  if (event.button !== 0 || event.target.closest("button, input, textarea")) return;
  const root = event.currentTarget;
  const anchor = readTextAnchor(root, coordinateMode, pageNumber);
  if (anchor) { markerProps.onSelectText(anchor); return; }
  if (!markerProps.markMode || window.getSelection()?.toString().trim()) return;
  const rect = root.getBoundingClientRect();
  markerProps.onMark({ coordinateMode, pageNumber,
    x: clamp((event.clientX - rect.left) / rect.width, .015, .985),
    y: clamp((event.clientY - rect.top) / rect.height, .015, .985) });
}

export function annotationPlacement(anchor, viewport, size) {
  const padding = 12;
  const width = Math.min(size.width || 288, Math.max(0, viewport.width - padding * 2));
  const height = Math.min(size.height || 170, Math.max(0, viewport.height - padding * 2));
  const x = clamp(anchor.right - width, padding, Math.max(padding, viewport.width - width - padding));
  const below = anchor.bottom + 14;
  const above = anchor.top - height - 14;
  const y = below + height <= viewport.height - padding ? below : above >= padding ? above :
    clamp(below, padding, Math.max(padding, viewport.height - height - padding));
  return { x, y, width, maxHeight: viewport.height - padding * 2,
    visible: anchor.bottom >= 0 && anchor.top <= viewport.height && anchor.right >= 0 && anchor.left <= viewport.width };
}

// Serialize writes for one application: an older save must never overwrite newer typing.
export function enqueueApplicationSave(queues, id, save) {
  const task = (queues.get(id) || Promise.resolve()).catch(() => {}).then(save);
  queues.set(id, task);
  task.finally(() => { if (queues.get(id) === task) queues.delete(id); }).catch(() => {});
  return task;
}

export function preservePendingAnnotations(remote, local, pendingIds) {
  if (!remote || !pendingIds.size) return remote;
  const pending = new Map(local.applications.filter(app => pendingIds.has(app.id))
    .map(app => [app.id, app.resumeNotes]));
  return {
    ...remote,
    applications: remote.applications.map(app => pending.has(app.id) ? { ...app, resumeNotes: pending.get(app.id) } : app),
    interviews: remote.interviews.map(round => pending.has(round.applicationId)
      ? { ...round, resumeNotes: pending.get(round.applicationId) } : round),
  };
}
