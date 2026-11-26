import { drawStickerOnCanvas, DEFAULT_RENDER_CONFIG } from "./canvasEngine.js";
import { supportsAnimatedWebpEncoding } from "./animatedWebp.js";
import { createYieldBudget } from "./scheduler.js";

const TRANSPARENT_INDEX = 255;

/**
 * Builds a 256-entry RGB palette (indices 0..254 opaque, index 255 transparent)
 * and maps RGBA pixels to palette indices using a fast RGB555 lookup cache.
 */
function quantizeRgbaFrame(rgba, pixelCount) {
  // Base 252-color perceptual 6x7x6 cube + 3 neutral grays = 255 colors
  const palette = new Uint8Array(256 * 3);
  let pIdx = 0;
  const rLevels = [0, 51, 102, 153, 204, 255];
  const gLevels = [0, 42, 85, 128, 170, 213, 255];
  const bLevels = [0, 51, 102, 153, 204, 255];

  for (let ri = 0; ri < 6; ri++) {
    for (let gi = 0; gi < 7; gi++) {
      for (let bi = 0; bi < 6; bi++) {
        palette[pIdx * 3] = rLevels[ri];
        palette[pIdx * 3 + 1] = gLevels[gi];
        palette[pIdx * 3 + 2] = bLevels[bi];
        pIdx++;
      }
    }
  }
  const extraGrays = [28, 118, 190];
  for (const g of extraGrays) {
    palette[pIdx * 3] = g;
    palette[pIdx * 3 + 1] = g;
    palette[pIdx * 3 + 2] = g;
    pIdx++;
  }

  // Check if image has <= 255 unique RGB555 colors; if so, build exact palette!
  const seen555 = new Int16Array(32768).fill(-1);
  const exactColors = [];
  let fitsExact = true;

  for (let i = 0; i < pixelCount; i++) {
    const a = rgba[i * 4 + 3];
    if (a < 128) continue;
    const r = rgba[i * 4];
    const g = rgba[i * 4 + 1];
    const b = rgba[i * 4 + 2];
    const key = ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3);
    if (seen555[key] === -1) {
      if (exactColors.length < 255) {
        seen555[key] = exactColors.length;
        exactColors.push(r, g, b);
      } else {
        fitsExact = false;
        break;
      }
    }
  }

  const indexed = new Uint8Array(pixelCount);

  if (fitsExact && exactColors.length > 0) {
    palette.fill(0);
    palette.set(exactColors, 0);
    for (let i = 0; i < pixelCount; i++) {
      if (rgba[i * 4 + 3] < 128) {
        indexed[i] = TRANSPARENT_INDEX;
      } else {
        const key =
          ((rgba[i * 4] >> 3) << 10) |
          ((rgba[i * 4 + 1] >> 3) << 5) |
          (rgba[i * 4 + 2] >> 3);
        indexed[i] = seen555[key];
      }
    }
    return { palette, indexed };
  }

  // General case: direct O(1) mapping onto 6x7x6 cube
  for (let i = 0; i < pixelCount; i++) {
    if (rgba[i * 4 + 3] < 128) {
      indexed[i] = TRANSPARENT_INDEX;
    } else {
      const r = rgba[i * 4];
      const g = rgba[i * 4 + 1];
      const b = rgba[i * 4 + 2];
      const ri = Math.round((r * 5) / 255);
      const gi = Math.round((g * 6) / 255);
      const bi = Math.round((b * 5) / 255);
      indexed[i] = ri * 42 + gi * 6 + bi;
    }
  }
  return { palette, indexed };
}

/**
 * Standard GIF89a LZW encoder for 8-bit indexed pixels (`minCodeSize = 8`).
 * Uses a flat `Int32Array(4096 * 256)` transition table for fast zero-GC encoding.
 */
export function lzwEncodeGifFrame(indexedPixels) {
  const minCodeSize = 8;
  const clearCode = 256;
  const eoiCode = 257;

  const outBytes = [minCodeSize];
  const subBlock = new Uint8Array(255);
  let subLen = 0;

  let bitBuf = 0;
  let bitCount = 0;

  const flushSubBlock = () => {
    if (subLen > 0) {
      outBytes.push(subLen);
      for (let i = 0; i < subLen; i++) outBytes.push(subBlock[i]);
      subLen = 0;
    }
  };

  const emitCode = (code, size) => {
    bitBuf |= code << bitCount;
    bitCount += size;
    while (bitCount >= 8) {
      subBlock[subLen++] = bitBuf & 0xff;
      if (subLen === 255) flushSubBlock();
      bitBuf >>>= 8;
      bitCount -= 8;
    }
  };

  const table = new Int32Array(4096 * 256).fill(-1);
  let codeSize = 9;
  let nextCode = 258;

  emitCode(clearCode, codeSize);

  if (indexedPixels.length === 0) {
    emitCode(eoiCode, codeSize);
  } else {
    let prefix = indexedPixels[0];

    for (let i = 1; i < indexedPixels.length; i++) {
      const k = indexedPixels[i];
      const slot = (prefix << 8) | k;
      const hit = table[slot];

      if (hit !== -1) {
        prefix = hit;
      } else {
        emitCode(prefix, codeSize);
        if (nextCode < 4096) {
          table[slot] = nextCode;
          if (nextCode === 1 << codeSize && codeSize < 12) {
            codeSize++;
          }
          nextCode++;
        } else {
          emitCode(clearCode, codeSize);
          table.fill(-1);
          codeSize = 9;
          nextCode = 258;
        }
        prefix = k;
      }
    }

    emitCode(prefix, codeSize);
    emitCode(eoiCode, codeSize);
  }

  if (bitCount > 0) {
    subBlock[subLen++] = bitBuf & 0xff;
  }
  flushSubBlock();
  outBytes.push(0x00); // Block terminator

  return Uint8Array.from(outBytes);
}

/**
 * Encodes one or more `{ width, height, rgba: Uint8ClampedArray, durationMs }` frames
 * into a standard GIF89a Blob with alpha transparency and infinite looping.
 */
export async function encodeFramesToGif89a(frames) {
  if (!frames.length) throw new Error("Sin fotogramas para codificar GIF");
  const maybeYield = createYieldBudget(50);

  const width = frames[0].width;
  const height = frames[0].height;
  const isAnim = frames.length > 1;
  const chunks = [];

  // 1. Header ("GIF89a") + Logical Screen Descriptor (no GCT; each frame carries LCT)
  const header = new Uint8Array(13);
  header.set([0x47, 0x49, 0x46, 0x38, 0x39, 0x61], 0); // GIF89a
  header[6] = width & 0xff;
  header[7] = (width >>> 8) & 0xff;
  header[8] = height & 0xff;
  header[9] = (height >>> 8) & 0xff;
  header[10] = 0x70; // No GCT, 8-bit color resolution
  header[11] = 0x00;
  header[12] = 0x00;
  chunks.push(header);

  // 2. Netscape 2.0 infinite loop block for multi-frame GIFs
  if (isAnim) {
    chunks.push(
      new Uint8Array([
        0x21, 0xff, 0x0b, 0x4e, 0x45, 0x54, 0x53, 0x43, 0x41, 0x50, 0x45, 0x32,
        0x2e, 0x30, 0x03, 0x01, 0x00, 0x00, 0x00,
      ])
    );
  }

  // 3. Encode each frame
  for (const frame of frames) {
    await maybeYield();
    const { palette, indexed } = quantizeRgbaFrame(
      frame.rgba,
      width * height
    );
    const delayCs = isAnim
      ? Math.max(2, Math.round((frame.durationMs || 70) / 10))
      : 0;

    // Graphic Control Extension (8 bytes): Disposal=2 (restore bg), TranspFlag=1 -> 0x09
    const gce = new Uint8Array([
      0x21,
      0xf9,
      0x04,
      0x09,
      delayCs & 0xff,
      (delayCs >>> 8) & 0xff,
      TRANSPARENT_INDEX,
      0x00,
    ]);

    // Image Descriptor (10 bytes) with Local Color Table flag (0x87 = 256 entries)
    const imgDesc = new Uint8Array([
      0x2c,
      0x00,
      0x00,
      0x00,
      0x00,
      width & 0xff,
      (width >>> 8) & 0xff,
      height & 0xff,
      (height >>> 8) & 0xff,
      0x87,
    ]);

    const lzwData = lzwEncodeGifFrame(indexed);
    chunks.push(gce, imgDesc, palette, lzwData);
  }

  // 4. Trailer
  chunks.push(new Uint8Array([0x3b]));

  return new Blob(chunks, { type: "image/gif" });
}

export async function encodeCanvasToGifBlob(canvas, size = 512) {
  let targetCanvas = canvas;
  if (canvas.width !== size || canvas.height !== size) {
    targetCanvas = document.createElement("canvas");
    targetCanvas.width = size;
    targetCanvas.height = size;
    targetCanvas.getContext("2d").drawImage(canvas, 0, 0, size, size);
  }
  const ctx = targetCanvas.getContext("2d");
  const { data } = ctx.getImageData(0, 0, size, size);
  return encodeFramesToGif89a([
    { width: size, height: size, rgba: data, durationMs: 0 },
  ]);
}

/**
 * Converts an animated WebP or GIF ArrayBuffer into a 384x384 (or custom size)
 * transparent animated GIF89a applying Studio framing/outline/text settings.
 */
export async function encodeAnimatedBufferToGif(
  buf,
  mime,
  studioConfig = null,
  gifSize = 384
) {
  if (!supportsAnimatedWebpEncoding()) {
    throw new Error("ImageDecoder no disponible para recodificar animación");
  }
  const ok = await ImageDecoder.isTypeSupported(mime);
  if (!ok) throw new Error(`Formato animado ${mime} no soportado`);

  const cfg = studioConfig
    ? { ...DEFAULT_RENDER_CONFIG, ...studioConfig }
    : DEFAULT_RENDER_CONFIG;

  const decoder = new ImageDecoder({ data: buf.slice(0), type: mime });
  try {
    await decoder.tracks.ready;
    const track = decoder.tracks.selectedTrack;
    const rawCount = track?.frameCount || 1;
    const maxFrames = 28;
    const stride = Math.max(1, Math.ceil(rawCount / maxFrames));

    const frames = [];
    const renderCv = document.createElement("canvas");
    const scaleCv = document.createElement("canvas");
    scaleCv.width = gifSize;
    scaleCv.height = gifSize;
    const scaleCtx = scaleCv.getContext("2d");

    for (let idx = 0; idx < rawCount; idx += stride) {
      const { image: vf } = await decoder.decode({
        frameIndex: idx,
        completeFramesOnly: true,
      });
      try {
        const durMs = Math.max(
          20,
          (vf.duration ? Math.round(vf.duration / 1000) : 70) * stride
        );
        const srcCv = document.createElement("canvas");
        srcCv.width = vf.displayWidth || vf.codedWidth;
        srcCv.height = vf.displayHeight || vf.codedHeight;
        srcCv.getContext("2d").drawImage(vf, 0, 0);

        drawStickerOnCanvas(
          renderCv,
          {
            naturalWidth: srcCv.width,
            naturalHeight: srcCv.height,
            __drawable: srcCv,
          },
          cfg
        );

        scaleCtx.clearRect(0, 0, gifSize, gifSize);
        scaleCtx.drawImage(renderCv, 0, 0, gifSize, gifSize);
        const { data } = scaleCtx.getImageData(0, 0, gifSize, gifSize);
        frames.push({
          width: gifSize,
          height: gifSize,
          rgba: data,
          durationMs: durMs,
        });
      } finally {
        vf.close();
      }
    }

    return encodeFramesToGif89a(frames);
  } finally {
    decoder.close();
  }
}
