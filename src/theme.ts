// Theme registry and preference handling.
//
// A theme is a palette (a set of CSS custom properties) plus an "appearance"
// (light or dark). The palettes themselves live in styles.css as
// `:root[data-theme="…"]` blocks; this module only knows each theme's id,
// display name, and appearance, and is responsible for choosing which one is
// active by setting `data-theme` on the <html> element.
//
// The persisted preference (localStorage `glance.theme`) is either the literal
// "auto" — follow the OS, resolving to Paper when light and Ink when dark — or a
// concrete theme id. The pure helpers here are DOM-free so they stay unit
// testable; `applyTheme` is the only side-effectful part.

export type Appearance = "light" | "dark";

export interface ThemeMeta {
  id: string;
  name: string;
  appearance: Appearance;
}

// "auto" | <theme id>
export type ThemePref = string;

export const AUTO = "auto";

// Which concrete themes Auto resolves to for each OS appearance.
export const AUTO_LIGHT = "paper";
export const AUTO_DARK = "ink";

// Order here is the order shown in the picker.
export const THEMES: ThemeMeta[] = [
  { id: "paper", name: "Paper", appearance: "light" },
  { id: "solarized-light", name: "Solarized Light", appearance: "light" },
  { id: "ink", name: "Ink", appearance: "dark" },
  { id: "solarized-dark", name: "Solarized Dark", appearance: "dark" },
  { id: "nord", name: "Nord", appearance: "dark" },
  { id: "high-contrast", name: "High Contrast", appearance: "dark" },
];

const LS_THEME = "glance.theme";

export function isThemeId(id: string): boolean {
  return THEMES.some((t) => t.id === id);
}

// Normalize a raw stored value into a valid preference, defaulting to Auto for
// anything unrecognized (including null / a theme id that no longer exists).
export function parsePref(raw: string | null): ThemePref {
  if (raw === AUTO) return AUTO;
  if (raw && isThemeId(raw)) return raw;
  return AUTO;
}

// Resolve a preference to the concrete theme id that should be active.
export function resolveThemeId(pref: ThemePref, prefersDark: boolean): string {
  if (pref === AUTO) return prefersDark ? AUTO_DARK : AUTO_LIGHT;
  return isThemeId(pref) ? pref : AUTO_LIGHT;
}

export function appearanceOf(themeId: string): Appearance {
  return THEMES.find((t) => t.id === themeId)?.appearance ?? "light";
}

// ---- DOM side (not unit tested) -------------------------------------------

export function loadThemePref(): ThemePref {
  try {
    return parsePref(localStorage.getItem(LS_THEME));
  } catch {
    return AUTO;
  }
}

export function saveThemePref(pref: ThemePref): void {
  try {
    localStorage.setItem(LS_THEME, pref);
  } catch {
    /* storage unavailable; theme just won't persist */
  }
}

// The concrete theme id currently applied to the document.
export function currentThemeId(): string {
  return document.documentElement.dataset.theme || AUTO_LIGHT;
}

export function currentAppearance(): Appearance {
  return appearanceOf(currentThemeId());
}

let mql: MediaQueryList | null = null;
let mqlHandler: (() => void) | null = null;

function clearAutoListener(): void {
  if (mql && mqlHandler) mql.removeEventListener("change", mqlHandler);
  mql = null;
  mqlHandler = null;
}

// Apply a preference to the document. In Auto mode we resolve against the OS and
// keep a `matchMedia` listener so a live light/dark switch re-flips the theme;
// `onResolvedChange` fires whenever the concrete theme changes (so callers can,
// e.g., remount the editor with the right dark flag). Explicit themes drop the
// listener.
export function applyTheme(pref: ThemePref, onResolvedChange?: () => void): void {
  clearAutoListener();
  if (pref === AUTO) {
    mql = window.matchMedia("(prefers-color-scheme: dark)");
    const set = () => {
      document.documentElement.dataset.theme = mql!.matches ? AUTO_DARK : AUTO_LIGHT;
    };
    set();
    mqlHandler = () => { set(); onResolvedChange?.(); };
    mql.addEventListener("change", mqlHandler);
  } else {
    document.documentElement.dataset.theme = resolveThemeId(pref, false);
  }
}
