import { store } from "./state/store.js";
import {
  readClipboardImageOrUrl,
  bindGlobalPasteListener,
} from "./services/clipboard.js";
import { initTabs } from "./ui/tabs.js";
import { initModalsAndTheme } from "./ui/modals.js";
import { initStudioView } from "./ui/studioView.js";
import { initExplorerView } from "./ui/explorerView.js";
import { initPackView } from "./ui/packView.js";
import { showToast } from "./ui/notifications.js";

async function loadProgressivePolyfills() {
  if (!Object.hasOwn(HTMLElement.prototype, "popover")) {
    import(
      "https://unpkg.com/@oddbird/popover-polyfill@latest/dist/popover.min.js"
    ).catch(() => {});
  }
  if (!Object.hasOwn(HTMLElement.prototype, "focusGroup")) {
    import("https://cdn.jsdelivr.net/npm/@microsoft/focusgroup-polyfill/+esm")
      .then((m) => m.polyfill?.())
      .catch(() => {});
  }
}

function bootstrap() {
  loadProgressivePolyfills();
  initModalsAndTheme();
  initTabs("source-tablist");

  const studio = initStudioView();
  const explorer = initExplorerView({
    onLoadBufferInStudio: (buf, name) => studio.loadBufferIntoStudio(buf, name),
  });
  initPackView();

  // Global Paste button + Ctrl+V shortcut
  document
    .getElementById("paste-top-btn")
    ?.addEventListener("click", async () => {
      try {
        const res = await readClipboardImageOrUrl();
        if (res.kind === "image") {
          store.setActiveEmote(null, null);
          await studio.loadBufferIntoStudio(res.buffer, "portapapeles");
          showToast("📋 Imagen pegada desde el portapapeles");
        } else if (res.kind === "url") {
          await explorer.loadFromAnyUrl(res.url);
        } else {
          showToast(
            "Copia una imagen o link de 7TV primero y vuelve a pegar.",
            "err"
          );
        }
      } catch {
        showToast(
          "Presiona Ctrl+V directamente en la página para pegar.",
          "run"
        );
      }
    });

  bindGlobalPasteListener({
    onImageFile: (file) => explorer.handleLocalFiles([file]),
    onUrlText: (url) => explorer.loadFromAnyUrl(url),
  });
}

bootstrap();
