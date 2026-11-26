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
import { fetchEmoteAssetBuffer } from "../services/sevenTvApi.js";

function chunkArray(items, chunkSize = 30) {
  const chunks = [];
  for (let i = 0; i < items.length; i += chunkSize) {
    chunks.push(items.slice(i, i + chunkSize));
  }
  return chunks;
}

async function resolveItemBuffer(item, preferFormat = "best") {
  if (item.localBuffer) return item.localBuffer;
  return fetchEmoteAssetBuffer(item, preferFormat);
}

/**
 * Builds standard `.ZIP` archive of stickers (for PC, Discord, Telegram, backups).
 */
export async function buildPackZipBlob({
  queue,
  mode,
  studioConfig,
  onProgress,
}) {
  if (!window.JSZip) {
    throw new Error("La librería JSZip no está cargada.");
  }

  const zip = new window.JSZip();
  const folder = zip.folder("7tv_stickers");
  const usedNames = new Map();
  let done = 0;
  let errors = 0;

  for (const item of queue) {
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

      const buf = await resolveItemBuffer(
        item,
        mode === "png-gif" ? "gif" : "best"
      );
      const isAnim = isAnimatedBuffer(buf);

      if (isAnim && mode !== "webp-static") {
        if (mode === "png-gif" && !isAnimatedGif(buf) && !item.localBuffer) {
          const gifBuf = await resolveItemBuffer(item, "gif");
          const ext = isAnimatedGif(gifBuf) ? "gif" : "webp";
          folder.file(`${finalName}.${ext}`, gifBuf);
        } else if (
          mode === "webp-all" &&
          supportsAnimatedWebpEncoding()
        ) {
          const cfg = studioConfig
            ? { ...DEFAULT_RENDER_CONFIG, ...studioConfig, topText: "", bottomText: "" }
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
      done++;
    } catch (err) {
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
 * Builds one or more official `.wastickers` archives compatible with Sticker Maker
 * (Android & iOS) to install complete named Sticker Packs directly into WhatsApp.
 *
 * Enforces WhatsApp's native ContentProvider rules:
 * - 3 to 30 stickers per pack (auto-chunks larger queues into Vol. 1, Vol. 2...)
 * - `title.txt`, `author.txt`, `tray.png` (96x96 PNG < 50 KB) at archive root
 * - Homogeneous pack rule: either 100% static WebP 512x512 (<= 100 KB) or
 *   100% animated WebP 512x512 (<= 500 KB)
 */
export async function buildWastickersArchives({
  queue,
  title = "7TV Stickers",
  author = "7TV Sticker Studio",
  trayItem = null,
  strategy = "unified", // "unified" | "split" | "static"
  studioConfig = null,
  onProgress,
}) {
  if (!window.JSZip) {
    throw new Error("La librería JSZip no está cargada.");
  }
  if (queue.length < 3) {
    throw new Error("WhatsApp exige mínimo 3 stickers para crear un paquete.");
  }

  const canEncodeAnim = supportsAnimatedWebpEncoding();
  const cleanTitle = title.trim().slice(0, 120) || "7TV Stickers";
  const cleanAuthor = author.trim().slice(0, 120) || "7TV Sticker Studio";
  const cfg = studioConfig
    ? { ...DEFAULT_RENDER_CONFIG, ...studioConfig, topText: "", bottomText: "" }
    : DEFAULT_RENDER_CONFIG;

  // Step 1: Fetch buffers and classify items
  const resolved = [];
  let stepIdx = 0;
  for (const item of queue) {
    stepIdx++;
    onProgress?.({
      phase: "Descargando",
      current: stepIdx,
      total: queue.length,
      name: item.name,
      pct: Math.round((stepIdx / (queue.length * 2)) * 100),
    });
    try {
      const buf = await resolveItemBuffer(item, "best");
      resolved.push({
        item,
        buf,
        isAnim: isAnimatedBuffer(buf),
        mime: detectMime(buf),
      });
    } catch (err) {
      console.error(`No se pudo descargar ${item.name}:`, err);
    }
  }

  if (resolved.length < 3) {
    throw new Error(
      `Solo se pudieron obtener ${resolved.length} emotes válidos (mínimo 3).`
    );
  }

  // Step 2: Plan homogeneous pack groups of 3..30 stickers
  const groups = [];
  const hasAnyAnim = resolved.some((r) => r.isAnim);

  if (strategy === "static" || !canEncodeAnim || !hasAnyAnim) {
    const chunks = chunkArray(resolved, 30);
    chunks.forEach((chunk, idx) => {
      if (chunk.length < 3 && groups.length > 0) {
        // Pad up to 3 using earlier items if trailing chunk has 1-2 stickers
        while (chunk.length < 3) {
          chunk.push(resolved[chunk.length - 1]);
        }
      }
      groups.push({
        packTitle:
          chunks.length > 1 ? `${cleanTitle} (${idx + 1})` : cleanTitle,
        packType: "static",
        entries: chunk,
      });
    });
  } else if (strategy === "split") {
    const animList = resolved.filter((r) => r.isAnim);
    const staticList = resolved.filter((r) => !r.isAnim);

    // If one bucket has 1-2 items (under WA's 3 minimum) and the other exists, merge into unified animated
    if (
      (animList.length > 0 && animList.length < 3) ||
      (staticList.length > 0 && staticList.length < 3)
    ) {
      const chunks = chunkArray(resolved, 30);
      chunks.forEach((chunk, idx) => {
        while (chunk.length < 3) chunk.push(resolved[chunk.length - 1]);
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
    // "unified": 100% animated pack where static stickers are wrapped as 2-frame animated WebPs
    const chunks = chunkArray(resolved, 30);
    chunks.forEach((chunk, idx) => {
      while (chunk.length < 3) chunk.push(resolved[chunk.length - 1]);
      groups.push({
        packTitle:
          chunks.length > 1 ? `${cleanTitle} (${idx + 1})` : cleanTitle,
        packType: "animated",
        entries: chunk,
      });
    });
  }

  // Step 3: Encode stickers and package each `.wastickers` archive
  const totalEncodeSteps = groups.reduce((s, g) => s + g.entries.length, 0);
  let encodedDone = 0;
  const archives = [];

  for (let gIdx = 0; gIdx < groups.length; gIdx++) {
    const group = groups[gIdx];
    const zip = new window.JSZip();

    zip.file("title.txt", group.packTitle);
    zip.file("author.txt", cleanAuthor);

    // Build 96x96 PNG tray icon from chosen trayItem or first entry in group
    const traySourceBuf = trayItem
      ? resolved.find((r) => r.item.id === trayItem.id)?.buf ||
        group.entries[0].buf
      : group.entries[0].buf;
    const trayBlob = await createTrayIconPngBlob(traySourceBuf);
    zip.file("tray.png", trayBlob);

    for (let i = 0; i < group.entries.length; i++) {
      const entry = group.entries[i];
      encodedDone++;
      onProgress?.({
        phase: "Convirtiendo",
        current: encodedDone,
        total: totalEncodeSteps,
        name: entry.item.name,
        pct:
          50 + Math.round((encodedDone / Math.max(1, totalEncodeSteps)) * 48),
      });

      let webpBlob;
      if (group.packType === "animated") {
        if (entry.isAnim) {
          webpBlob = await encodeAnimatedBufferToWebp512(
            entry.buf,
            entry.mime,
            cfg,
            490_000
          );
        } else {
          const cv = await renderBufferToCanvas512(entry.buf, cfg);
          webpBlob = await wrapStaticCanvasAsAnimatedWebp(cv, 0.85);
        }
      } else {
        webpBlob = await convertBufferToStickerBlob(
          entry.buf,
          "image/webp",
          cfg,
          98_000
        );
      }

      zip.file(`${i + 1}.webp`, webpBlob);
    }

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
      count: group.entries.length,
      packType: group.packType,
      blob: wastickersBlob,
    });
  }

  onProgress?.({
    phase: "Completado",
    current: totalEncodeSteps,
    total: totalEncodeSteps,
    name: cleanTitle,
    pct: 100,
  });

  return archives;
}

/**
 * Shares all queued stickers in a SINGLE multi-file Web Share sheet call
 * (converting animated emotes to 512x512 Animated WebP and static to 512x512 WebP),
 * falling back to sequential sharing only if the browser rejects multi-file share.
 */
export async function shareQueueBatchToWA({
  queue,
  studioConfig,
  onProgress,
}) {
  const cfg = studioConfig
    ? { ...DEFAULT_RENDER_CONFIG, ...studioConfig, topText: "", bottomText: "" }
    : DEFAULT_RENDER_CONFIG;
  const canEncodeAnim = supportsAnimatedWebpEncoding();
  const files = [];

  for (let i = 0; i < queue.length; i++) {
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

  // Prefer single-shot multi-file Web Share!
  if (navigator.canShare && navigator.canShare({ files })) {
    await navigator.share({
      files,
      title: "Stickers 7TV",
    });
    return { sent: files.length, mode: "batch" };
  }

  // Fallback: sequential share if browser caps multi-file Web Share
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
