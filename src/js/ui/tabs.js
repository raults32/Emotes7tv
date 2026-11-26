let tabMap = new Map();

export function selectTabById(tabId, moveFocus = false) {
  const target = tabMap.get(tabId);
  if (!target) return;

  for (const [, entry] of tabMap) {
    const isSel = entry.tab === target.tab;
    entry.tab.setAttribute("aria-selected", String(isSel));
    entry.tab.toggleAttribute("focusgroupstart", isSel);
    if (!Object.hasOwn(HTMLElement.prototype, "focusGroup")) {
      entry.tab.tabIndex = isSel ? 0 : -1;
    }
    if (isSel) {
      entry.panel.hidden = false;
    } else {
      entry.panel.setAttribute("hidden", "until-found");
    }
  }

  if (moveFocus) target.tab.focus();
  target.tab.scrollIntoView({
    block: "nearest",
    inline: "nearest",
    container: "nearest",
  });
}

export function initTabs(tablistId = "source-tablist") {
  const tablist = document.getElementById(tablistId);
  if (!tablist) return;

  const tabs = Array.from(tablist.querySelectorAll('[role="tab"]'));
  tabMap = new Map();

  tabs.forEach((tab, index) => {
    const panel = document.getElementById(tab.dataset.panel);
    if (!panel) return;
    tabMap.set(tab.id, { tab, panel });

    if (!Object.hasOwn(HTMLElement.prototype, "focusGroup")) {
      tab.tabIndex = index === 0 ? 0 : -1;
    }

    tab.addEventListener("click", () => selectTabById(tab.id, false));
    tab.addEventListener("focus", () => {
      if (tab.getAttribute("aria-selected") !== "true") {
        selectTabById(tab.id, false);
      }
    });

    tab.addEventListener("keydown", (e) => {
      if (Object.hasOwn(HTMLElement.prototype, "focusGroup")) return;
      let nextIdx = -1;
      if (e.key === "ArrowRight") nextIdx = (index + 1) % tabs.length;
      else if (e.key === "ArrowLeft") {
        nextIdx = (index - 1 + tabs.length) % tabs.length;
      } else if (e.key === "Home") nextIdx = 0;
      else if (e.key === "End") nextIdx = tabs.length - 1;

      if (nextIdx >= 0) {
        e.preventDefault();
        selectTabById(tabs[nextIdx].id, true);
      }
    });

    panel.addEventListener("beforematch", () => selectTabById(tab.id, false));
  });

  // Scroll-driven animation edge fade fallback using IntersectionObserver
  if (!CSS.supports("animation-timeline", "scroll()")) {
    const [first, last] = [tablist.firstElementChild, tablist.lastElementChild];
    if (first && last) {
      const io = new IntersectionObserver(
        (entries) => {
          for (const { target, intersectionRatio } of entries) {
            tablist.classList.toggle(
              target === first ? "more-start" : "more-end",
              intersectionRatio < 1
            );
          }
        },
        { root: tablist, threshold: 1, rootMargin: "1px" }
      );
      io.observe(first);
      io.observe(last);
    }
  }
}
