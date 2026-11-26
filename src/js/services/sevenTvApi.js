const GQL_ENDPOINT = "https://7tv.io/v3/gql";
const REST_BASE = "https://7tv.io/v3";
const REQUEST_TIMEOUT_MS = 12_000;
const MAX_DOWNLOAD_BYTES = 25 * 1024 * 1024; // 25 MB safety cap

function timeoutSignal(ms = REQUEST_TIMEOUT_MS) {
  return typeof AbortSignal.timeout === "function"
    ? AbortSignal.timeout(ms)
    : undefined;
}

export function sanitize7TvId(raw) {
  const clean = String(raw || "").trim();
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(clean)) {
    throw new Error("Identificador de 7TV inválido.");
  }
  return encodeURIComponent(clean);
}

/**
 * Validates external URLs to ensure safe public HTTP(S) origin before fetching
 * or forwarding to a public CORS proxy (prevents scheme confusion & private-LAN leaks).
 */
export function sanitizePublicHttpUrl(raw) {
  const trimmed = String(raw || "").trim();
  if (!trimmed) return "";
  const normalized = trimmed.startsWith("//") ? `https:${trimmed}` : trimmed;
  let parsed;
  try {
    parsed = new URL(normalized);
  } catch {
    return "";
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return "";
  if (parsed.username || parsed.password) return "";

  const host = parsed.hostname.toLowerCase();
  if (
    host === "localhost" ||
    host === "0.0.0.0" ||
    host === "[::1]" ||
    host.endsWith(".local") ||
    host.endsWith(".internal") ||
    /^127\./.test(host) ||
    /^10\./.test(host) ||
    /^192\.168\./.test(host) ||
    /^169\.254\./.test(host) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host)
  ) {
    return "";
  }
  return parsed.href;
}

function sanitizeAssetFileName(name) {
  const s = String(name || "").trim();
  if (!s || s.includes("..") || s.includes("/") || s.includes("\\")) return "";
  return s;
}

export function normalizeEmote(raw) {
  const core = raw?.data ? raw.data : raw || {};
  const id = String(core.id || raw?.id || "");
  const name = String(raw?.name || core.name || "emote").slice(0, 120);
  const urlBase = sanitizePublicHttpUrl(core.host?.url || "").replace(/\/+$/, "");
  const files = (Array.isArray(core.host?.files) ? core.host.files : []).filter(
    (f) => f && sanitizeAssetFileName(f.name)
  );
  const isAnim =
    Boolean(core.animated) ||
    files.some(
      (f) => f.format === "GIF" || (f.static_name && f.static_name !== f.name)
    );
  const thumbFile =
    files.find((f) => f.name === "2x.webp") ||
    files.find((f) => f.name.includes("2x") && f.format === "WEBP") ||
    files.find((f) => f.format === "WEBP") ||
    files[0];
  const thumbUrl =
    urlBase && thumbFile
      ? `${urlBase}/${sanitizeAssetFileName(thumbFile.name)}`
      : "";
  return {
    id,
    name,
    animated: isAnim,
    thumbUrl,
    host: { url: urlBase, files },
  };
}

export async function searchSevenTvEmotes({
  query = "",
  page = 1,
  limit = 24,
  exact = false,
  animMode = "all",
}) {
  const filterObj = {
    case_sensitive: false,
    exact_match: Boolean(exact),
    ignore_tags: false,
  };
  if (animMode === "anim") filterObj.animated = true;
  if (animMode === "static") filterObj.animated = false;

  try {
    const res = await fetch(GQL_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "omit",
      referrerPolicy: "no-referrer",
      signal: timeoutSignal(),
      body: JSON.stringify({
        query: `query($q:String!,$page:Int,$limit:Int,$filter:EmoteSearchFilter){
          emotes(query:$q,page:$page,limit:$limit,sort:{value:"popularity",order:DESCENDING},filter:$filter){
            items{id name animated host{url files{name static_name format width height}}}
          }
        }`,
        variables: { q: query, page, limit, filter: filterObj },
      }),
    });
    const payload = await res.json();
    let rawItems = payload?.data?.emotes?.items;

    if (!rawItems) {
      const fbRes = await fetch(GQL_ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "omit",
        referrerPolicy: "no-referrer",
        signal: timeoutSignal(),
        body: JSON.stringify({
          query: `query($q:String!,$page:Int,$limit:Int,$exact:Boolean!){emotes(query:$q,page:$page,limit:$limit,filter:{case_sensitive:false,exact_match:$exact,ignore_tags:false}){items{id name animated host{url files{name format width height}}}}}`,
          variables: {
            q: query || "peepo",
            page,
            limit: Number(limit) || 24,
            exact: Boolean(exact),
          },
        }),
      });
      const fbData = await fbRes.json();
      rawItems = fbData?.data?.emotes?.items || [];
    }

    let items = rawItems.map(normalizeEmote).filter((e) => e.id && e.thumbUrl);
    if (animMode === "anim") items = items.filter((e) => e.animated);
    if (animMode === "static") items = items.filter((e) => !e.animated);
    return { items, rawCount: rawItems.length };
  } catch (err) {
    throw new Error(`Error conectando con 7TV: ${err.message}`, { cause: err });
  }
}

export async function searchSevenTvUsers(query) {
  try {
    const res = await fetch(GQL_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "omit",
      referrerPolicy: "no-referrer",
      signal: timeoutSignal(),
      body: JSON.stringify({
        query: `query($q:String!){users(query:$q){id username display_name avatar_url connections{platform username emote_set_id} emote_sets{id name}}}`,
        variables: { q: String(query || "").slice(0, 80) },
      }),
    });
    const json = await res.json();
    const usersRaw = json?.data?.users;
    return Array.isArray(usersRaw) ? usersRaw : usersRaw?.items || [];
  } catch (err) {
    throw new Error(`Error buscando canal: ${err.message}`, { cause: err });
  }
}

export async function fetchSevenTvUserById(userId) {
  const safeId = sanitize7TvId(userId);
  const res = await fetch(`${REST_BASE}/users/${safeId}`, {
    credentials: "omit",
    referrerPolicy: "no-referrer",
    signal: timeoutSignal(),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

export async function fetchSevenTvEmoteSet(setId) {
  const safeId = sanitize7TvId(setId);
  const res = await fetch(`${REST_BASE}/emote-sets/${safeId}`, {
    credentials: "omit",
    referrerPolicy: "no-referrer",
    signal: timeoutSignal(),
  });
  if (!res.ok) throw new Error(`Set no encontrado (${res.status})`);
  const data = await res.json();
  return {
    id: data.id,
    name: data.name || "Set",
    emotes: (data.emotes || []).map(normalizeEmote).filter((e) => e.id && e.thumbUrl),
  };
}

export async function fetchSevenTvEmoteById(emoteId) {
  const safeId = sanitize7TvId(emoteId);
  const res = await fetch(`${REST_BASE}/emotes/${safeId}`, {
    credentials: "omit",
    referrerPolicy: "no-referrer",
    signal: timeoutSignal(),
  });
  if (!res.ok) throw new Error(`API ${res.status}`);
  const data = await res.json();
  return normalizeEmote(data);
}

async function readBoundedArrayBuffer(response) {
  const declared = Number(response.headers.get("content-length") || 0);
  if (declared > MAX_DOWNLOAD_BYTES) {
    throw new Error("El archivo excede el límite seguro de 25 MB.");
  }
  const buf = await response.arrayBuffer();
  if (buf.byteLength > MAX_DOWNLOAD_BYTES) {
    throw new Error("El archivo excede el límite seguro de 25 MB.");
  }
  return buf;
}

export async function fetchUrlArrayBuffer(url) {
  const safeUrl = sanitizePublicHttpUrl(url);
  if (!safeUrl) {
    throw new Error("Solo se permiten enlaces públicos HTTPS/HTTP válidos.");
  }

  try {
    const r = await fetch(safeUrl, {
      credentials: "omit",
      referrerPolicy: "no-referrer",
      signal: timeoutSignal(),
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await readBoundedArrayBuffer(r);
  } catch (primaryErr) {
    try {
      const proxyUrl = new URL("https://api.allorigins.win/raw");
      proxyUrl.searchParams.set("url", safeUrl);
      const r2 = await fetch(proxyUrl, {
        credentials: "omit",
        referrerPolicy: "no-referrer",
        signal: timeoutSignal(),
      });
      if (!r2.ok) throw new Error(`Proxy ${r2.status}`);
      return await readBoundedArrayBuffer(r2);
    } catch (proxyErr) {
      throw new Error(`Descarga bloqueada por CORS (${primaryErr.message})`, {
        cause: proxyErr,
      });
    }
  }
}

export async function fetchEmoteAssetBuffer(em, preferFormat = "best") {
  const urlBase = sanitizePublicHttpUrl(em.host?.url || "").replace(/\/+$/, "");
  const files = (em.host?.files || []).filter(
    (f) => f && sanitizeAssetFileName(f.name)
  );

  // When requesting native GIF on an animated 7TV emote whose host.files omits GIF, probe CDN 4x.gif first
  if (
    preferFormat === "gif" &&
    em.animated &&
    !files.some((f) => f.format === "GIF") &&
    urlBase
  ) {
    try {
      const probe = await fetch(`${urlBase}/4x.gif`, {
        credentials: "omit",
        referrerPolicy: "no-referrer",
        signal: timeoutSignal(6_000),
      });
      if (probe.ok) return await readBoundedArrayBuffer(probe);
    } catch {
      // Fall back to standard WEBP/PNG files below
    }
  }

  if (!urlBase || !files.length) throw new Error("Emote sin archivos disponibles");

  const order =
    preferFormat === "gif"
      ? { GIF: 0, WEBP: 1, PNG: 2, AVIF: 3 }
      : { WEBP: 0, PNG: 1, GIF: 2, AVIF: 3 };

  const sorted = files.toSorted(
    (a, b) =>
      (order[a.format] ?? 9) - (order[b.format] ?? 9) ||
      (b.width || 0) - (a.width || 0)
  );
  return fetchUrlArrayBuffer(`${urlBase}/${sanitizeAssetFileName(sorted[0].name)}`);
}
