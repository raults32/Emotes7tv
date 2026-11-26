import { store } from "../state/store.js";
import { readJsonStorage, writeJsonStorage } from "../state/storage.js";
import {
  buildPackZipBlob,
  buildWastickersArchives,
  shareQueueBatchToWA,
} from "../core/zipBuilder.js";
import { getStudioSettings } from "./studioView.js";
import { openWastickersDialog } from "./modals.js";
import { setStatus, showToast } from "./notifications.js";

const PACK_META_STORAGE_KEY = "7tv_studio_pack_meta";

function triggerBlobDownload(blob, fileName) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

export function initPackView() {
  const { state } = store;
  const dock = document.getElementById("pack-dock");
  const countEl = document.getElementById("pack-count");
  const strip = document.getElementById("pack-strip");
  const zipBtn = document.getElementById("zip-btn");
  const openWaPackBtn = document.getElementById("open-wastickers-btn");
  const sharePackBtn = document.getElementById("share-pack-btn");
  const clearBtn = document.getElementById("clear-pack-btn");
  const prog = document.getElementById("pack-progress");
  const fill = document.getElementById("pack-progress-fill");

  // Modal elements for `.wastickers` Pack Builder
  const waDialog = document.getElementById("wastickers-dialog");
  const summaryBanner = document.getElementById("wastickers-summary-banner");
  const titleIn = document.getElementById("pack-title-in");
  const authorIn = document.getElementById("pack-author-in");
  const trayStrip = document.getElementById("tray-picker-strip");
  const strategySelect = document.getElementById("wastickers-strategy");
  const modalProg = document.getElementById("wastickers-progress");
  const modalFill = document.getElementById("wastickers-progress-fill");
  const modalStatus = document.getElementById("wastickers-status-line");
  const shareWastickersBtn = document.getElementById("share-wastickers-btn");
  const downloadWastickersBtn = document.getElementById(
    "download-wastickers-btn"
  );

  let selectedTrayId = null;
  const savedMeta = readJsonStorage(PACK_META_STORAGE_KEY, {
    title: "7TV Stickers",
    author: "7TV Studio",
  });
  if (titleIn) titleIn.value = savedMeta.title || "7TV Stickers";
  if (authorIn) authorIn.value = savedMeta.author || "7TV Studio";

  const canShareFiles = Boolean(navigator.share && navigator.canShare);
  sharePackBtn?.classList.toggle("is-hidden", !canShareFiles);
  shareWastickersBtn?.classList.toggle("is-hidden", !canShareFiles);

  function refreshWastickersModalState() {
    const total = state.packQueue.length;
    if (!summaryBanner) return;

    if (total < 3) {
      summaryBanner.className = "pack-modal-banner warn";
      summaryBanner.textContent = `⚠ WhatsApp exige mínimo 3 stickers para instalar un paquete (actualmente tienes ${total}/3). Añade ${3 - total} más o usa "Enviar todos al Chat".`;
    } else if (total > 30) {
      const vols = Math.ceil(total / 30);
      summaryBanner.className = "pack-modal-banner ok";
      summaryBanner.textContent = `✓ ${total} stickers seleccionados — WhatsApp admite máx. 30 por pack, así que se crearán automáticamente ${vols} paquetes numerados.`;
    } else {
      summaryBanner.className = "pack-modal-banner ok";
      summaryBanner.textContent = `✓ ${total} stickers listos para empaquetar con su propio nombre, autor e ícono en WhatsApp.`;
    }

    const underMin = total < 3;
    if (downloadWastickersBtn) downloadWastickersBtn.disabled = underMin;
    if (shareWastickersBtn) shareWastickersBtn.disabled = underMin;

    // Render tray icon chooser
    if (trayStrip) {
      if (
        !selectedTrayId ||
        !state.packQueue.some((p) => p.id === selectedTrayId)
      ) {
        selectedTrayId = state.packQueue[0]?.id ?? null;
      }

      const options = state.packQueue.slice(0, 30).map((item) => {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "tray-option";
        const isSelected = item.id === selectedTrayId;
        btn.setAttribute("aria-pressed", String(isSelected));
        btn.setAttribute("aria-label", `Usar ${item.name} como ícono del pack`);

        const img = document.createElement("img");
        img.src = item.thumbUrl;
        img.alt = item.name;
        img.width = 40;
        img.height = 40;
        btn.appendChild(img);

        btn.addEventListener("click", () => {
          selectedTrayId = item.id;
          refreshWastickersModalState();
        });
        return btn;
      });
      trayStrip.replaceChildren(...options);
    }
  }

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
    if (waDialog?.open) {
      refreshWastickersModalState();
    }
  }

  store.addEventListener("pack:change", renderPackDock);
  clearBtn?.addEventListener("click", () => store.clearPack());

  // Open `.wastickers` Pack Configurator Modal
  openWaPackBtn?.addEventListener("click", () => {
    // Auto-suggest loaded channel/set name if user hasn't customized pack title
    const setBadgeText = document
      .getElementById("set-title-label")
      ?.textContent?.split("·")[0]
      ?.replace(/^Canal:\s*/i, "")
      ?.trim();
    if (
      titleIn &&
      setBadgeText &&
      (titleIn.value === "7TV Stickers" || !titleIn.value.trim())
    ) {
      titleIn.value = setBadgeText;
    }
    if (modalStatus) modalStatus.textContent = "";
    refreshWastickersModalState();
    openWastickersDialog();
  });

  async function runWastickersExport(shareAfterBuild = false) {
    if (state.packQueue.length < 3) {
      showToast("Añade al menos 3 stickers para crear un paquete.", "err");
      return;
    }

    const title = titleIn?.value.trim() || "7TV Stickers";
    const author = authorIn?.value.trim() || "7TV Studio";
    writeJsonStorage(PACK_META_STORAGE_KEY, { title, author });

    const strategy = strategySelect?.value || "unified";
    const applyStudio = Boolean(
      document.getElementById("batch-apply-studio")?.checked
    );
    const trayItem =
      state.packQueue.find((p) => p.id === selectedTrayId) ||
      state.packQueue[0];

    if (downloadWastickersBtn) downloadWastickersBtn.disabled = true;
    if (shareWastickersBtn) shareWastickersBtn.disabled = true;
    modalProg?.classList.remove("is-hidden");
    modalFill?.style.setProperty("--pack-pct", "0%");

    try {
      const archives = await buildWastickersArchives({
        queue: state.packQueue,
        title,
        author,
        trayItem,
        strategy,
        studioConfig: applyStudio ? getStudioSettings() : null,
        onProgress: ({ phase, current, total, name, pct }) => {
          modalFill?.style.setProperty("--pack-pct", `${pct}%`);
          if (modalStatus) {
            modalStatus.textContent = `⟳ ${phase} (${current}/${total}): ${name}…`;
          }
        },
      });

      if (shareAfterBuild && canShareFiles) {
        const files = archives.map(
          (a) =>
            new File([a.blob], a.fileName, {
              type: "application/octet-stream",
            })
        );
        if (navigator.canShare({ files })) {
          await navigator.share({
            files,
            title,
          });
          if (modalStatus) {
            modalStatus.textContent =
              "✓ Elige Sticker Maker en el menú para agregarlo directo a WhatsApp.";
          }
          showToast("📲 Elige Sticker Maker → Añadir a WhatsApp");
          return;
        }
      }

      // Download each `.wastickers` volume
      archives.forEach((arch, idx) => {
        setTimeout(() => {
          triggerBlobDownload(arch.blob, arch.fileName);
        }, idx * 350);
      });

      if (modalStatus) {
        modalStatus.textContent = `✓ ${archives.length > 1 ? `${archives.length} paquetes .wastickers descargados` : `Descargado: ${archives[0].fileName}`} — ábrelo con Sticker Maker para instalarlo en WhatsApp.`;
      }
      showToast(
        `📲 Pack .wastickers listo (${archives.reduce((s, a) => s + a.count, 0)} stickers)`
      );
    } catch (err) {
      if (err.name !== "AbortError") {
        if (modalStatus) modalStatus.textContent = `✗ ${err.message}`;
        showToast(`Error creando pack: ${err.message}`, "err");
      }
    } finally {
      refreshWastickersModalState();
      modalProg?.classList.add("is-hidden");
    }
  }

  downloadWastickersBtn?.addEventListener("click", () =>
    runWastickersExport(false)
  );
  shareWastickersBtn?.addEventListener("click", () =>
    runWastickersExport(true)
  );

  // Standard `.ZIP` Download
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
        triggerBlobDownload(zipBlob, `7tv_pack_${done}_stickers.zip`);
        showToast(
          `📦 Pack ZIP descargado: ${done} stickers${errors ? ` (${errors} omitidos)` : ""}`
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

  // Single-shot Multi-File Batch Share to WhatsApp Chat
  sharePackBtn?.addEventListener("click", async () => {
    if (!state.packQueue.length) return;
    const applyStudio = Boolean(
      document.getElementById("batch-apply-studio")?.checked
    );

    sharePackBtn.disabled = true;
    prog?.classList.remove("is-hidden");
    fill?.style.setProperty("--pack-pct", "0%");

    try {
      const { sent, mode } = await shareQueueBatchToWA({
        queue: state.packQueue,
        studioConfig: applyStudio ? getStudioSettings() : null,
        onProgress: ({ current, total, name, pct }) => {
          setStatus(`⟳ Preparando lote ${current}/${total}: ${name}…`, "run");
          fill?.style.setProperty("--pack-pct", `${pct}%`);
        },
      });
      if (sent > 0) {
        showToast(
          mode === "batch"
            ? `💬 ${sent} stickers enviados en un solo lote`
            : `💬 ${sent} stickers compartidos`
        );
      }
    } catch (err) {
      if (err.name !== "AbortError") {
        showToast(`Error al compartir lote: ${err.message}`, "err");
      }
    } finally {
      sharePackBtn.disabled = false;
      prog?.classList.add("is-hidden");
    }
  });

  renderPackDock();
}
