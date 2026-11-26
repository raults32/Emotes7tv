import { isAnimatedGif, isAnimatedBuffer } from "./binaryDetect.js";
import { convertBufferToStickerBlob } from "./canvasEngine.js";
import { fetchEmoteAssetBuffer } from "../services/sevenTvApi.js";

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

      const buf = item.localBuffer
        ? item.localBuffer
        : await fetchEmoteAssetBuffer(item, mode === "png-gif" ? "gif" : "best");

      const isAnim = isAnimatedBuffer(buf);

      if (isAnim && mode !== "webp-static") {
        if (mode === "png-gif" && !isAnimatedGif(buf) && !item.localBuffer) {
          const gifBuf = await fetchEmoteAssetBuffer(item, "gif");
          const ext = isAnimatedGif(gifBuf) ? "gif" : "webp";
          folder.file(`${finalName}.${ext}`, gifBuf);
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
          studioConfig
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

export async function shareQueueSequentially({
  queue,
  studioConfig,
  onStep,
}) {
  let sent = 0;
  for (const item of queue) {
    onStep?.({ current: sent + 1, total: queue.length, name: item.name });
    try {
      const buf = item.localBuffer
        ? item.localBuffer
        : await fetchEmoteAssetBuffer(item, "best");
      const blob = await convertBufferToStickerBlob(
        buf,
        "image/webp",
        studioConfig
      );
      const file = new File([blob], `sticker_${item.name}.webp`, {
        type: "image/webp",
      });
      if (navigator.canShare && navigator.canShare({ files: [file] })) {
        await navigator.share({ files: [file], title: item.name });
        sent++;
      }
    } catch (err) {
      if (err.name === "AbortError") break;
    }
  }
  return sent;
}
