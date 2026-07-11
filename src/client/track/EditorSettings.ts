// Persisted editor preferences (device-local, not per-track). Extend
// EditorSettings/DEFAULTS as new options are added — getEditorSettings()
// merges over defaults so old localStorage payloads stay valid.

export type PropsBarLayout = 'scroll' | 'wrap';

export type EditorSettings = {
  propsBarLayout: PropsBarLayout;
  // When true, every group shows a dashed bounding rectangle at all times,
  // not just while selected (the per-piece marching-ants highlight on
  // selection is unaffected by this setting either way).
  showGroupOutlines: boolean;
};

const KEY = 'dv-editor-settings';

const DEFAULTS: EditorSettings = {
  propsBarLayout: 'scroll',
  showGroupOutlines: true,
};

export function getEditorSettings(): EditorSettings {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return { ...DEFAULTS };
    return { ...DEFAULTS, ...(JSON.parse(raw) as Partial<EditorSettings>) };
  } catch {
    return { ...DEFAULTS };
  }
}

export function setEditorSettings(patch: Partial<EditorSettings>): EditorSettings {
  const merged = { ...getEditorSettings(), ...patch };
  try { localStorage.setItem(KEY, JSON.stringify(merged)); } catch { /* quota exceeded — in-memory value still applies this session */ }
  return merged;
}
