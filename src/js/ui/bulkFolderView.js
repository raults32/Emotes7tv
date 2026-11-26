import { store } from "../state/store.js";
import {
  buildWastickersArchives,
  buildPackZipBlob,
  bundleArchivesIntoMasterZip,
} from "../core/zipBuilder.js";
import { getStudioSettings } from "./studioView.js";
import { setStatus, showToast } from "./notifications.js";

const IMAGE_EXT_RE = /\.(png|webp|gif|jpe?g|avif|bmp|svg)$/i;
const THUMBS_PAGE_SIZE = 36;

function isSupportedImageFile(file) {
  if (!file) return false;
  if (file.type && file.type.startsWith("image/")) return true;
  return IMAGE_EXT_RE.test(file.name || "");
}

/**
 * Recursively reads all files from dropped folders using `webkitGetAsEntry()`,
 * looping `readEntries()` until exhausted (browsers cap each call at ~100 entries).
 */
async function extractFilesFromDataTransfer(dataTransfer) {
  const items = Array.from(dataTransfer?.items || []);
  const entries = items
    .map((it) =>
      typeof it.webkitGetAsEntry === "function" ? it.webkitGetAsEntry() : null
    )
    .filter(Boolean);

  if (!entries.length) {
    return {
      files: Array.from(dataTransfer?.files || []).filter(isSupportedImageFile),
      folderName: "",
    };
  }

  let detectedFolder = "";
  const collected = [];

  async function walkEntry(entry) {
    if (entry.isFile) {
      const file = await new Promise((resolve) =>
        entry.file(resolve, () => resolve(null))
      );
      if (file && isSupportedImageFile(file)) {
        collected.push(file);
      }
    } else if (entry.isDirectory) {
      if (!detectedFolder) detectedFolder = entry.name;
      const reader = entry.createReader();
      while (true) {
        const batch = await new Promise((resolve) =>
          reader.readEntries(resolve, () => resolve([]))
        );
        if (!batch.length) break;
        for (const child of batch) {
          await walkEntry(child);
        }
      }
    }
  }

  for (const entry of entries) {
    await walkEntry(entry);
  }

  return { files: collected, folderName: detectedFolder };
}

function triggerDownload(blob, fileName) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

export function initBulkFolderView({ onLoadBufferInStudio }) {
  // Lazy file entries: [{ id, name, file, thumbUrl: string | null }]
  let bulkItems = [];
  let visibleThumbLimit = THUMBS_PAGE_SIZE;
  let activeAbortController = null;

  const pickFolderBtn = document.getElementById("pick-folder-btn");
  const pickFilesBtn = document.getElementById("pick-files-btn");
  const folderIn = document.getElementById("folder-in");
  const fileIn = document.getElementById("file-in");
  const dz = document.getElementById("dropzone");

  const workspaceBox = document.getElementById("bulk-workspace");
  const countLabel = document.getElementById("bulk-count-label");
  const packsHint = document.getElementById("bulk-packs-hint");
  const previewGrid = document.getElementById("bulk-preview-grid");
  const moreThumbsBtn = document.getElementById("bulk-more-thumbs-btn");

  const titleIn = document.getElementById("bulk-title-in");
  const authorIn = document.getElementById("bulk-author-in");
  const fitSelect = document.getElementById("bulk-fit-select");
  const useStudioFx = document.getElementById("bulk-use-studio-fx");

  const sendToDockBtn = document.getElementById("bulk-send-to-dock-btn");
  const clearBtn = document.getElementById("bulk-clear-btn");
  const buildWastickersBtn = document.getElementById(
    "bulk-build-wastickers-btn"
  );
  const buildGifBtn = document.getElementById("bulk-build-gif-btn");
  const cancelBtn = document.getElementById("bulk-cancel-btn");

  const progWrap = document.getElementById("bulk-progress");
  const progFill = document.getElementById("bulk-progress-fill");
  const statusLine = document.getElementById("bulk-status-line");
  const resultsBox = document.getElementById("bulk-results-box");

  const canShareFiles = Boolean(navigator.share && navigator.canShare);

  function revokeAllThumbs() {
    for (const item of bulkItems) {
      if (item.thumbUrl) {
        URL.revokeObjectURL(item.thumbUrl);
        item.thumbUrl = null;
      }
    }
  }

  function renderBulkList() {
    if (!workspaceBox || !previewGrid) return;
    const total = bulkItems.length;
    workspaceBox.classList.toggle("is-hidden", total === 0);

    if (total === 0) {
      previewGrid.replaceChildren();
      resultsBox?.replaceChildren();
      resultsBox?.classList.add("is-hidden");
      return;
    }

    const packCount = Math.max(1, Math.ceil(total / 30));
    if (countLabel) {
      countLabel.textContent = `${total} ${total === 1 ? "imagen cargada" : "imágenes cargadas"}`;
    }
    if (packsHint) {
      packsHint.textContent =
        total > 30
          ? `Se dividirán automáticamente en ${packCount} paquetes .wastickers (máx. 30 c/u)`
          : "Listas para convertir en 1 paquete .wastickers directo para Sticker Maker";
    }

    const slice = bulkItems.slice(0, visibleThumbLimit);
    const nodes = slice.map((item, idx) => {
      if (!item.thumbUrl) {
        item.thumbUrl = URL.createObjectURL(item.file);
      }

      const card = document.createElement("div");
      card.className = "bulk-thumb-card";
      card.tabIndex = 0;
      card.setAttribute("role", "button");
      card.setAttribute(
        "aria-label",
        `Previsualizar ${item.name} en el Sticker Studio`
      );

      const rm = document.createElement("button");
      rm.type = "button";
      rm.className = "tile-btn tile-pack";
      rm.textContent = "×";
      rm.setAttribute("aria-label", `Quitar ${item.name} del lote`);
      rm.addEventListener("click", (e) => {
        e.stopPropagation();
        if (item.thumbUrl) URL.revokeObjectURL(item.thumbUrl);
        bulkItems = bulkItems.toSpliced(idx, 1);
        renderBulkList();
      });

      const img = document.createElement("img");
      img.src = item.thumbUrl;
      img.alt = item.name;
      img.width = 52;
      img.height = 52;
      img.loading = "lazy";

      const nameEl = document.createElement("span");
      nameEl.className = "emote-name";
      nameEl.textContent = item.name;

      card.append(rm, img, nameEl);

      const openPreview = async () => {
        const buf = await item.file.arrayBuffer();
        store.setActiveEmote(null, {
          id: item.id,
          name: item.name,
          file: item.file,
          thumbUrl: item.thumbUrl || URL.createObjectURL(item.file),
        });
        await onLoadBufferInStudio(buf, item.name);
        showToast(`🖼️ Previsualizando "${item.name}" en el Studio`);
      };

      card.addEventListener("click", openPreview);
      card.addEventListener("keydown", (e) => {
        if ((e.key === "Enter" || e.key === " ") && e.target === card) {
          e.preventDefault();
          openPreview();
        }
      });

      return card;
    });

    previewGrid.replaceChildren(...nodes);

    if (moreThumbsBtn) {
      const remaining = total - visibleThumbLimit;
      moreThumbsBtn.classList.toggle("is-hidden", remaining <= 0);
      if (remaining > 0) {
        moreThumbsBtn.textContent = `Ver más miniaturas (+${remaining} restantes)`;
      }
    }
  }

  async function ingestFiles(files, suggestedFolderName = "") {
    const valid = files.filter(isSupportedImageFile);
    if (!valid.length) {
      showToast("No se detectaron imágenes compatibles.", "err");
      return;
    }

    // Detect folder name from webkitRelativePath if available
    const relFolder =
      suggestedFolderName ||
      valid[0].webkitRelativePath?.split("/")[0]?.trim() ||
      "";
    if (
      relFolder &&
      titleIn &&
      (!titleIn.value.trim() || titleIn.value === "Mis Stickers PNG")
    ) {
      titleIn.value = relFolder.slice(0, 100);
    }

    const newEntries = valid.map((f, i) => ({
      id: `bulk_${Date.now()}_${i}_${Math.random().toString(36).slice(2, 7)}`,
      name: f.name.replace(/\.[^.]+$/, "") || `sticker_${i + 1}`,
      file: f,
      thumbUrl: null,
    }));

    const wasEmpty = bulkItems.length === 0;
    bulkItems = [...bulkItems, ...newEntries];
    renderBulkList();

    // Open the very first image in Studio so the right-hand preview is live immediately
    if (wasEmpty && newEntries[0]) {
      try {
        const firstBuf = await newEntries[0].file.arrayBuffer();
        await onLoadBufferInStudio(firstBuf, newEntries[0].name);
      } catch {
        // Ignore preview error on corrupt first image
      }
    }

    showToast(
      `📂 ${newEntries.length} ${newEntries.length === 1 ? "imagen añadida" : "imágenes añadidas"} (${bulkItems.length} en total)`
    );
  }

  // Trigger file / folder dialogs
  pickFolderBtn?.addEventListener("click", () => folderIn?.click());
  pickFilesBtn?.addEventListener("click", () => fileIn?.click());

  folderIn?.addEventListener("change", (e) => {
    if (e.target.files?.length) {
      ingestFiles(Array.from(e.target.files));
      e.target.value = "";
    }
  });

  fileIn?.addEventListener("change", (e) => {
    if (e.target.files?.length) {
      ingestFiles(Array.from(e.target.files));
      e.target.value = "";
    }
  });

  dz?.addEventListener("dragover", (e) => {
    e.preventDefault();
    dz.classList.add("over");
  });
  dz?.addEventListener("dragleave", () => dz.classList.remove("over"));
  dz?.addEventListener("drop", async (e) => {
    e.preventDefault();
    dz.classList.remove("over");
    setStatus("⟳ Leyendo archivos o carpeta soltada…", "run");
    const { files, folderName } = await extractFilesFromDataTransfer(
      e.dataTransfer
    );
    await ingestFiles(files, folderName);
  });

  moreThumbsBtn?.addEventListener("click", () => {
    visibleThumbLimit += THUMBS_PAGE_SIZE;
    renderBulkList();
  });

  clearBtn?.addEventListener("click", () => {
    revokeAllThumbs();
    bulkItems = [];
    visibleThumbLimit = THUMBS_PAGE_SIZE;
    if (statusLine) statusLine.textContent = "";
    renderBulkList();
  });

  sendToDockBtn?.addEventListener("click", () => {
    if (!bulkItems.length) return;
    const dockItems = bulkItems.map((it) => ({
      id: it.id,
      name: it.name,
      file: it.file,
      thumbUrl: it.thumbUrl || URL.createObjectURL(it.file),
    }));
    const added = store.addManyToPack(dockItems);
    showToast(`➕ ${added} imágenes enviadas a la cola inferior`);
  });

  cancelBtn?.addEventListener("click", () => {
    activeAbortController?.abort();
  });

  function getBulkRenderConfig() {
    const baseStudio = useStudioFx?.checked ? getStudioSettings() : null;
    const fitMode = fitSelect?.value || "contain";
    return baseStudio
      ? { ...baseStudio, fitMode }
      : {
          fitMode,
          scalePct: 0.96,
          outlinePx: 0,
          outlineColor: "#ffffff",
          shadowPx: 0,
          flipH: 1,
          flipV: 1,
          rotation: 0,
          quality: 0.9,
        };
  }

  function setBusyState(busy) {
    if (buildWastickersBtn) buildWastickersBtn.disabled = busy;
    if (buildGifBtn) buildGifBtn.disabled = busy;
    if (clearBtn) clearBtn.disabled = busy;
    cancelBtn?.classList.toggle("is-hidden", !busy);
    progWrap?.classList.toggle("is-hidden", !busy);
    if (busy) progFill?.style.setProperty("--pack-pct", "0%");
  }

  function renderGeneratedWastickersCards(archives) {
    if (!resultsBox) return;
    resultsBox.classList.remove("is-hidden");

    const nodes = [];

    if (archives.length > 1) {
      const masterBar = document.createElement("div");
      masterBar.className = "bulk-master-bar";
      const info = document.createElement("strong");
      info.textContent = `✅ ${archives.length} paquetes .wastickers listos para Sticker Maker`;

      const zipAllBtn = document.createElement("button");
      zipAllBtn.type = "button";
      zipAllBtn.className = "btn btn-green btn-sm";
      zipAllBtn.textContent = `📦 Bajar los ${archives.length} paquetes en 1 .ZIP`;
      zipAllBtn.addEventListener("click", async () => {
        zipAllBtn.disabled = true;
        try {
          const masterBlob = await bundleArchivesIntoMasterZip(archives);
          triggerDownload(
            masterBlob,
            `packs_wastickers_${archives.length}_volumenes.zip`
          );
          showToast("📦 ZIP con todos los .wastickers descargado");
        } finally {
          zipAllBtn.disabled = false;
        }
      });

      masterBar.append(info, zipAllBtn);
      nodes.push(masterBar);
    }

    archives.forEach((arch) => {
      const row = document.createElement("div");
      row.className = "wastickers-result-card";

      const meta = document.createElement("div");
      meta.className = "wastickers-result-meta";
      const strong = document.createElement("strong");
      strong.textContent = arch.packTitle;
      const sub = document.createElement("span");
      sub.className = "mono";
      sub.textContent = `${arch.count} stickers · ${(arch.blob.size / 1024).toFixed(0)} KB`;
      meta.append(strong, sub);

      const actions = document.createElement("div");
      actions.className = "mini-btn-group";

      if (canShareFiles) {
        const shareBtn = document.createElement("button");
        shareBtn.type = "button";
        shareBtn.className = "btn btn-wa btn-sm";
        shareBtn.textContent = "📲 Sticker Maker";
        shareBtn.addEventListener("click", async () => {
          const file = new File([arch.blob], arch.fileName, {
            type: "application/octet-stream",
          });
          try {
            if (navigator.canShare({ files: [file] })) {
              await navigator.share({ files: [file], title: arch.packTitle });
            } else {
              triggerDownload(arch.blob, arch.fileName);
            }
          } catch (err) {
            if (err.name !== "AbortError") {
              triggerDownload(arch.blob, arch.fileName);
            }
          }
        });
        actions.appendChild(shareBtn);
      }

      const dlBtn = document.createElement("button");
      dlBtn.type = "button";
      dlBtn.className = "btn btn-ghost btn-sm";
      dlBtn.textContent = "⬇ .wastickers";
      dlBtn.addEventListener("click", () =>
        triggerDownload(arch.blob, arch.fileName)
      );
      actions.appendChild(dlBtn);

      row.append(meta, actions);
      nodes.push(row);
    });

    resultsBox.replaceChildren(...nodes);
  }

  // Convert unlimited folder/PNGs -> `.wastickers`
  buildWastickersBtn?.addEventListener("click", async () => {
    if (!bulkItems.length) {
      showToast("Sube una carpeta o imágenes PNG primero.", "err");
      return;
    }

    activeAbortController = new AbortController();
    setBusyState(true);
    resultsBox?.classList.add("is-hidden");

    const packTitle = titleIn?.value.trim() || "Mis Stickers PNG";
    const packAuthor = authorIn?.value.trim() || "7TV Studio";

    try {
      const archives = await buildWastickersArchives({
        queue: bulkItems,
        title: packTitle,
        author: packAuthor,
        trayItem: bulkItems[0],
        strategy: "unified",
        studioConfig: getBulkRenderConfig(),
        autoPadUnder3: true,
        signal: activeAbortController.signal,
        onProgress: ({ phase, current, total, name, pct }) => {
          progFill?.style.setProperty("--pack-pct", `${pct}%`);
          if (statusLine) {
            statusLine.textContent = `⟳ ${phase} ${current}/${total}: ${name}…`;
          }
          setStatus(`⟳ Convirtiendo lote ${current}/${total}…`, "run");
        },
      });

      renderGeneratedWastickersCards(archives);
      if (statusLine) {
        statusLine.textContent = `✓ ¡Listo! ${archives.length === 1 ? "Paquete .wastickers generado" : `${archives.length} paquetes .wastickers generados`}.`;
      }

      // If single pack, trigger direct share on mobile or direct download on desktop right away!
      if (archives.length === 1) {
        const single = archives[0];
        const file = new File([single.blob], single.fileName, {
          type: "application/octet-stream",
        });
        if (canShareFiles && navigator.canShare({ files: [file] })) {
          try {
            await navigator.share({ files: [file], title: single.packTitle });
            showToast("📲 Elige Sticker Maker → Agregar a WhatsApp");
          } catch (err) {
            if (err.name !== "AbortError") {
              triggerDownload(single.blob, single.fileName);
            }
          }
        } else {
          triggerDownload(single.blob, single.fileName);
          showToast(`📲 Descargado: ${single.fileName}`);
        }
      } else {
        showToast(
          `📲 ${archives.length} paquetes .wastickers listos abajo para abrir o descargar`
        );
      }
    } catch (err) {
      if (err.name === "AbortError") {
        if (statusLine) statusLine.textContent = "⏹ Conversión cancelada.";
        showToast("Conversión por lotes cancelada.", "err");
      } else {
        if (statusLine) statusLine.textContent = `✗ Error: ${err.message}`;
        showToast(`Error convirtiendo lote: ${err.message}`, "err");
      }
    } finally {
      setBusyState(false);
      activeAbortController = null;
    }
  });

  // Convert unlimited folder/PNGs -> GIF Pack (.ZIP)
  buildGifBtn?.addEventListener("click", async () => {
    if (!bulkItems.length) {
      showToast("Sube una carpeta o imágenes primero.", "err");
      return;
    }

    activeAbortController = new AbortController();
    setBusyState(true);

    try {
      const { zipBlob, done, errors } = await buildPackZipBlob({
        queue: bulkItems,
        mode: "gif-all",
        studioConfig: getBulkRenderConfig(),
        signal: activeAbortController.signal,
        onProgress: ({ current, total, name, pct }) => {
          progFill?.style.setProperty("--pack-pct", `${pct}%`);
          if (statusLine) {
            statusLine.textContent = `⟳ Codificando GIF ${current}/${total}: ${name}…`;
          }
          setStatus(`⟳ Codificando GIF ${current}/${total}…`, "run");
        },
      });

      if (zipBlob && done > 0) {
        const slug = (titleIn?.value.trim() || "pack_gifs")
          .replace(/[\\/:*?"<>|]+/g, "")
          .replace(/\s+/g, "_");
        triggerDownload(zipBlob, `${slug}_${done}_gifs.zip`);
        if (statusLine) {
          statusLine.textContent = `✓ Pack de ${done} archivos .GIF descargado.`;
        }
        showToast(
          `🎞️ Pack GIF descargado (${done} GIFs${errors ? `, ${errors} omitidos` : ""})`
        );
      }
    } catch (err) {
      if (err.name === "AbortError") {
        if (statusLine) statusLine.textContent = "⏹ Conversión GIF cancelada.";
        showToast("Conversión GIF cancelada.", "err");
      } else {
        showToast(`Error creando Pack GIF: ${err.message}`, "err");
      }
    } finally {
      setBusyState(false);
      activeAbortController = null;
    }
  });

  return {
    ingestFiles,
  };
}
