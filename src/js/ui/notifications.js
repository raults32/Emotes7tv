const activeToasts = [];

export function setStatus(msg, type = "") {
  const pill = document.getElementById("status-pill");
  const text = document.getElementById("status-text");
  if (!pill || !text) return;
  pill.className = "status-pill" + (type ? ` ${type}` : "");
  text.textContent = msg;
}

function repositionToasts() {
  let offset = 20;
  for (let i = activeToasts.length - 1; i >= 0; i--) {
    const t = activeToasts[i];
    t.style.setProperty("--toast-bottom", `${offset}px`);
    offset += (t.offsetHeight || 52) + 10;
  }
}

export function showToast(message, type = "ok") {
  setStatus(message, type);

  // Suppress background toasts while a modal dialog is open
  if (document.querySelector("dialog:modal")) return;

  if (typeof document.ariaNotify === "function") {
    document.ariaNotify(message);
  } else {
    const sr = document.getElementById("sr-announcer");
    if (sr) {
      sr.textContent = "";
      requestAnimationFrame(() => {
        sr.textContent = message;
      });
    }
  }

  const region = document.getElementById("toast-region");
  if (!region) return;

  const toast = document.createElement("div");
  toast.className = "toast-item";
  toast.setAttribute("popover", "manual");

  const span = document.createElement("span");
  span.textContent = message;

  const closeBtn = document.createElement("button");
  closeBtn.type = "button";
  closeBtn.className = "btn btn-ghost btn-sm";
  closeBtn.textContent = "✕";
  closeBtn.setAttribute("aria-label", "Cerrar notificación");

  const dismiss = (manualFocus = false) => {
    const idx = activeToasts.indexOf(toast);
    if (idx >= 0) activeToasts.splice(idx, 1);
    if (manualFocus) {
      const next = activeToasts[idx] || activeToasts[idx - 1];
      if (next) next.querySelector("button")?.focus();
    }
    try {
      if (typeof toast.hidePopover === "function") toast.hidePopover();
    } catch {
      // Ignore already hidden state
    }
    toast.remove();
    repositionToasts();
  };

  closeBtn.addEventListener("click", () => dismiss(true));
  toast.append(span, closeBtn);
  region.appendChild(toast);

  try {
    if (typeof toast.showPopover === "function") {
      toast.showPopover();
    } else {
      toast.classList.add(":popover-open");
    }
  } catch {
    toast.classList.add(":popover-open");
  }

  activeToasts.push(toast);
  repositionToasts();

  const scheduleHide = () => {
    setTimeout(() => {
      if (!toast.isConnected) return;
      if (toast.matches(":focus-within")) {
        toast.addEventListener("focusout", scheduleHide, { once: true });
        return;
      }
      dismiss(false);
    }, 3600);
  };
  scheduleHide();
}
