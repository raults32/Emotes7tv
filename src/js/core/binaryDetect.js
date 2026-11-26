export function isAnimatedGif(buf) {
  const bytes = new Uint8Array(buf);
  if (bytes[0] !== 0x47 || bytes[1] !== 0x49 || bytes[2] !== 0x46) return false;
  const limit = Math.min(bytes.length - 2, 2 * 1024 * 1024);
  let frames = 0;
  for (let i = 0; i < limit; i++) {
    if (bytes[i] === 0x00 && bytes[i + 1] === 0x21 && bytes[i + 2] === 0xf9) {
      frames++;
      if (frames > 1) return true;
    }
  }
  return false;
}

export function isAnimatedWebp(buf) {
  const bytes = new Uint8Array(buf);
  if (
    bytes[0] !== 0x52 ||
    bytes[1] !== 0x49 ||
    bytes[2] !== 0x46 ||
    bytes[3] !== 0x46 ||
    bytes[8] !== 0x57 ||
    bytes[9] !== 0x45 ||
    bytes[10] !== 0x42 ||
    bytes[11] !== 0x50
  ) {
    return false;
  }
  const limit = Math.min(bytes.length - 4, 120 * 1024);
  for (let i = 12; i < limit; i++) {
    if (
      bytes[i] === 0x41 &&
      bytes[i + 1] === 0x4e &&
      bytes[i + 2] === 0x4d &&
      (bytes[i + 3] === 0x46 || bytes[i + 3] === 0x20)
    ) {
      return true;
    }
  }
  return false;
}

export function isAnimatedBuffer(buf) {
  return isAnimatedGif(buf) || isAnimatedWebp(buf);
}

export function detectMime(buf) {
  const b = new Uint8Array(buf);
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return "image/gif";
  if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[8] === 0x57) {
    return "image/webp";
  }
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) {
    return "image/png";
  }
  return "image/png";
}
