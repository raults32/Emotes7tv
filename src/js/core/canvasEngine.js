export const DEFAULT_RENDER_CONFIG = Object.freeze({
  fitMode: "contain",
  scalePct: 0.96,
  outlinePx: 0,
  outlineColor: "#ffffff",
  shadowPx: 0,
  topText: "",
  bottomText: "",
  fontSize: 54,
  textColor: "#ffffff",
  flipH: 1,
  flipV: 1,
  rotation: 0,
  format: "image/webp",
  quality: 0.92,
});

export function decodeImageFromUrl(objectUrl) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = (err) =>
      reject(new Error("No se pudo decodificar la imagen", { cause: err }));
    img.src = objectUrl;
  });
}

export function drawStickerOnCanvas(cv, imgOrSource, cfg) {
  cv.width = 512;
  cv.height = 512;
  const ctx = cv.getContext("2d");
  ctx.clearRect(0, 0, 512, 512);

  const drawable = imgOrSource.__drawable || imgOrSource;

  // 1. Render transformed base image onto an offscreen 512x512 surface
  const off = document.createElement("canvas");
  off.width = 512;
  off.height = 512;
  const octx = off.getContext("2d");

  const targetBox = 512 * cfg.scalePct;
  const nw = imgOrSource.naturalWidth || imgOrSource.width || 128;
  const nh = imgOrSource.naturalHeight || imgOrSource.height || 128;

  let drawW = targetBox;
  let drawH = targetBox;
  if (cfg.fitMode === "contain") {
    const s = Math.min(targetBox / nw, targetBox / nh);
    drawW = nw * s;
    drawH = nh * s;
  } else if (cfg.fitMode === "cover") {
    const s = Math.max(targetBox / nw, targetBox / nh);
    drawW = nw * s;
    drawH = nh * s;
  }

  octx.save();
  octx.translate(256, 256);
  octx.rotate((cfg.rotation * Math.PI) / 180);
  octx.scale(cfg.flipH, cfg.flipV);
  octx.drawImage(drawable, -drawW / 2, -drawH / 2, drawW, drawH);
  octx.restore();

  // 2. Optional Drop Shadow + Die-Cut Sticker Outline
  if (cfg.shadowPx > 0) {
    ctx.save();
    ctx.shadowColor = "rgba(0, 0, 0, 0.65)";
    ctx.shadowBlur = cfg.shadowPx;
    ctx.shadowOffsetY = Math.round(cfg.shadowPx * 0.28);
  }

  if (cfg.outlinePx > 0) {
    const sil = document.createElement("canvas");
    sil.width = 512;
    sil.height = 512;
    const sctx = sil.getContext("2d");
    sctx.drawImage(off, 0, 0);
    sctx.globalCompositeOperation = "source-in";
    sctx.fillStyle = cfg.outlineColor;
    sctx.fillRect(0, 0, 512, 512);

    const steps = Math.max(16, cfg.outlinePx * 3);
    for (let i = 0; i < steps; i++) {
      const angle = (i / steps) * Math.PI * 2;
      const ox = Math.cos(angle) * cfg.outlinePx;
      const oy = Math.sin(angle) * cfg.outlinePx;
      ctx.drawImage(sil, ox, oy);
    }
    if (cfg.shadowPx > 0) ctx.restore();
    ctx.drawImage(off, 0, 0);
  } else {
    ctx.drawImage(off, 0, 0);
    if (cfg.shadowPx > 0) ctx.restore();
  }

  // 3. Optional Meme Text Overlay
  if (cfg.topText || cfg.bottomText) {
    ctx.save();
    ctx.font = `700 ${cfg.fontSize}px "Bebas Neue", Impact, sans-serif`;
    ctx.textAlign = "center";
    ctx.lineJoin = "round";
    ctx.miterLimit = 2;
    ctx.lineWidth = Math.max(6, Math.round(cfg.fontSize * 0.16));
    ctx.strokeStyle = "#000000";
    ctx.fillStyle = cfg.textColor;

    if (cfg.topText) {
      ctx.textBaseline = "top";
      ctx.strokeText(cfg.topText, 256, 16, 488);
      ctx.fillText(cfg.topText, 256, 16, 488);
    }
    if (cfg.bottomText) {
      ctx.textBaseline = "bottom";
      ctx.strokeText(cfg.bottomText, 256, 496, 488);
      ctx.fillText(cfg.bottomText, 256, 496, 488);
    }
    ctx.restore();
  }
}

export function canvasToBlob(canvas, mime = "image/webp", quality = 0.92) {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (b) => (b ? resolve(b) : reject(new Error("Error exportando lienzo"))),
      mime,
      quality
    );
  });
}

/**
 * Adaptive static WebP compressor ensuring compliance with WhatsApp's strict
 * 100 KB limit per static sticker in third-party packs.
 */
export async function exportStaticWebpUnderLimit(
  canvas,
  maxBytes = 98_000,
  initialQuality = 0.9
) {
  const qualities = [initialQuality, 0.8, 0.68, 0.55, 0.42, 0.28];
  let lastBlob = null;
  for (const q of qualities) {
    lastBlob = await canvasToBlob(canvas, "image/webp", q);
    if (lastBlob.size <= maxBytes) return lastBlob;
  }
  return lastBlob;
}

export async function renderBufferToCanvas512(buf, customConfig = null) {
  const url = URL.createObjectURL(new Blob([buf]));
  try {
    const img = await decodeImageFromUrl(url);
    const cv = document.createElement("canvas");
    const cfg = customConfig
      ? { ...DEFAULT_RENDER_CONFIG, ...customConfig, topText: "", bottomText: "" }
      : DEFAULT_RENDER_CONFIG;
    drawStickerOnCanvas(cv, img, cfg);
    return cv;
  } finally {
    URL.revokeObjectURL(url);
  }
}

export async function convertBufferToStickerBlob(
  buf,
  mime,
  customConfig = null,
  maxBytes = null
) {
  const cv = await renderBufferToCanvas512(buf, customConfig);
  if (mime === "image/webp" && maxBytes) {
    return exportStaticWebpUnderLimit(
      cv,
      maxBytes,
      customConfig?.quality ?? 0.9
    );
  }
  return canvasToBlob(cv, mime, customConfig?.quality ?? 0.92);
}

/**
 * Generates WhatsApp's required 96x96 PNG tray icon (< 50 KB) for `.wastickers` archives.
 */
export async function createTrayIconPngBlob(buf) {
  const url = URL.createObjectURL(new Blob([buf]));
  try {
    const img = await decodeImageFromUrl(url);
    const cv = document.createElement("canvas");
    cv.width = 96;
    cv.height = 96;
    const ctx = cv.getContext("2d");
    ctx.clearRect(0, 0, 96, 96);

    const nw = img.naturalWidth || 96;
    const nh = img.naturalHeight || 96;
    const scale = Math.min(90 / nw, 90 / nh);
    const w = nw * scale;
    const h = nh * scale;
    ctx.drawImage(img, (96 - w) / 2, (96 - h) / 2, w, h);

    const blob = await canvasToBlob(cv, "image/png");
    if (blob.size <= 49_000) return blob;

    // If complex RGBA PNG exceeds 50 KB, scale onto 72x72 centered inside 96x96 to reduce entropy
    ctx.clearRect(0, 0, 96, 96);
    const s2 = Math.min(68 / nw, 68 / nh);
    const w2 = nw * s2;
    const h2 = nh * s2;
    ctx.drawImage(img, (96 - w2) / 2, (96 - h2) / 2, w2, h2);
    return await canvasToBlob(cv, "image/png");
  } finally {
    URL.revokeObjectURL(url);
  }
}
