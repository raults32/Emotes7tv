import {
  isAnimatedGif,
  isAnimatedBuffer,
  detectMime,
} from "./binaryDetect.js";
import {
  convertBufferToStickerBlob,
  renderBufferToCanvas512,
  createTrayIconPngBlob,
  DEFAULT_RENDER_CONFIG,
} from "./canvasEngine.js";
import {
  supportsAnimatedWebpEncoding,
  encodeAnimatedBufferToWebp512,
  wrapStaticCanvasAsAnimatedWebp,
} from "./animatedWebp.js";
import {
  encodeCanvasToGifBlob,
  encodeAnimatedBufferToGif,
} from "./gifEncoder.js";
import { createYieldBudget } from "./scheduler.js";
import { fetchEmoteAssetBuffer } from "../services/sevenTvApi.js";

function chunkArray(items, chunkSize = 30) {
  const chunks = [];
  for (let i = 0; i < items.length; i += chunkSize) {
    chunks.push(items.slice(i, i + chunkSize));
  }
  return chunks;
}

/**
 * Lazily reads an item's binary buffer one item at a time so uploading
 * hundreds or thousands of local `File` handles uses near-zero idle RAM.
 */
export async function resolveItemBuffer(item, preferFormat = "best") {
  if (item.file instanceof Blob) {
    return item.file.arrayBuffer();
  }
  if (item.localBuffer) {
    return item.localBuffer;
  }
  return fetchEmoteAssetBuffer(item, preferFormat);
}

/**
 * Lightweight animation check that inspects only the first 128 KB slice when
 * backed by a local `File` handle instead of loading megabytes into RAM.
 */
async function probeIsItemAnimated(item) {
  if (typeof item.animated === "boolean") return item.animated;
  if (item.file instanceof Blob) {
    const nameLower = (item.file.name || "").toLowerCase();
    if (
      nameLower.endsWith(".png") ||
      nameLower.endsWith(".jpg") ||
      nameLower.endsWith(".jpeg")
    ) {
      return false;
    }
    const headerSlice = await item.file.slice(0, 131_072).arrayBuffer();
    return isAnimatedBuffer(headerSlice);
  }
  if (item.localBuffer) {
    return isAnimatedBuffer(item.localBuffer);
  }
  return false;
}

/**
 * Converts a single binary buffer into a `.gif` Blob or ArrayBuffer.
 */
export async function convertBufferToGifOutput(buf, studioConfig = null) {
  const isAnim = isAnimatedBuffer(buf);
  const hasCustomEdits = Boolean(
    studioConfig &&
      (studioConfig.outlinePx > 0 ||
        studioConfig.shadowPx > 0 ||
        studioConfig.fitMode !== "contain" ||
        studioConfig.flipH !== 1 ||
        studioConfig.flipV !== 1 ||
        studioConfig.rotation !== 0 ||
        studioConfig.topText ||
        studioConfig.bottomText)
  );

  // Fast path: already an animated GIF and no custom canvas edits requested
  if (isAnimatedGif(buf) && !hasCustomEdits) {
    return buf;
  }

  if (isAnim && supportsAnimatedWebpEncoding()) {
    return encodeAnimatedBufferToGif(
      buf,
      detectMime(buf),
      studioConfig,
      384
    );
  }

  // Static image (or browser lacks ImageDecoder): render 512x512 canvas -> transparent GIF89a
  const cv = await renderBufferToCanvas512(buf, studioConfig);
  return encodeCanvasToGifBlob(cv, 512);
}

/**
 * Builds `.ZIP` archive of stickers (supports `webp-all`, `gif-all`, `png-gif`, `webp-static`).
 */
export async function buildPackZipBlob({
  queue,
  mode,
  studioConfig,
  signal,
  onProgress,
}) {
  if (!window.JSZip) {
    throw new Error("La librería JSZip no está cargada.");
  }

  const maybeYield = createYieldBudget(50);
  const zip = new window.JSZip();
  const folderName = mode === "gif-all" ? "7tv_gifs" : "7tv_stickers";
  const folder = zip.folder(folderName);
  const usedNames = new Map();
  let done = 0;
  let errors = 0;

  for (const item of queue) {
    if (signal?.aborted) {
      throw new DOMException("Cancelado por el usuario", "AbortError");
    }
    await maybeYield();

    onProgress?.({
      current: done + errors + 1,
      total: queue.length,
      name: item.name,
      pct: Math.round(((done + errors) / queue.length) * 100),
    });

    try {
      const safeBase = (item.name || "sticker").replace(/[\\/:*?"<>|]/g, "_");
      const seen = usedNames.get(safeBase) || 0;
      usedNames.set(safeBase, seen + 1);
      const finalName = seen > 0 ? `${safeBase}_${seen}` : safeBase;

      const prefer =
        mode === "png-gif" || mode === "gif-all" ? "gif" : "best";
      const buf = await resolveItemBuffer(item, prefer);

      if (mode === "gif-all") {
        const gifPayload = await convertBufferToGifOutput(buf, studioConfig);
        folder.file(`${finalName}.gif`, gifPayload);
      } else {
        const isAnim = isAnimatedBuffer(buf);

        if (isAnim && mode !== "webp-static") {
          if (mode === "png-gif" && !isAnimatedGif(buf) && !item.localBuffer && !item.file) {
            const gifBuf = await resolveItemBuffer(item, "gif");
            if (isAnimatedGif(gifBuf)) {
              folder.file(`${finalName}.gif`, gifBuf);
            } else {
              const convertedGif = await convertBufferToGifOutput(
                gifBuf,
                studioConfig
              );
              folder.file(`${finalName}.gif`, convertedGif);
            }
          } else if (mode === "png-gif" && !isAnimatedGif(buf)) {
            const convertedGif = await convertBufferToGifOutput(
              buf,
              studioConfig
            );
            folder.file(`${finalName}.gif`, convertedGif);
          } else if (mode === "webp-all" && supportsAnimatedWebpEncoding()) {
            const cfg = studioConfig
              ? {
                  ...DEFAULT_RENDER_CONFIG,
                  ...studioConfig,
                  topText: "",
                  bottomText: "",
                }
              : DEFAULT_RENDER_CONFIG;
            const animWebp = await encodeAnimatedBufferToWebp512(
              buf,
              detectMime(buf),
              cfg
            );
            folder.file(`${finalName}.webp`, animWebp);
          } else {
            const ext = isAnimatedGif(buf) ? "gif" : "webp";
            folder.file(`${finalName}.${ext}`, buf);
          }
        } else {
          const targetMime = mode === "png-gif" ? "image/png" : "image/webp";
          const targetExt = mode === "png-gif" ? "png" : "webp";
          const outBlob = await convertBufferToStickerBlob(
            buf,
            targetMime,
            studioConfig,
            targetMime === "image/webp" ? 98_000 : null
          );
          folder.file(`${finalName}.${targetExt}`, outBlob);
        }
      }
      done++;
    } catch (err) {
      if (err.name === "AbortError") throw err;
      console.error(`Error procesando ${item.name}:`, err);
      errors++;
    }

    onProgress?.({
      current: done + errors,
      total: queue.length,
      name: item.name,
      pct: Math.round(((done + errors) / queue.length) * 100),
    });
  }

  if (done === 0) {
    return { zipBlob: null, done: 0, errors };
  }

  const zipBlob = await zip.generateAsync({ type: "blob" });
  return { zipBlob, done, errors };
}

/**
 * Streaming `.wastickers` builder capable of converting unlimited PNGs/folders
 * (1 to 1,000+ images) into 30-sticker Sticker Maker archives without RAM spikes.
 */
export async function buildWastickersArchives({
  queue,
  title = "7TV Stickers",
  author = "7TV Sticker Studio",
  trayItem = null,
  strategy = "unified", // "unified" | "split" | "static"
  studioConfig = null,
  autoPadUnder3 = false,
  signal,
  onProgress,
}) {
  if (!window.JSZip) {
    throw new Error("La librería JSZip no está cargada.");
  }
  if (!queue.length) {
    throw new Error("No hay imágenes para convertir.");
  }
  if (queue.length < 3 && !autoPadUnder3) {
    throw new Error("WhatsApp exige mínimo 3 stickers para crear un paquete.");
  }

  const maybeYield = createYieldBudget(50);
  const canEncodeAnim = supportsAnimatedWebpEncoding();
  const cleanTitle = title.trim().slice(0, 120) || "7TV Stickers";
  const cleanAuthor = author.trim().slice(0, 120) || "7TV Sticker Studio";
  const cfg = studioConfig
    ? { ...DEFAULT_RENDER_CONFIG, ...studioConfig, topText: "", bottomText: "" }
    : DEFAULT_RENDER_CONFIG;

  // Step 1: Lightweight metadata classification (zero full-file RAM buffering!)
  const classified = [];
  for (let i = 0; i < queue.length; i++) {
    if (signal?.aborted) {
      throw new DOMException("Cancelado por el usuario", "AbortError");
    }
    await maybeYield();
    const item = queue[i];
    const isAnim =
      strategy === "static" ? false : await probeIsItemAnimated(item);
    classified.push({ item, isAnim });
  }

  // Pad to 3 if `autoPadUnder3` is enabled and user dropped 1 or 2 PNGs
  while (classified.length < 3) {
    classified.push(classified[classified.length - 1]);
  }

  // Step 2: Plan homogeneous 3..30 sticker volumes
  const groups = [];
  const hasAnyAnim = classified.some((c) => c.isAnim);

  if (strategy === "static" || !canEncodeAnim || !hasAnyAnim) {
    const chunks = chunkArray(classified, 30);
    chunks.forEach((chunk, idx) => {
      while (chunk.length < 3) chunk.push(classified[chunk.length - 1]);
      groups.push({
        packTitle:
          chunks.length > 1 ? `${cleanTitle} (${idx + 1})` : cleanTitle,
        packType: "static",
        entries: chunk,
      });
    });
  } else if (strategy === "split") {
    const animList = classified.filter((r) => r.isAnim);
    const staticList = classified.filter((r) => !r.isAnim);

    if (
      (animList.length > 0 && animList.length < 3) ||
      (staticList.length > 0 && staticList.length < 3)
    ) {
      const chunks = chunkArray(classified, 30);
      chunks.forEach((chunk, idx) => {
        while (chunk.length < 3) chunk.push(classified[chunk.length - 1]);
        groups.push({
          packTitle:
            chunks.length > 1 ? `${cleanTitle} (${idx + 1})` : cleanTitle,
          packType: "animated",
          entries: chunk,
        });
      });
    } else {
      const animChunks = chunkArray(animList, 30);
      animChunks.forEach((chunk, idx) => {
        while (chunk.length < 3) chunk.push(animList[chunk.length - 1]);
        const suffix =
          animChunks.length > 1 ? ` Anim (${idx + 1})` : " (Animados)";
        groups.push({
          packTitle: staticList.length ? `${cleanTitle}${suffix}` : cleanTitle,
          packType: "animated",
          entries: chunk,
        });
      });

      const staticChunks = chunkArray(staticList, 30);
      staticChunks.forEach((chunk, idx) => {
        while (chunk.length < 3) chunk.push(staticList[chunk.length - 1]);
        const suffix =
          staticChunks.length > 1 ? ` (${idx + 1})` : " (Estáticos)";
        groups.push({
          packTitle: animList.length ? `${cleanTitle}${suffix}` : cleanTitle,
          packType: "static",
          entries: chunk,
        });
      });
    }
  } else {
    const chunks = chunkArray(classified, 30);
    chunks.forEach((chunk, idx) => {
      while (chunk.length < 3) chunk.push(classified[chunk.length - 1]);
      groups.push({
        packTitle:
          chunks.length > 1 ? `${cleanTitle} (${idx + 1})` : cleanTitle,
        packType: "animated",
        entries: chunk,
      });
    });
  }

  // Step 3: Stream-read & encode one sticker at a time per `.wastickers` volume
  const totalSteps = groups.reduce((s, g) => s + g.entries.length, 0);
  let processed = 0;
  const archives = [];

  for (const group of groups) {
    if (signal?.aborted) {
      throw new DOMException("Cancelado por el usuario", "AbortError");
    }
    const zip = new window.JSZip();
    zip.file("title.txt", group.packTitle);
    zip.file("author.txt", cleanAuthor);

    const coverEntry =
      trayItem && group.entries.some((e) => e.item.id === trayItem.id)
        ? trayItem
        : trayItem || group.entries[0].item;
    const traySourceBuf = await resolveItemBuffer(coverEntry, "best");
    const trayBlob = await createTrayIconPngBlob(traySourceBuf);
    zip.file("tray.png", trayBlob);

    let addedInGroup = 0;
    for (let i = 0; i < group.entries.length; i++) {
      if (signal?.aborted) {
        throw new DOMException("Cancelado por el usuario", "AbortError");
      }
      await maybeYield();

      const entry = group.entries[i];
      processed++;
      onProgress?.({
        phase: "Convirtiendo",
        current: processed,
        total: totalSteps,
        name: entry.item.name,
        pct: Math.round((processed / Math.max(1, totalSteps)) * 96),
      });

      try {
        const buf = await resolveItemBuffer(entry.item, "best");
        const realAnim = isAnimatedBuffer(buf);

        let webpBlob;
        if (group.packType === "animated") {
          if (realAnim && canEncodeAnim) {
            webpBlob = await encodeAnimatedBufferToWebp512(
              buf,
              detectMime(buf),
              cfg,
              490_000
            );
          } else {
            const cv = await renderBufferToCanvas512(buf, cfg);
            webpBlob = await wrapStaticCanvasAsAnimatedWebp(cv, 0.85);
          }
        } else {
          webpBlob = await convertBufferToStickerBlob(
            buf,
            "image/webp",
            cfg,
            98_000
          );
        }

        addedInGroup++;
        zip.file(`${addedInGroup}.webp`, webpBlob);
      } catch (err) {
        console.error(`Error convirtiendo ${entry.item.name}:`, err);
      }
    }

    if (addedInGroup === 0) continue;

    const rawZipBlob = await zip.generateAsync({ type: "blob" });
    const safeFileSlug = group.packTitle
      .replace(/[\\/:*?"<>|]+/g, "")
      .replace(/\s+/g, "_")
      .slice(0, 48);

    const wastickersBlob = new Blob([rawZipBlob], {
      type: "application/octet-stream",
    });
    archives.push({
      fileName: `${safeFileSlug || "7tv_pack"}.wastickers`,
      packTitle: group.packTitle,
      count: addedInGroup,
      packType: group.packType,
      blob: wastickersBlob,
    });
  }

  onProgress?.({
    phase: "Completado",
    current: totalSteps,
    total: totalSteps,
    name: cleanTitle,
    pct: 100,
  });

  return archives;
}

/**
 * Bundles multiple `.wastickers` archives into one `.ZIP` file for easy PC transfer.
 */
export async function bundleArchivesIntoMasterZip(archives) {
  const zip = new window.JSZip();
  for (const arch of archives) {
    zip.file(arch.fileName, arch.blob);
  }
  return zip.generateAsync({ type: "blob" });
}

export async function shareQueueBatchToWA({
  queue,
  studioConfig,
  onProgress,
}) {
  const maybeYield = createYieldBudget(50);
  const cfg = studioConfig
    ? { ...DEFAULT_RENDER_CONFIG, ...studioConfig, topText: "", bottomText: "" }
    : DEFAULT_RENDER_CONFIG;
  const canEncodeAnim = supportsAnimatedWebpEncoding();
  const files = [];

  for (let i = 0; i < queue.length; i++) {
    await maybeYield();
    const item = queue[i];
    onProgress?.({
      current: i + 1,
      total: queue.length,
      name: item.name,
      pct: Math.round(((i + 1) / queue.length) * 100),
    });

    try {
      const buf = await resolveItemBuffer(item, "best");
      const isAnim = isAnimatedBuffer(buf);
      let blob;
      if (isAnim && canEncodeAnim) {
        blob = await encodeAnimatedBufferToWebp512(
          buf,
          detectMime(buf),
          cfg,
          490_000
        );
      } else {
        blob = await convertBufferToStickerBlob(
          buf,
          "image/webp",
          cfg,
          98_000
        );
      }
      const safeName = (item.name || `sticker_${i + 1}`).replace(
        /[\\/:*?"<>|]/g,
        "_"
      );
      files.push(
        new File([blob], `sticker_${safeName}.webp`, { type: "image/webp" })
      );
    } catch (err) {
      console.error(`Error preparando ${item.name}:`, err);
    }
  }

  if (!files.length) return { sent: 0, mode: "none" };

  if (navigator.canShare && navigator.canShare({ files })) {
    await navigator.share({
      files,
      title: "Stickers 7TV",
    });
    return { sent: files.length, mode: "batch" };
  }

  let sent = 0;
  for (const file of files) {
    try {
      if (navigator.canShare && navigator.canShare({ files: [file] })) {
        await navigator.share({ files: [file], title: file.name });
        sent++;
      }
    } catch (err) {
      if (err.name === "AbortError") break;
    }
  }
  return { sent, mode: "sequential" };
}
