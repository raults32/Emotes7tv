export async function writePngBlobToClipboard(pngBlob) {
  await navigator.clipboard.write([
    new ClipboardItem({ "image/png": pngBlob }),
  ]);
}

export async function readClipboardImageOrUrl() {
  if (navigator.clipboard?.read) {
    const clipItems = await navigator.clipboard.read();
    for (const item of clipItems) {
      const imgType = item.types.find((t) => t.startsWith("image/"));
      if (imgType) {
        const blob = await item.getType(imgType);
        return { kind: "image", buffer: await blob.arrayBuffer() };
      }
    }
  }
  const text = await navigator.clipboard.readText();
  if (text && /^https?:\/\//i.test(text.trim())) {
    return { kind: "url", url: text.trim() };
  }
  return { kind: "empty" };
}

export function bindGlobalPasteListener({ onImageFile, onUrlText }) {
  window.addEventListener("paste", (e) => {
    const tag = document.activeElement?.tagName;
    const isTypingInput = tag === "INPUT" || tag === "TEXTAREA";

    const items = Array.from(e.clipboardData?.items || []);
    const imageItem = items.find((it) => it.type.startsWith("image/"));
    if (imageItem) {
      e.preventDefault();
      const file = imageItem.getAsFile();
      if (file) onImageFile(file);
      return;
    }

    if (!isTypingInput) {
      const text = e.clipboardData?.getData("text/plain")?.trim();
      if (text && /^https?:\/\//i.test(text)) {
        e.preventDefault();
        onUrlText(text);
      }
    }
  });
}
