import { store } from "../state/store.js";
import { isAnimatedBuffer, detectMime } from "../core/binaryDetect.js";
import {
  decodeImageFromUrl,
  drawStickerOnCanvas,
  canvasToBlob,
} from "../core/canvasEngine.js";
import { writePngBlobToClipboard } from "../services/clipboard.js";
import { showToast } from "./notifications.js";
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
      txt.textContent = "🖼️ Editando fotograma estático 512×512";
      btn.textContent = "Volver a Animado";
    } else {
      txt.textContent = `🎞️ Animación activa (${state.animMime === "image/gif" ? "GIF" : "WEBP"})`;
      btn.textContent = "Editar con texto/borde";
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

    if (
      state.isSourceAnimated &&
      !state.editAnimatedAsStatic &&
      (cfg.topText || cfg.bottomText || cfg.outlinePx > 0 || cfg.shadowPx > 0)
    ) {
      state.editAnimatedAsStatic = true;
      updateAnimBannerUI();
    }

    const dimsBadge = document.getElementById("badge-dims");
    const sizeBadge = document.getElementById("badge-size");

    if (state.isSourceAnimated && !state.editAnimatedAsStatic) {
      cv.classList.add("is-hidden");
      animImg.classList.remove("is-hidden");
      animImg.src = state.animObjectUrl;
      state.outputBlob = new Blob([state.rawBuffer], { type: state.animMime });

      const kb = (state.outputBlob.size / 1024).toFixed(1);
      const over = state.outputBlob.size > 1000 * 1024;
      if (dimsBadge) {
        dimsBadge.textContent = `${state.sourceImage.naturalWidth}×${state.sourceImage.naturalHeight} · ${state.animMime === "image/gif" ? "GIF" : "WEBP"} Anim`;
      }
      if (sizeBadge) {
        sizeBadge.textContent = `${kb} KB ${over ? "⚠ >1MB WA" : "✓ OK"}`;
        sizeBadge.className = "stage-badge " + (over ? "warn" : "ok");
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
      const over = blob.size > 500 * 1024;
      const fmtShort = cfg.format === "image/webp" ? "WEBP" : "PNG";
      if (dimsBadge) dimsBadge.textContent = `512×512 · ${fmtShort}`;
      if (sizeBadge) {
        sizeBadge.textContent = `${kb} KB ${over ? "⚠ >500KB" : "✓ OK WA"}`;
        sizeBadge.className = "stage-badge " + (over ? "warn" : "ok");
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

  // Bind sliders
  const syncFns = [
    bindSlider("scale-slider", "scale-val", "%", renderStudio),
    bindSlider("outline-slider", "outline-val", " px", renderStudio),
    bindSlider("shadow-slider", "shadow-val", " px", renderStudio),
    bindSlider("font-slider", "font-val", " px", renderStudio),
    bindSlider("quality-slider", "quality-val", "%", renderStudio),
  ];

  // Background stage pills
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

  // Fit mode segmented buttons
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

  // Flip, Rotate & Reset
  const ensureStaticIfAnimated = () => {
    if (state.isSourceAnimated && !state.editAnimatedAsStatic) {
      state.editAnimatedAsStatic = true;
      updateAnimBannerUI();
    }
  };

  document.getElementById("flip-h-btn")?.addEventListener("click", () => {
    ensureStaticIfAnimated();
    state.flipH *= -1;
    renderStudio();
  });

  document.getElementById("flip-v-btn")?.addEventListener("click", () => {
    ensureStaticIfAnimated();
    state.flipV *= -1;
    renderStudio();
  });

  document.getElementById("rotate-btn")?.addEventListener("click", () => {
    ensureStaticIfAnimated();
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

  // Live text / color / format listeners
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

  // Add current Studio emote to Pack
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

  // Export actions: Copy, Download, WhatsApp Share
  function downloadCurrentSticker() {
    if (!state.outputBlob) {
      showToast("Selecciona un emote primero.", "err");
      return;
    }
    let ext = "webp";
    if (state.outputBlob.type === "image/png") ext = "png";
    else if (state.outputBlob.type === "image/gif") ext = "gif";

    const url = URL.createObjectURL(state.outputBlob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `sticker_${state.fname}.${ext}`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 3000);
    showToast(`⬇ Descargado: sticker_${state.fname}.${ext}`);
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
      if (!state.outputBlob || !state.sourceImage) {
        showToast("Selecciona un emote primero.", "err");
        return;
      }

      let shareBlob = state.outputBlob;
      let ext = "webp";
      let mime = "image/webp";

      if (state.isSourceAnimated && !state.editAnimatedAsStatic) {
        if (state.outputBlob.type === "image/gif") {
          ext = "gif";
          mime = "image/gif";
        }
      } else if (shareBlob.type !== "image/webp") {
        const cv = document.getElementById("studio-canvas");
        shareBlob = await canvasToBlob(cv, "image/webp", 0.92);
      }

      const file = new File([shareBlob], `sticker_${state.fname}.${ext}`, {
        type: mime,
      });
      if (
        navigator.share &&
        navigator.canShare &&
        navigator.canShare({ files: [file] })
      ) {
        try {
          await navigator.share({ files: [file], title: state.fname });
          showToast("✓ Compartido — elige WhatsApp en el menú");
        } catch (err) {
          if (err.name !== "AbortError") {
            showToast(`Error al compartir: ${err.message}`, "err");
          }
        }
      } else {
        downloadCurrentSticker();
        openHelpDialog();
      }
    });

  const canShareFiles = Boolean(navigator.share && navigator.canShare);
  const waLabel = document.getElementById("share-wa-label");
  if (waLabel) {
    waLabel.textContent = canShareFiles
      ? "Compartir Sticker a WhatsApp"
      : "Descargar para WhatsApp Web + Guía";
  }

  return { loadBufferIntoStudio, renderStudio };
}
