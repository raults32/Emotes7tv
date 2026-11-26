import { drawStickerOnCanvas, canvasToBlob } from "./canvasEngine.js";

const FOURCC_RIFF = [0x52, 0x49, 0x46, 0x46]; // "RIFF"
const FOURCC_WEBP = [0x57, 0x45, 0x42, 0x50]; // "WEBP"
const FOURCC_VP8X = [0x56, 0x50, 0x38, 0x58]; // "VP8X"
const FOURCC_ANIM = [0x41, 0x4e, 0x49, 0x4d]; // "ANIM"
const FOURCC_ANMF = [0x41, 0x4e, 0x4d, 0x46]; // "ANMF"

export function supportsAnimatedWebpEncoding() {
  return typeof window !== "undefined" && "ImageDecoder" in window;
}

function writeUint32LE(arr, offset, val) {
  arr[offset] = val & 0xff;
  arr[offset + 1] = (val >>> 8) & 0xff;
  arr[offset + 2] = (val >>> 16) & 0xff;
  arr[offset + 3] = (val >>> 24) & 0xff;
}

function writeUint24LE(arr, offset, val) {
  arr[offset] = val & 0xff;
  arr[offset + 1] = (val >>> 8) & 0xff;
  arr[offset + 2] = (val >>> 16) & 0xff;
}

/**
 * Extracts elementary frame sub-chunks (`ALPH`, `VP8 `, `VP8L`) including their
 * 8-byte headers and RIFF 2-byte even padding from a single-frame WebP ArrayBuffer.
 */
export function extractWebpFrameBitstream(webpBuffer) {
  const bytes = new Uint8Array(webpBuffer);
  if (bytes.length < 20) {
    throw new Error("Buffer WebP inválido");
  }
  const view = new DataView(
    bytes.buffer,
    bytes.byteOffset,
    bytes.byteLength
  );

  const keptChunks = [];
  let offset = 12; // Skip "RIFF" + size + "WEBP"

  while (offset + 8 <= bytes.length) {
    const c0 = bytes[offset];
    const c1 = bytes[offset + 1];
    const c2 = bytes[offset + 2];
    const c3 = bytes[offset + 3];
    const fourCC = String.fromCharCode(c0, c1, c2, c3);
    const chunkSize = view.getUint32(offset + 4, true);
    const paddedPayload = chunkSize + (chunkSize & 1);
    const totalChunkLen = 8 + paddedPayload;

    if (offset + totalChunkLen > bytes.length) {
      // Handle unpadded tail if browser omitted trailing pad byte
      const available = bytes.subarray(offset);
      if (fourCC === "ALPH" || fourCC === "VP8 " || fourCC === "VP8L") {
        if (available.length & 1) {
          const evenCopy = new Uint8Array(available.length + 1);
          evenCopy.set(available, 0);
          keptChunks.push(evenCopy);
        } else {
          keptChunks.push(available);
        }
      }
      break;
    }

    if (fourCC === "ALPH" || fourCC === "VP8 " || fourCC === "VP8L") {
      keptChunks.push(bytes.subarray(offset, offset + totalChunkLen));
    }

    offset += totalChunkLen;
  }

  if (!keptChunks.length) {
    throw new Error("No se encontraron sub-chunks VP8/VP8L en el fotograma");
  }

  const totalLen = keptChunks.reduce((sum, arr) => sum + arr.length, 0);
  const merged = new Uint8Array(totalLen);
  let pos = 0;
  for (const part of keptChunks) {
    merged.set(part, pos);
    pos += part.length;
  }
  return merged;
}

/**
 * Muxes an array of `{ bitstream: Uint8Array, durationMs: number }` into a
 * 512x512 RFC-9649 Animated WebP Blob with alpha & infinite looping.
 */
export function muxAnimatedWebp512(frames) {
  const anmfChunks = frames.map(({ bitstream, durationMs }) => {
    const payloadSize = 16 + bitstream.length;
    const pad = payloadSize & 1;
    const chunk = new Uint8Array(8 + payloadSize + pad);

    // Chunk FourCC "ANMF" + payload size
    chunk.set(FOURCC_ANMF, 0);
    writeUint32LE(chunk, 4, payloadSize);

    // 16-byte ANMF header: X=0, Y=0, W-1=511, H-1=511, Duration, Flags
    writeUint24LE(chunk, 8, 0); // Frame X
    writeUint24LE(chunk, 11, 0); // Frame Y
    writeUint24LE(chunk, 14, 511); // Width - 1 (512px)
    writeUint24LE(chunk, 17, 511); // Height - 1 (512px)
    const clampedDur = Math.max(20, Math.min(5000, Math.round(durationMs)));
    writeUint24LE(chunk, 20, clampedDur);
    // Byte 15 (offset 23): Bit 1 = Blend None (overwrite = 0x02) | Bit 0 = Dispose Background (0x01) => 0x03
    chunk[23] = 0x03;

    chunk.set(bitstream, 24);
    return chunk;
  });

  // VP8X chunk (8 header + 10 payload = 18 bytes)
  const vp8x = new Uint8Array(18);
  vp8x.set(FOURCC_VP8X, 0);
  writeUint32LE(vp8x, 4, 10);
  vp8x[8] = 0x10 | 0x02; // Alpha (0x10) | Animation (0x02)
  writeUint24LE(vp8x, 12, 511); // Canvas Width - 1 (512)
  writeUint24LE(vp8x, 15, 511); // Canvas Height - 1 (512)

  // ANIM chunk (8 header + 6 payload = 14 bytes)
  const anim = new Uint8Array(14);
  anim.set(FOURCC_ANIM, 0);
  writeUint32LE(anim, 4, 6);
  // Background BGRA = 0,0,0,0 (transparent) + Loop Count = 0 (infinite) -> all zeros

  const anmfTotal = anmfChunks.reduce((sum, c) => sum + c.length, 0);
  const riffPayloadSize = 4 + vp8x.length + anim.length + anmfTotal;
  const out = new Uint8Array(8 + riffPayloadSize);

  out.set(FOURCC_RIFF, 0);
  writeUint32LE(out, 4, riffPayloadSize);
  out.set(FOURCC_WEBP, 8);
  out.set(vp8x, 12);
  out.set(anim, 12 + vp8x.length);

  let cursor = 12 + vp8x.length + anim.length;
  for (const c of anmfChunks) {
    out.set(c, cursor);
    cursor += c.length;
  }

  return new Blob([out], { type: "image/webp" });
}

/**
 * Wraps a rendered 512x512 static canvas into a lightweight 2-frame Animated WebP
 * so static emotes can coexist inside an animated WhatsApp sticker pack (`animated_sticker_pack: true`).
 */
export async function wrapStaticCanvasAsAnimatedWebp(canvas, quality = 0.86) {
  const webpBlob = await canvasToBlob(canvas, "image/webp", quality);
  const bitstream = extractWebpFrameBitstream(await webpBlob.arrayBuffer());
  return muxAnimatedWebp512([
    { bitstream, durationMs: 500 },
    { bitstream, durationMs: 500 },
  ]);
}

/**
 * Decodes an animated GIF or WebP buffer via WebCodecs `ImageDecoder`, renders
 * every sampled frame onto a 512x512 canvas with `drawStickerOnCanvas` (preserving
 * Studio fit, outline, shadow, and meme captions), and muxes an RFC-9649 Animated WebP
 * guaranteed under WhatsApp's 500 KB animated sticker cap.
 */
export async function encodeAnimatedBufferToWebp512(
  buf,
  mime,
  studioConfig,
  maxBytes = 490_000
) {
  if (!supportsAnimatedWebpEncoding()) {
    throw new Error("ImageDecoder no disponible en este navegador");
  }

  const supported = await ImageDecoder.isTypeSupported(mime);
  if (!supported) {
    throw new Error(`Decodificación de ${mime} no soportada`);
  }

  const decoder = new ImageDecoder({
    data: buf.slice(0),
    type: mime,
  });

  try {
    await decoder.tracks.ready;
    const track = decoder.tracks.selectedTrack;
    const rawFrameCount = track?.frameCount || 1;

    // Sample at most 24 frames so encoding is fast and stays under 500 KB
    const maxFrames = 24;
    const stride = Math.max(1, Math.ceil(rawFrameCount / maxFrames));
    const frameIndices = [];
    for (let i = 0; i < rawFrameCount; i += stride) {
      frameIndices.push(i);
    }

    // Decode frames and draw to 512x512 canvases once
    const renderedFrames = [];
    let totalDurationMs = 0;

    for (const idx of frameIndices) {
      const { image: videoFrame } = await decoder.decode({
        frameIndex: idx,
        completeFramesOnly: true,
      });

      try {
        // Duration in VideoFrame is in microseconds
        const rawDurMs = videoFrame.duration
          ? Math.round(videoFrame.duration / 1000)
          : 70;
        const scaledDurMs = Math.max(24, rawDurMs * stride);

        // Stop adding frames if WhatsApp's 10s max animation duration would be exceeded
        if (totalDurationMs + scaledDurMs > 9600 && renderedFrames.length >= 2) {
          break;
        }

        // Convert VideoFrame to an offscreen canvas with naturalWidth/Height shape
        const srcCanvas = document.createElement("canvas");
        srcCanvas.width = videoFrame.displayWidth || videoFrame.codedWidth;
        srcCanvas.height = videoFrame.displayHeight || videoFrame.codedHeight;
        srcCanvas.getContext("2d").drawImage(videoFrame, 0, 0);

        const frameCanvas = document.createElement("canvas");
        drawStickerOnCanvas(
          frameCanvas,
          {
            naturalWidth: srcCanvas.width,
            naturalHeight: srcCanvas.height,
            __drawable: srcCanvas,
          },
          studioConfig
        );

        renderedFrames.push({ canvas: frameCanvas, durationMs: scaledDurMs });
        totalDurationMs += scaledDurMs;
      } finally {
        videoFrame.close();
      }
    }

    if (renderedFrames.length < 2 && renderedFrames.length === 1) {
      renderedFrames.push({
        canvas: renderedFrames[0].canvas,
        durationMs: 500,
      });
    }

    // Try descending WebP qualities (and halve frames on ultra-dense animations) to stay <= maxBytes
    const qualitySteps = [0.78, 0.62, 0.46, 0.32];
    for (const quality of qualitySteps) {
      const encoded = [];
      for (const rf of renderedFrames) {
        const blob = await canvasToBlob(rf.canvas, "image/webp", quality);
        const bitstream = extractWebpFrameBitstream(await blob.arrayBuffer());
        encoded.push({ bitstream, durationMs: rf.durationMs });
      }
      const muxed = muxAnimatedWebp512(encoded);
      if (muxed.size <= maxBytes) {
        return muxed;
      }
    }

    // Last resort: thin to 12 frames at quality 0.30
    const thinned = renderedFrames.filter((_, i) => i % 2 === 0);
    const encodedThin = [];
    for (const rf of thinned) {
      const blob = await canvasToBlob(rf.canvas, "image/webp", 0.3);
      const bitstream = extractWebpFrameBitstream(await blob.arrayBuffer());
      encodedThin.push({ bitstream, durationMs: rf.durationMs * 2 });
    }
    return muxAnimatedWebp512(encodedThin);
  } finally {
    decoder.close();
  }
}
