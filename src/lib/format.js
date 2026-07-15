export function clampNumber(value, min, max) {
  return Math.min(max, Math.max(min, value));
}
