import { loadSavedTheme, saveThemePreference } from "../state/storage.js";

export function openHelpDialog() {
  const dialog = document.getElementById("help-dialog");
  if (dialog && !dialog.open) {
    dialog.showModal();
  }
}

export function initModalsAndTheme() {
  const helpDialog = document.getElementById("help-dialog");
  const openHelpBtn = document.getElementById("open-help-btn");

  if (openHelpBtn) {
    openHelpBtn.addEventListener("click", () => openHelpDialog());
  }

  // Light-dismiss fallback where native `<dialog closedby>` is unsupported
  if (helpDialog && !("closedBy" in HTMLDialogElement.prototype)) {
    helpDialog.addEventListener("click", (event) => {
      if (event.target !== helpDialog) return;
      const rect = helpDialog.getBoundingClientRect();
      const isDialogContent =
        rect.top <= event.clientY &&
        event.clientY <= rect.top + rect.height &&
        rect.left <= event.clientX &&
        event.clientX <= rect.left + rect.width;
      if (!isDialogContent) helpDialog.close();
    });
  }

  // Theme initialization & toggle
  const themeBtn = document.getElementById("theme-toggle");
  const saved = loadSavedTheme();
  const prefersLight =
    window.matchMedia &&
    window.matchMedia("(prefers-color-scheme: light)").matches;
  const initialTheme = saved || (prefersLight ? "light" : "dark");

  const applyTheme = (theme) => {
    document.documentElement.setAttribute("data-theme", theme);
    if (themeBtn) {
      themeBtn.textContent = theme === "dark" ? "☀️ Claro" : "🌙 Oscuro";
    }
    saveThemePreference(theme);
  };

  applyTheme(initialTheme);

  if (themeBtn) {
    themeBtn.addEventListener("click", () => {
      const current =
        document.documentElement.getAttribute("data-theme") || "dark";
      applyTheme(current === "dark" ? "light" : "dark");
    });
  }
}
