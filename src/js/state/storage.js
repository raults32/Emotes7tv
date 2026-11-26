const KEYS = {
  FAVS: "7tv_studio_favs",
  RECENTS: "7tv_studio_recents",
  THEME: "7tv_studio_theme",
};

export function readJsonStorage(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

export function writeJsonStorage(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Ignore storage quota or private mode restrictions
  }
}

export function loadFavorites() {
  return readJsonStorage(KEYS.FAVS, []);
}

export function saveFavorites(list) {
  writeJsonStorage(KEYS.FAVS, list);
}

export function loadRecents() {
  return readJsonStorage(KEYS.RECENTS, []);
}

export function saveRecents(list) {
  writeJsonStorage(KEYS.RECENTS, list);
}

export function loadSavedTheme() {
  try {
    return localStorage.getItem(KEYS.THEME);
  } catch {
    return null;
  }
}

export function saveThemePreference(theme) {
  try {
    localStorage.setItem(KEYS.THEME, theme);
  } catch {
    // Ignore private mode restrictions
  }
}
