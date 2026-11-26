const GQL_ENDPOINT = "https://7tv.io/v3/gql";
const REST_BASE = "https://7tv.io/v3";
const REQUEST_TIMEOUT_MS = 12_000;

function timeoutSignal(ms = REQUEST_TIMEOUT_MS) {
  return typeof AbortSignal.timeout === "function"
    ? AbortSignal.timeout(ms)
    : undefined;
}

export function normalizeEmote(raw) {
  const core = raw.data ? raw.data : raw;
  const id = core.id || raw.id;
  const name = raw.name || core.name || "emote";
  const base = core.host?.url || "";
  const urlBase = base.startsWith("//") ? "https:" + base : base;
  const files = core.host?.files || [];
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
  const thumbUrl = thumbFile ? `${urlBase}/${thumbFile.name}` : "";
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
    exact_match: exact,
    ignore_tags: false,
  };
  if (animMode === "anim") filterObj.animated = true;
  if (animMode === "static") filterObj.animated = false;

  try {
    const res = await fetch(GQL_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
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
        signal: timeoutSignal(),
        body: JSON.stringify({
          query: `query($q:String!,$page:Int){emotes(query:$q,page:$page,limit:${limit},filter:{case_sensitive:false,exact_match:${exact},ignore_tags:false}){items{id name animated host{url files{name format width height}}}}}`,
          variables: { q: query || "peepo", page },
        }),
      });
      const fbData = await fbRes.json();
      rawItems = fbData?.data?.emotes?.items || [];
    }

    let items = rawItems.map(normalizeEmote);
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
      signal: timeoutSignal(),
      body: JSON.stringify({
        query: `query($q:String!){users(query:$q){id username display_name avatar_url connections{platform username emote_set_id} emote_sets{id name}}}`,
        variables: { q: query },
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
  const res = await fetch(`${REST_BASE}/users/${userId}`, {
    signal: timeoutSignal(),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

export async function fetchSevenTvEmoteSet(setId) {
  const res = await fetch(`${REST_BASE}/emote-sets/${setId}`, {
    signal: timeoutSignal(),
  });
  if (!res.ok) throw new Error(`Set no encontrado (${res.status})`);
  const data = await res.json();
  return {
    id: data.id,
    name: data.name || "Set",
    emotes: (data.emotes || []).map(normalizeEmote),
  };
}

export async function fetchSevenTvEmoteById(emoteId) {
  const res = await fetch(`${REST_BASE}/emotes/${emoteId}`, {
    signal: timeoutSignal(),
  });
  if (!res.ok) throw new Error(`API ${res.status}`);
  const data = await res.json();
  return normalizeEmote(data);
}

export async function fetchUrlArrayBuffer(url) {
  try {
    const r = await fetch(url, { signal: timeoutSignal() });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.arrayBuffer();
  } catch (primaryErr) {
    try {
      const proxyUrl = new URL("https://api.allorigins.win/raw");
      proxyUrl.searchParams.set("url", url);
      const r2 = await fetch(proxyUrl, { signal: timeoutSignal() });
      if (!r2.ok) throw new Error(`Proxy ${r2.status}`);
      return await r2.arrayBuffer();
    } catch (proxyErr) {
      throw new Error(`Descarga bloqueada por CORS (${primaryErr.message})`, {
        cause: proxyErr,
      });
    }
  }
}

export async function fetchEmoteAssetBuffer(em, preferFormat = "best") {
  const base = em.host?.url || "";
  const urlBase = base.startsWith("//") ? "https:" + base : base;
  const files = em.host?.files || [];

  // When requesting native GIF on an animated 7TV emote whose host.files omits GIF, probe CDN 4x.gif first
  if (
    preferFormat === "gif" &&
    em.animated &&
    !files.some((f) => f.format === "GIF") &&
    urlBase
  ) {
    try {
      const probe = await fetch(`${urlBase}/4x.gif`, {
        signal: timeoutSignal(6_000),
      });
      if (probe.ok) return await probe.arrayBuffer();
    } catch {
      // Fall back to standard WEBP/PNG files below
    }
  }

  if (!files.length) throw new Error("Emote sin archivos disponibles");

  const order =
    preferFormat === "gif"
      ? { GIF: 0, WEBP: 1, PNG: 2, AVIF: 3 }
      : { WEBP: 0, PNG: 1, GIF: 2, AVIF: 3 };

  const sorted = files.toSorted(
    (a, b) =>
      (order[a.format] ?? 9) - (order[b.format] ?? 9) ||
      (b.width || 0) - (a.width || 0)
  );
  return fetchUrlArrayBuffer(`${urlBase}/${sorted[0].name}`);
}
