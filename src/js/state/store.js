import {
  loadFavorites,
  saveFavorites,
  loadRecents,
  saveRecents,
} from "./storage.js";

class StudioStore extends EventTarget {
  constructor() {
    super();
    this.state = {
      activeId: null,
      fname: "sticker",
      rawBuffer: null,
      sourceImage: null,
      isSourceAnimated: false,
      editAnimatedAsStatic: false,
      animMime: "image/webp",
      animObjectUrl: null,
      outputBlob: null,
      fitMode: "contain",
      flipH: 1,
      flipV: 1,
      rotation: 0,
      currentEmoteMeta: null,
      exploreQuery: "",
      explorePage: 1,
      exploreItems: [],
      loadedSetItems: [],
      packQueue: [],
      favorites: loadFavorites(),
      recents: loadRecents(),
    };
  }

  emit(type, detail = null) {
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }

  toggleFavorite(emote) {
    const idx = this.state.favorites.findIndex((f) => f.id === emote.id);
    const added = idx < 0;
    if (added) {
      this.state.favorites = [emote, ...this.state.favorites];
    } else {
      this.state.favorites = this.state.favorites.toSpliced(idx, 1);
    }
    saveFavorites(this.state.favorites);
    this.emit("saved:change", { emote, added });
    return added;
  }

  pushRecent(emote) {
    if (!emote?.id || String(emote.id).startsWith("local_")) return;
    this.state.recents = [
      emote,
      ...this.state.recents.filter((r) => r.id !== emote.id),
    ].slice(0, 24);
    saveRecents(this.state.recents);
    this.emit("saved:change", { recent: emote });
  }

  clearSavedCollection(which) {
    if (which === "favs") {
      this.state.favorites = [];
      saveFavorites([]);
    } else {
      this.state.recents = [];
      saveRecents([]);
    }
    this.emit("saved:change", { cleared: which });
  }

  togglePackItem(emote) {
    const idx = this.state.packQueue.findIndex((p) => p.id === emote.id);
    const added = idx < 0;
    if (added) {
      this.state.packQueue = [...this.state.packQueue, emote];
    } else {
      this.state.packQueue = this.state.packQueue.toSpliced(idx, 1);
    }
    this.emit("pack:change", { emote, added });
    return added;
  }

  addManyToPack(emotes) {
    let added = 0;
    const next = [...this.state.packQueue];
    for (const em of emotes) {
      if (!next.some((p) => p.id === em.id)) {
        next.push(em);
        added++;
      }
    }
    if (added > 0) {
      this.state.packQueue = next;
      this.emit("pack:change", { addedCount: added });
    }
    return added;
  }

  removePackAt(index) {
    if (index < 0 || index >= this.state.packQueue.length) return;
    this.state.packQueue = this.state.packQueue.toSpliced(index, 1);
    this.emit("pack:change");
  }

  clearPack() {
    this.state.packQueue = [];
    this.emit("pack:change");
  }

  setActiveEmote(id, meta = null) {
    this.state.activeId = id;
    this.state.currentEmoteMeta = meta;
    this.emit("active:change", { id, meta });
  }
}

export const store = new StudioStore();
