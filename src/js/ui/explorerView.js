import { store } from "../state/store.js";
import {
  searchSevenTvEmotes,
  searchSevenTvUsers,
  fetchSevenTvUserById,
  fetchSevenTvEmoteSet,
  fetchSevenTvEmoteById,
  fetchEmoteAssetBuffer,
  fetchUrlArrayBuffer,
  sanitizePublicHttpUrl,
} from "../services/sevenTvApi.js";
import { sanitizeSafeFileStem } from "../core/zipBuilder.js";
import { setStatus, showToast } from "./notifications.js";
import { selectTabById } from "./tabs.js";

function attachImeSafeEnter(inputEl, formEl) {
  if (!inputEl || !formEl) return;
  inputEl.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      if (event.isComposing || event.keyCode === 229) return;
      formEl.requestSubmit();
    }
  });
}

export function initExplorerView({ onLoadBufferInStudio }) {
  const { state } = store;

  async function openEmoteInStudio(em, announce = true) {
    store.setActiveEmote(em.id, em);
    if (announce) setStatus(`Cargando ${em.name} en alta resolución…`, "run");
    try {
      const buf = await fetchEmoteAssetBuffer(em, "best");
      await onLoadBufferInStudio(buf, em.name, em);
      store.pushRecent(em);
      if (announce) {
        setStatus(`Editando "${em.name}" en el Sticker Studio`, "ok");
      }
    } catch (err) {
      setStatus(`Error al cargar ${em.name}: ${err.message}`, "err");
    }
  }

  function renderEmoteGrid(containerId, items) {
    const grid = document.getElementById(containerId);
    if (!grid) return;

    if (!items.length) {
      const empty = document.createElement("div");
      empty.className = "empty-state";
      empty.textContent = "Sin emotes para mostrar aquí.";
      grid.replaceChildren(empty);
      return;
    }

    const nodes = items.map((em) => {
      const isFav = state.favorites.some((f) => f.id === em.id);
      const inPack = state.packQueue.some((p) => p.id === em.id);
      const isActive = state.activeId === em.id;

      const tile = document.createElement("div");
      tile.className =
        "emote-tile" +
        (inPack ? " in-pack" : "") +
        (isActive ? " active-studio" : "");
      tile.dataset.emoteId = em.id;

      const openBtn = document.createElement("button");
      openBtn.type = "button";
      openBtn.className = "emote-open-btn";
      openBtn.setAttribute("aria-label", `Abrir emote ${em.name} en el editor`);

      const thumbWrap = document.createElement("div");
      thumbWrap.className = "emote-thumb-wrap";
      const img = document.createElement("img");
      img.src = sanitizePublicHttpUrl(em.thumbUrl);
      img.alt = "";
      img.width = 64;
      img.height = 64;
      img.loading = "lazy";
      img.decoding = "async";
      thumbWrap.appendChild(img);

      const nameSpan = document.createElement("span");
      nameSpan.className = "emote-name";
      nameSpan.textContent = em.name;

      openBtn.append(thumbWrap, nameSpan);

      openBtn.addEventListener("click", () => {
        const multiMode = document.getElementById("multiselect-mode")?.checked;
        if (multiMode && containerId === "explore-grid") {
          store.togglePackItem(em);
        } else {
          openEmoteInStudio(em, true);
        }
      });

      const favBtn = document.createElement("button");
      favBtn.type = "button";
      favBtn.className = "icon tile-btn tile-fav" + (isFav ? " active" : "");
      favBtn.setAttribute("aria-pressed", String(isFav));
      favBtn.setAttribute(
        "aria-label",
        `${isFav ? "Quitar" : "Guardar"} ${em.name} en favoritos`
      );
      favBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        const added = store.toggleFavorite(em);
        showToast(
          added
            ? `Guardado en favoritos: ${em.name}`
            : `Quitado de favoritos: ${em.name}`
        );
      });

      const packBtn = document.createElement("button");
      packBtn.type = "button";
      packBtn.className = "icon tile-btn tile-pack";
      packBtn.setAttribute("aria-pressed", String(inPack));
      packBtn.setAttribute(
        "aria-label",
        `${inPack ? "Quitar" : "Añadir"} ${em.name} al pack`
      );
      packBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        store.togglePackItem(em);
      });

      tile.append(openBtn, favBtn, packBtn);

      if (em.animated) {
        const animBadge = document.createElement("span");
        animBadge.className = "tile-badge-anim";
        animBadge.textContent = "ANIM";
        tile.appendChild(animBadge);
      }

      return tile;
    });

    grid.replaceChildren(...nodes);
  }

  function refreshTileStates() {
    document.querySelectorAll(".emote-tile").forEach((tile) => {
      const id = tile.dataset.emoteId;
      const inPack = state.packQueue.some((p) => p.id === id);
      const isFav = state.favorites.some((f) => f.id === id);
      const name = tile.querySelector(".emote-name")?.textContent || "emote";
      tile.classList.toggle("in-pack", inPack);
      tile.classList.toggle("active-studio", state.activeId === id);

      const pBtn = tile.querySelector(".tile-pack");
      if (pBtn) {
        pBtn.setAttribute("aria-pressed", String(inPack));
        pBtn.setAttribute(
          "aria-label",
          `${inPack ? "Quitar" : "Añadir"} ${name} al pack`
        );
      }

      const fBtn = tile.querySelector(".tile-fav");
      if (fBtn) {
        fBtn.classList.toggle("active", isFav);
        fBtn.setAttribute("aria-pressed", String(isFav));
        fBtn.setAttribute(
          "aria-label",
          `${isFav ? "Quitar" : "Guardar"} ${name} en favoritos`
        );
      }
    });
  }

  function updateSavedGrids() {
    const badge = document.getElementById("fav-count-badge");
    if (badge) badge.textContent = `(${state.favorites.length})`;
    renderEmoteGrid("favs-grid", state.favorites);
    renderEmoteGrid("recent-grid", state.recents);
  }

  store.addEventListener("pack:change", refreshTileStates);
  store.addEventListener("active:change", refreshTileStates);
  store.addEventListener("saved:change", () => {
    updateSavedGrids();
    refreshTileStates();
  });

  // ── 1. Explore & Search ────────────────────────────────────────────────────
  async function runExploreSearch(resetPage = true) {
    if (resetPage) {
      state.explorePage = 1;
      state.exploreItems = [];
    }
    const exact = Boolean(document.getElementById("exact-check")?.checked);
    const animMode = document.getElementById("anim-filter")?.value || "all";

    setStatus(
      state.exploreQuery
        ? `Buscando "${state.exploreQuery}" en 7TV…`
        : "Cargando emotes populares de 7TV…",
      "run"
    );

    try {
      const { items, rawCount } = await searchSevenTvEmotes({
        query: state.exploreQuery,
        page: state.explorePage,
        limit: 24,
        exact,
        animMode,
      });

      state.exploreItems = resetPage ? items : [...state.exploreItems, ...items];
      renderEmoteGrid("explore-grid", state.exploreItems);

      const loadMoreBtn = document.getElementById("load-more-btn");
      if (loadMoreBtn) {
        loadMoreBtn.classList.toggle("is-hidden", rawCount < 20);
      }

      if (!state.exploreItems.length) {
        setStatus("No se encontraron emotes con esos filtros.", "err");
      } else {
        setStatus(
          `${state.exploreItems.length} emotes listos — clic para editar en el Studio o [+] para armar un Pack`,
          "ok"
        );
        if (!state.rawBuffer && state.exploreItems[0]) {
          openEmoteInStudio(state.exploreItems[0], false);
        }
      }
    } catch (err) {
      setStatus(err.message, "err");
    }
  }

  const exploreForm = document.getElementById("explore-form");
  const searchIn = document.getElementById("search-in");
  attachImeSafeEnter(searchIn, exploreForm);
  exploreForm?.addEventListener("submit", (e) => {
    e.preventDefault();
    document.querySelectorAll(".chips-row .chip").forEach((c) => {
      c.classList.remove("active");
      c.setAttribute("aria-pressed", "false");
    });
    state.exploreQuery = searchIn.value.trim();
    runExploreSearch(true);
  });

  document.querySelectorAll(".chips-row .chip").forEach((chip) => {
    chip.addEventListener("click", () => {
      document.querySelectorAll(".chips-row .chip").forEach((c) => {
        const active = c === chip;
        c.classList.toggle("active", active);
        c.setAttribute("aria-pressed", String(active));
      });
      const preset = chip.dataset.preset ?? "";
      if (searchIn) searchIn.value = preset;
      state.exploreQuery = preset;
      runExploreSearch(true);
    });
  });

  document
    .getElementById("anim-filter")
    ?.addEventListener("change", () => runExploreSearch(true));
  document
    .getElementById("exact-check")
    ?.addEventListener("change", () => runExploreSearch(true));
  document.getElementById("load-more-btn")?.addEventListener("click", () => {
    state.explorePage += 1;
    runExploreSearch(false);
  });

  document
    .getElementById("select-all-explore-btn")
    ?.addEventListener("click", () => {
      const added = store.addManyToPack(state.exploreItems);
      showToast(
        added
          ? `${added} emotes añadidos al Pack`
          : "Todos ya estaban en el Pack"
      );
    });

  // ── 2. Channels & Emote Sets ───────────────────────────────────────────────
  async function loadEmoteSetById(setId, customTitle = "") {
    setStatus("Cargando Emote Set…", "run");
    try {
      const { name, emotes } = await fetchSevenTvEmoteSet(setId);
      state.loadedSetItems = emotes;

      document.getElementById("set-controls")?.classList.remove("is-hidden");
      const setFilterIn = document.getElementById("set-filter-in");
      if (setFilterIn) setFilterIn.value = "";

      const label = customTitle || name;
      const titleBadge = document.getElementById("set-title-label");
      if (titleBadge) {
        titleBadge.textContent = `${label} · ${emotes.length} emotes`;
      }

      renderEmoteGrid("set-grid", emotes);
      setStatus(`${emotes.length} emotes cargados de ${label}`, "ok");
    } catch (err) {
      setStatus(`No se pudo cargar el Emote Set: ${err.message}`, "err");
    }
  }

  async function selectChannelUser(user) {
    const activeConn = (user.connections || []).find((c) => c.emote_set_id);
    const setId = activeConn?.emote_set_id || user.emote_sets?.[0]?.id;
    if (setId) {
      await loadEmoteSetById(
        setId,
        `Canal: ${user.display_name || user.username}`
      );
      return;
    }
    try {
      setStatus("Obteniendo perfil de 7TV…", "run");
      const fullUser = await fetchSevenTvUserById(user.id);
      const conn = (fullUser.connections || []).find((c) => c.emote_set_id);
      const fallbackSetId = conn?.emote_set_id || fullUser.emote_sets?.[0]?.id;
      if (!fallbackSetId) {
        throw new Error("Este usuario no tiene Emote Sets activos.");
      }
      await loadEmoteSetById(
        fallbackSetId,
        `Canal: ${fullUser.display_name || fullUser.username}`
      );
    } catch (err) {
      setStatus(`Error cargando usuario: ${err.message}`, "err");
    }
  }

  function renderChannelMatches(users) {
    const box = document.getElementById("channel-matches");
    if (!box) return;
    const pills = users.map((u) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "channel-pill";
      const safeAvatar = sanitizePublicHttpUrl(u.avatar_url);
      if (safeAvatar) {
        const avatar = document.createElement("img");
        avatar.src = safeAvatar;
        avatar.alt = "";
        avatar.width = 20;
        avatar.height = 20;
        avatar.loading = "lazy";
        btn.appendChild(avatar);
      }
      const span = document.createElement("span");
      span.textContent = u.display_name || u.username;
      btn.appendChild(span);
      btn.addEventListener("click", () => selectChannelUser(u));
      return btn;
    });
    box.replaceChildren(...pills);
  }

  const setsForm = document.getElementById("sets-form");
  const setIn = document.getElementById("set-in");
  attachImeSafeEnter(setIn, setsForm);
  setsForm?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const raw = setIn.value.trim();
    if (!raw) {
      setStatus("Escribe un canal o pega un link de Emote Set.", "err");
      return;
    }
    document.getElementById("channel-matches")?.replaceChildren();

    const setMatch = raw.match(/emote-sets\/([a-z0-9_-]+)/i);
    if (setMatch) {
      await loadEmoteSetById(setMatch[1]);
      return;
    }

    const userMatch = raw.match(/7tv\.app\/users\/([a-z0-9_-]+)/i);
    if (userMatch) {
      await selectChannelUser({ id: userMatch[1] });
      return;
    }

    setStatus(`Buscando canal "${raw}" en 7TV…`, "run");
    try {
      const users = await searchSevenTvUsers(raw);
      if (!users.length) {
        setStatus(`No se encontró ningún canal "${raw}" en 7TV.`, "err");
        return;
      }
      renderChannelMatches(users.slice(0, 8));
      await selectChannelUser(users[0]);
    } catch (err) {
      setStatus(err.message, "err");
    }
  });

  document.getElementById("load-global-btn")?.addEventListener("click", () => {
    document.getElementById("channel-matches")?.replaceChildren();
    loadEmoteSetById("global", "Emotes Globales de 7TV");
  });

  document.getElementById("set-filter-in")?.addEventListener("input", (e) => {
    const q = e.target.value.trim().toLowerCase();
    const filtered = q
      ? state.loadedSetItems.filter((em) => em.name.toLowerCase().includes(q))
      : state.loadedSetItems;
    renderEmoteGrid("set-grid", filtered);
  });

  document
    .getElementById("select-all-set-btn")
    ?.addEventListener("click", () => {
      const q = document
        .getElementById("set-filter-in")
        ?.value.trim()
        .toLowerCase();
      const targetList = q
        ? state.loadedSetItems.filter((em) => em.name.toLowerCase().includes(q))
        : state.loadedSetItems;
      const added = store.addManyToPack(targetList);
      showToast(
        added
          ? `${added} emotes añadidos al Pack`
          : "Todos ya estaban en el Pack"
      );
    });

  // ── 3. Direct URL & Paste Import ───────────────────────────────────────────
  async function loadFromAnyUrl(raw) {
    document.getElementById("cors-note")?.classList.add("is-hidden");

    const setMatch = raw.match(/7tv\.app\/emote-sets\/([a-z0-9_-]+)/i);
    if (setMatch) {
      selectTabById("tab-sets", false);
      if (setIn) setIn.value = raw;
      await loadEmoteSetById(setMatch[1]);
      return;
    }

    const emoteMatch = raw.match(/7tv\.app\/emotes\/([a-z0-9_-]+)/i);
    if (emoteMatch) {
      setStatus("Obteniendo emote desde la API de 7TV…", "run");
      try {
        const em = await fetchSevenTvEmoteById(emoteMatch[1]);
        await openEmoteInStudio(em, true);
        showToast(`Emote "${em.name}" importado`);
      } catch (err) {
        setStatus(`Error en API de 7TV: ${err.message}`, "err");
      }
      return;
    }

    const safeTarget = sanitizePublicHttpUrl(raw);
    if (!safeTarget) {
      setStatus("Introduce un enlace público HTTPS válido.", "err");
      return;
    }

    setStatus("Descargando imagen desde URL…", "run");
    try {
      const buf = await fetchUrlArrayBuffer(safeTarget);
      const rawLeaf = safeTarget.split("/").pop().split("?")[0].replace(/\.[^.]+$/, "");
      const cleanName = sanitizeSafeFileStem(rawLeaf, "sticker");
      store.setActiveEmote(null, null);
      await onLoadBufferInStudio(buf, cleanName, null);
      showToast("Imagen cargada desde URL");
    } catch {
      setStatus("No se pudo descargar la URL por políticas CORS.", "err");
      document.getElementById("cors-note")?.classList.remove("is-hidden");
    }
  }

  const urlForm = document.getElementById("url-form");
  const urlIn = document.getElementById("url-in");
  attachImeSafeEnter(urlIn, urlForm);
  urlForm?.addEventListener("submit", (e) => {
    e.preventDefault();
    const val = urlIn.value.trim();
    if (!val) {
      setStatus("Pega un enlace primero.", "err");
      return;
    }
    loadFromAnyUrl(val);
  });

  // ── 4. Saved Collections Actions ───────────────────────────────────────────
  document
    .getElementById("clear-favs-btn")
    ?.addEventListener("click", () => store.clearSavedCollection("favs"));
  document
    .getElementById("clear-recent-btn")
    ?.addEventListener("click", () => store.clearSavedCollection("recent"));

  updateSavedGrids();
  runExploreSearch(true);

  return {
    loadFromAnyUrl,
  };
}
