import { store } from "../state/store.js";
import {
  buildPackZipBlob,
  shareQueueSequentially,
} from "../core/zipBuilder.js";
import { getStudioSettings } from "./studioView.js";
import { setStatus, showToast } from "./notifications.js";

export function initPackView() {
  const { state } = store;
  const dock = document.getElementById("pack-dock");
  const countEl = document.getElementById("pack-count");
  const strip = document.getElementById("pack-strip");
  const zipBtn = document.getElementById("zip-btn");
  const sharePackBtn = document.getElementById("share-pack-btn");
  const clearBtn = document.getElementById("clear-pack-btn");
  const prog = document.getElementById("pack-progress");
  const fill = document.getElementById("pack-progress-fill");

  const canShareFiles = Boolean(navigator.share && navigator.canShare);
  sharePackBtn?.classList.toggle("is-hidden", !canShareFiles);

  function renderPackDock() {
    if (!dock || !countEl || !strip) return;
    countEl.textContent = String(state.packQueue.length);
    dock.classList.toggle("visible", state.packQueue.length > 0);

    const thumbs = state.packQueue.map((item, idx) => {
      const box = document.createElement("div");
      box.className = "pack-thumb";

      const img = document.createElement("img");
      img.src = item.thumbUrl;
      img.alt = item.name;
      img.width = 36;
      img.height = 36;

      const rm = document.createElement("button");
      rm.type = "button";
      rm.textContent = "×";
      rm.setAttribute("aria-label", `Quitar ${item.name} del pack`);
      rm.addEventListener("click", () => store.removePackAt(idx));

      box.append(img, rm);
      return box;
    });

    strip.replaceChildren(...thumbs);
  }

  store.addEventListener("pack:change", renderPackDock);
  clearBtn?.addEventListener("click", () => store.clearPack());

  zipBtn?.addEventListener("click", async () => {
    if (!state.packQueue.length) return;
    const mode =
      document.getElementById("zip-format-select")?.value || "webp-all";
    const applyStudio = Boolean(
      document.getElementById("batch-apply-studio")?.checked
    );

    zipBtn.disabled = true;
    prog?.classList.remove("is-hidden");
    fill?.style.setProperty("--pack-pct", "0%");

    try {
      const { zipBlob, done, errors } = await buildPackZipBlob({
        queue: state.packQueue,
        mode,
        studioConfig: applyStudio ? getStudioSettings() : null,
        onProgress: ({ current, total, name, pct }) => {
          setStatus(`⟳ Procesando ${current}/${total}: ${name}…`, "run");
          fill?.style.setProperty("--pack-pct", `${pct}%`);
        },
      });

      if (zipBlob && done > 0) {
        setStatus("⟳ Descargando archivo ZIP…", "run");
        const url = URL.createObjectURL(zipBlob);
        const a = document.createElement("a");
        a.href = url;
        a.download = `7tv_pack_${done}_stickers.zip`;
        a.click();
        setTimeout(() => URL.revokeObjectURL(url), 4000);
        showToast(
          `📦 Pack descargado: ${done} stickers${errors ? ` (${errors} omitidos)` : ""}`
        );
      } else {
        showToast("No se pudo procesar ningún emote del pack.", "err");
      }
    } catch (err) {
      showToast(`Error creando ZIP: ${err.message}`, "err");
    } finally {
      zipBtn.disabled = false;
      prog?.classList.add("is-hidden");
    }
  });

  sharePackBtn?.addEventListener("click", async () => {
    if (!state.packQueue.length) return;
    const applyStudio = Boolean(
      document.getElementById("batch-apply-studio")?.checked
    );
    const sent = await shareQueueSequentially({
      queue: state.packQueue,
      studioConfig: applyStudio ? getStudioSettings() : null,
      onStep: ({ current, total, name }) => {
        setStatus(`⟳ Preparando ${current}/${total}: ${name}…`, "run");
      },
    });
    showToast(`📲 ${sent} stickers compartidos`);
  });

  renderPackDock();
}
