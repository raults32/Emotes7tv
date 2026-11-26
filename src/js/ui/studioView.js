import { store } from "../state/store.js";
import { isAnimatedBuffer, detectMime } from "../core/binaryDetect.js";
import {
  decodeImageFromUrl,
  drawStickerOnCanvas,
  canvasToBlob,
  exportStaticWebpUnderLimit,
} from "../core/canvasEngine.js";
import {
  supportsAnimatedWebpEncoding,
  encodeAnimatedBufferToWebp512,
} from "../core/animatedWebp.js";
import { convertBufferToGifOutput } from "../core/zipBuilder.js";
import { writePngBlobToClipboard } from "../services/clipboard.js";
import { setStatus, showToast } from "./notifications.js";
import { openHelpDialog } from "./modals.js";

function bindSlider(id, labelId, unit, onUpdate) {
  const slider = document.getElementById(id);
  const label = document.getElementById(labelId);
  if (!slider) return () => {};

  const sync = () => {
    slider.style.setProperty("--attr-min", slider.min || 0);
    slider.style.setProperty("--attr-max", slider.max || 100);
    slider.style.setProperty("--control-value", slider.value);
    if (label) label.textContent = `${slider.value}${unit}`;
    slider.setAttribute("aria-valuetext", `${slider.value} ${unit.trim()}`);
  };

  sync();
  slider.addEventListener("input", () => {
    sync();
    onUpdate?.();
  });
  return sync;
}

export function getStudioSettings() {
  const { state } = store;
  return {
    fitMode: state.fitMode,
    scalePct: Number(document.getElementById("scale-slider")?.value || 96) / 100,
    outlinePx: Number(document.getElementById("outline-slider")?.value || 0),
    outlineColor: document.getElementById("outline-color")?.value || "#ffffff",
    shadowPx: Number(document.getElementById("shadow-slider")?.value || 0),
    topText: document.getElementById("caption-top")?.value.trim() || "",
    bottomText: document.getElementById("caption-bottom")?.value.trim() || "",
    fontSize: Number(document.getElementById("font-slider")?.value || 54),
    textColor: document.getElementById("text-color")?.value || "#ffffff",
    format: document.getElementById("export-format")?.value || "image/webp",
    quality:
      Number(document.getElementById("quality-slider")?.value || 92) / 100,
    flipH: state.flipH,
    flipV: state.flipV,
    rotation: state.rotation,
  };
}

export function initStudioView() {
  const { state } = store;

  function updateAnimBannerUI() {
    const txt = document.getElementById("anim-banner-text");
    const btn = document.getElementById("toggle-anim-edit-btn");
    if (!txt || !btn) return;
    if (state.editAnimatedAsStatic) {
      txt.textContent = "🖼️ Modo fotograma estático 512×512";
      btn.textContent = "Volver a Animado";
    } else {
      const canAnim512 = supportsAnimatedWebpEncoding();
      txt.textContent = canAnim512
        ? "🎞️ Animado activo (se exporta a WEBP 512×512 para WA)"
        : `🎞️ Animación activa (${state.animMime === "image/gif" ? "GIF" : "WEBP"})`;
      btn.textContent = "Congelar fotograma";
    }
  }

  async function renderStudio() {
    const cv = document.getElementById("studio-canvas");
    const animImg = document.getElementById("studio-anim-img");
    if (!cv || !animImg) return;

    const cfg = getStudioSettings();
    document
      .getElementById("quality-field")
      ?.classList.toggle("is-hidden", cfg.format !== "image/webp");

    if (!state.sourceImage || !state.rawBuffer) {
      const ctx = cv.getContext("2d");
      ctx.clearRect(0, 0, 512, 512);
      return;
    }

    const dimsBadge = document.getElementById("badge-dims");
    const sizeBadge = document.getElementById("badge-size");

    if (state.isSourceAnimated && !state.editAnimatedAsStatic) {
      cv.classList.add("is-hidden");
      animImg.classList.remove("is-hidden");
      animImg.src = state.animObjectUrl;
      state.outputBlob = new Blob([state.rawBuffer], { type: state.animMime });

      const kb = (state.outputBlob.size / 1024).toFixed(1);
      const over = state.outputBlob.size > 500 * 1024;
      if (dimsBadge) {
        dimsBadge.textContent = supportsAnimatedWebpEncoding()
          ? "512×512 · WEBP Anim WA"
          : `${state.sourceImage.naturalWidth}×${state.sourceImage.naturalHeight} · Anim`;
      }
      if (sizeBadge) {
        sizeBadge.textContent = `${kb} KB ${over ? "⚡ Auto <500KB al exportar" : "✓ OK WA"}`;
        sizeBadge.className = "stage-badge ok";
      }
      return;
    }

    animImg.classList.add("is-hidden");
    cv.classList.remove("is-hidden");
    drawStickerOnCanvas(cv, state.sourceImage, cfg);

    try {
      const blob = await canvasToBlob(cv, cfg.format, cfg.quality);
      state.outputBlob = blob;

      const kb = (blob.size / 1024).toFixed(1);
      const over = blob.size > 100 * 1024;
      const fmtShort = cfg.format === "image/webp" ? "WEBP" : "PNG";
      if (dimsBadge) dimsBadge.textContent = `512×512 · ${fmtShort}`;
      if (sizeBadge) {
        sizeBadge.textContent = `${kb} KB ${over && cfg.format === "image/webp" ? "⚡ Auto <100KB en WA" : "✓ OK WA"}`;
        sizeBadge.className = "stage-badge ok";
      }
    } catch {
      // Ignore transient blob conversion errors
    }
  }

  async function loadBufferIntoStudio(buf, name) {
    state.rawBuffer = buf;
    state.fname = name || "sticker";
    const fnameIn = document.getElementById("fname-in");
    if (fnameIn) fnameIn.value = state.fname;

    const isAnim = isAnimatedBuffer(buf);
    state.isSourceAnimated = isAnim;
    state.editAnimatedAsStatic = false;
    state.animMime = detectMime(buf);

    if (state.animObjectUrl) URL.revokeObjectURL(state.animObjectUrl);
    state.animObjectUrl = URL.createObjectURL(
      new Blob([buf], { type: state.animMime })
    );

    state.sourceImage = await decodeImageFromUrl(state.animObjectUrl);

    document
      .getElementById("anim-banner")
      ?.classList.toggle("is-hidden", !isAnim);
    updateAnimBannerUI();
    await renderStudio();
  }

  const syncFns = [
    bindSlider("scale-slider", "scale-val", "%", renderStudio),
    bindSlider("outline-slider", "outline-val", " px", renderStudio),
    bindSlider("shadow-slider", "shadow-val", " px", renderStudio),
    bindSlider("font-slider", "font-val", " px", renderStudio),
    bindSlider("quality-slider", "quality-val", "%", renderStudio),
  ];

  document.querySelectorAll(".bg-pill").forEach((pill) => {
    pill.addEventListener("click", () => {
      const stage = document.getElementById("stage-outer");
      if (stage) stage.dataset.bg = pill.dataset.bg;
      document
        .querySelectorAll(".bg-pill")
        .forEach((p) => p.classList.remove("active"));
      pill.classList.add("active");
    });
  });

  document.querySelectorAll(".seg-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      state.fitMode = btn.dataset.fit || "contain";
      document
        .querySelectorAll(".seg-btn")
        .forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      renderStudio();
    });
  });

  document.getElementById("flip-h-btn")?.addEventListener("click", () => {
    state.flipH *= -1;
    renderStudio();
  });

  document.getElementById("flip-v-btn")?.addEventListener("click", () => {
    state.flipV *= -1;
    renderStudio();
  });

  document.getElementById("rotate-btn")?.addEventListener("click", () => {
    state.rotation = (state.rotation + 90) % 360;
    renderStudio();
  });

  document.getElementById("reset-studio-btn")?.addEventListener("click", () => {
    state.fitMode = "contain";
    state.flipH = 1;
    state.flipV = 1;
    state.rotation = 0;
    document.querySelectorAll(".seg-btn").forEach((b) => {
      b.classList.toggle("active", b.dataset.fit === "contain");
    });
    document.getElementById("scale-slider").value = 96;
    document.getElementById("outline-slider").value = 0;
    document.getElementById("shadow-slider").value = 0;
    document.getElementById("caption-top").value = "";
    document.getElementById("caption-bottom").value = "";
    document.getElementById("font-slider").value = 54;
    document.getElementById("quality-slider").value = 92;
    syncFns.forEach((fn) => fn());
    renderStudio();
  });

  document
    .getElementById("toggle-anim-edit-btn")
    ?.addEventListener("click", () => {
      state.editAnimatedAsStatic = !state.editAnimatedAsStatic;
      updateAnimBannerUI();
      renderStudio();
    });

  ["outline-color", "text-color", "caption-top", "caption-bottom"].forEach(
    (id) => {
      document.getElementById(id)?.addEventListener("input", renderStudio);
    }
  );
  document
    .getElementById("export-format")
    ?.addEventListener("change", renderStudio);

  document.getElementById("fname-in")?.addEventListener("input", (e) => {
    state.fname = e.target.value.trim() || "sticker";
  });

  document.getElementById("studio-pack-btn")?.addEventListener("click", () => {
    if (!state.rawBuffer) {
      showToast("Carga un emote primero.", "err");
      return;
    }
    const item = state.currentEmoteMeta || {
      id: `studio_${Date.now()}`,
      name: state.fname,
      animated: state.isSourceAnimated && !state.editAnimatedAsStatic,
      thumbUrl: state.animObjectUrl,
      localBuffer: state.rawBuffer,
    };
    if (state.packQueue.some((p) => p.id === item.id)) {
      showToast(`"${item.name}" ya está en tu Pack.`);
      return;
    }
    store.togglePackItem(item);
    showToast(`➕ "${item.name}" añadido al Pack (${state.packQueue.length})`);
  });

  async function buildFinalStickerExport(forceWhatsAppReady = false) {
    const cfg = getStudioSettings();
    if (!forceWhatsAppReady && cfg.format === "image/gif") {
      setStatus("⟳ Generando archivo GIF transparente…", "run");
      const gifData = await convertBufferToGifOutput(state.rawBuffer, cfg);
      const gifBlob =
        gifData instanceof Blob
          ? gifData
          : new Blob([gifData], { type: "image/gif" });
      return { blob: gifBlob, ext: "gif", mime: "image/gif" };
    }

    if (state.isSourceAnimated && !state.editAnimatedAsStatic) {
      if (
        (forceWhatsAppReady || cfg.format === "image/webp") &&
        supportsAnimatedWebpEncoding()
      ) {
        setStatus("⟳ Codificando sticker animado 512×512 (<500 KB)…", "run");
        const animWebp = await encodeAnimatedBufferToWebp512(
          state.rawBuffer,
          state.animMime,
          cfg,
          490_000
        );
        return { blob: animWebp, ext: "webp", mime: "image/webp" };
      }
      const ext = state.animMime === "image/gif" ? "gif" : "webp";
      return {
        blob: new Blob([state.rawBuffer], { type: state.animMime }),
        ext,
        mime: state.animMime,
      };
    }

    const cv = document.getElementById("studio-canvas");
    drawStickerOnCanvas(cv, state.sourceImage, cfg);
    if (forceWhatsAppReady) {
      const waBlob = await exportStaticWebpUnderLimit(cv, 98_000, cfg.quality);
      return { blob: waBlob, ext: "webp", mime: "image/webp" };
    }
    const ext = cfg.format === "image/png" ? "png" : "webp";
    const blob = await canvasToBlob(cv, cfg.format, cfg.quality);
    return { blob, ext, mime: cfg.format };
  }

  async function downloadCurrentSticker() {
    if (!state.rawBuffer || !state.sourceImage) {
      showToast("Selecciona un emote primero.", "err");
      return;
    }
    try {
      const { blob, ext } = await buildFinalStickerExport(false);
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `sticker_${state.fname}.${ext}`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 3000);
      showToast(`⬇ Descargado: sticker_${state.fname}.${ext}`);
    } catch (err) {
      showToast(`Error exportando: ${err.message}`, "err");
    }
  }

  document
    .getElementById("download-btn")
    ?.addEventListener("click", downloadCurrentSticker);

  document.getElementById("copy-btn")?.addEventListener("click", async () => {
    if (!state.sourceImage) {
      showToast("Selecciona un emote primero.", "err");
      return;
    }
    try {
      const cv = document.getElementById("studio-canvas");
      if (state.isSourceAnimated && !state.editAnimatedAsStatic) {
        drawStickerOnCanvas(cv, state.sourceImage, getStudioSettings());
      }
      const pngBlob = await canvasToBlob(cv, "image/png");
      await writePngBlobToClipboard(pngBlob);
      showToast("📋 ¡Copiado! Pégalo con Ctrl+V en WhatsApp Web o Discord");
    } catch {
      showToast("Tu navegador bloqueó copiar imagen: usa Descargar.", "err");
    }
  });

  document
    .getElementById("share-wa-btn")
    ?.addEventListener("click", async () => {
      if (!state.rawBuffer || !state.sourceImage) {
        showToast("Selecciona un emote primero.", "err");
        return;
      }

      try {
        const { blob, ext, mime } = await buildFinalStickerExport(true);
        const file = new File([blob], `sticker_${state.fname}.${ext}`, {
          type: mime,
        });
        if (
          navigator.share &&
          navigator.canShare &&
          navigator.canShare({ files: [file] })
        ) {
          await navigator.share({ files: [file], title: state.fname });
          showToast("✓ Compartido — elige WhatsApp en el menú");
        } else {
          const url = URL.createObjectURL(blob);
          const a = document.createElement("a");
          a.href = url;
          a.download = `sticker_${state.fname}.${ext}`;
          a.click();
          setTimeout(() => URL.revokeObjectURL(url), 3000);
          openHelpDialog();
        }
      } catch (err) {
        if (err.name !== "AbortError") {
          showToast(`Error al compartir: ${err.message}`, "err");
        }
      }
    });

  const canShareFiles = Boolean(navigator.share && navigator.canShare);
  const waLabel = document.getElementById("share-wa-label");
  if (waLabel) {
    waLabel.textContent = canShareFiles
      ? "Compartir Sticker a WhatsApp"
      : "Descargar WEBP WhatsApp + Guía";
  }

  return { loadBufferIntoStudio, renderStudio };
}
