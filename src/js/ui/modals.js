import { loadSavedTheme, saveThemePreference } from "../state/storage.js";

export function openDialogById(id) {
  const dialog = document.getElementById(id);
  if (dialog && !dialog.open) {
    dialog.showModal();
  }
}

export function openHelpDialog() {
  openDialogById("help-dialog");
}

export function openWastickersDialog() {
  openDialogById("wastickers-dialog");
}

export function initModalsAndTheme() {
  const openHelpBtn = document.getElementById("open-help-btn");
  if (openHelpBtn) {
    openHelpBtn.addEventListener("click", () => openHelpDialog());
  }

  // Light-dismiss fallback where native `<dialog closedby>` is unsupported
  if (!("closedBy" in HTMLDialogElement.prototype)) {
    for (const dialog of document.querySelectorAll('dialog[closedby="any"]')) {
      dialog.addEventListener("click", (event) => {
        if (event.target !== dialog) return;
        const rect = dialog.getBoundingClientRect();
        const isDialogContent =
          rect.top <= event.clientY &&
          event.clientY <= rect.top + rect.height &&
          rect.left <= event.clientX &&
          event.clientX <= rect.left + rect.width;
        if (!isDialogContent) dialog.close();
      });
    }
  }

  // Theme initialization & toggle (uses CSS vector icons instead of emojis)
  const themeBtn = document.getElementById("theme-toggle");
  const saved = loadSavedTheme();
  const prefersLight =
    window.matchMedia &&
    window.matchMedia("(prefers-color-scheme: light)").matches;
  const initialTheme = saved || (prefersLight ? "light" : "dark");

  const applyTheme = (theme) => {
    const isDark = theme !== "light";
    document.documentElement.setAttribute("data-theme", isDark ? "dark" : "light");
    if (themeBtn) {
      themeBtn.classList.toggle("ico-sun", isDark);
      themeBtn.classList.toggle("ico-moon", !isDark);
      themeBtn.textContent = isDark ? "Claro" : "Oscuro";
      themeBtn.setAttribute("aria-pressed", String(!isDark));
    }
    saveThemePreference(isDark ? "dark" : "light");
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
