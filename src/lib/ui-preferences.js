export const UI_PREF_KEY = "interview-workbench.ui.v1";

export function readUiPreferences() {
  try {
    const value = JSON.parse(localStorage.getItem(UI_PREF_KEY) || "{}");
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
  } catch {
    return {};
  }
}

export function saveUiPreferences(patch) {
  try {
    localStorage.setItem(UI_PREF_KEY, JSON.stringify({ ...readUiPreferences(), ...patch }));
  } catch {
    // Layout preferences are optional; interview data is stored separately.
  }
}
