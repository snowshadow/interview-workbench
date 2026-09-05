export const SPLITTER_SIZE = 12;

export function normalizeSplit(value, fallback = 60) {
  return typeof value === "number" && Number.isFinite(value) && value > 0 && value < 100
    ? value
    : fallback;
}

export function splitBounds(available, minPrimary, minSecondary) {
  if (available <= 0) return { min: 0, max: 100 };
  const scale = Math.min(1, available / (minPrimary + minSecondary));
  const min = (minPrimary * scale / available) * 100;
  return { min, max: Math.max(min, 100 - (minSecondary * scale / available) * 100) };
}

export function constrainSplit(value, bounds) {
  return Math.min(bounds.max, Math.max(bounds.min, value));
}

export function splitForKey(key, direction, current, bounds, defaultSize, step = 2) {
  const backward = direction === "horizontal" ? "ArrowLeft" : "ArrowUp";
  const forward = direction === "horizontal" ? "ArrowRight" : "ArrowDown";
  if (key === backward) return constrainSplit(current - step, bounds);
  if (key === forward) return constrainSplit(current + step, bounds);
  if (key === "Home") return bounds.min;
  if (key === "End") return bounds.max;
  if (key === "Enter") return constrainSplit(defaultSize, bounds);
  return null;
}
