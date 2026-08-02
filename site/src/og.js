import {ImageResponse} from "workers-og";

/**
 * Per-notice OG cards — a notice's first sentences AS the social card.
 *
 * X/Facebook crawlers do not render SVG og:images, so this renders a real PNG
 * in the Worker (satori + resvg via workers-og). Fonts are self-hosted in the
 * assets bundle (Courier Prime, OFL) — no runtime dependency on anyone.
 *
 * Bodies are content-addressed and immutable, so a card never changes once
 * rendered: cache it at the edge for a year.
 */

/** First `n` sentences of a body, markdown mostly stripped, clamped for the card. */
export function firstSentences(body, n = 3, maxLen = 280) {
    let t = String(body ?? "")
        .replace(/```[\s\S]*?```/g, " ") // code fences
        .replace(/^#{1,3}\s+/gm, "") // heading marks
        .replace(/^>\s?/gm, "") // quote marks
        .replace(/^[-*]\s+/gm, "") // bullets
        .replace(/\[\[([^\]|]+)\|?([^\]]*)\]\]/g, (_, a, b) => b || a) // wikilinks -> label
        .replace(/\s+/g, " ")
        .trim();
    if (!t) return "";
    const parts = t.split(/(?<=[.!?])\s+/).slice(0, n);
    let out = parts.join(" ");
    if (out.length > maxLen) out = out.slice(0, maxLen - 1).trimEnd() + "…";
    return out;
}

// Satori's HTML parser never DECODES entities — an escaped "&amp;" would render
// literally. So text is passed raw, with only the two tag-breaking characters
// swapped for lookalikes. Handles are [a-z0-9-] by contract, already safe.
const txt = (s) => String(s ?? "").replace(/</g, "‹").replace(/>/g, "›");

let fontCache = null; // {regular, bold} — module-scope, survives across requests per isolate

async function loadFonts(env) {
    if (fontCache) return fontCache;
    const grab = async (path) => {
        const r = await env.ASSETS.fetch(new Request("https://assets.local" + path));
        if (!r.ok) throw new Error(`font ${path} missing from assets`);
        return r.arrayBuffer();
    };
    const [regular, bold] = await Promise.all([
        grab("/fonts/CourierPrime-Regular.ttf"),
        grab("/fonts/CourierPrime-Bold.ttf"),
    ]);
    fontCache = {regular, bold};
    return fontCache;
}

/**
 * 1200x630 card. House style: warm off-white, black monospace, one blue rule,
 * the text is the art. `n` = {name, created_at, body, gid}.
 */
export async function noticeCard(env, n) {
    const {regular, bold} = await loadFonts(env);
    const text = firstSentences(n.body) || "(a blank notice)";
    const date = new Date((n.created_at || 0) * 1000).toISOString().slice(0, 10);
    // Long excerpts get smaller type so three sentences always fit the frame.
    const size = text.length > 180 ? 40 : text.length > 90 ? 48 : 58;

    const html = `
<div style="display:flex; flex-direction:column; width:1200px; height:630px; background:#FBFBF9; padding:56px 64px; font-family:'Courier Prime';">
  <div style="display:flex; justify-content:space-between; align-items:center;">
    <div style="display:flex; font-size:34px; letter-spacing:4px; color:#16181D; font-weight:700;">plaintext</div>
    <div style="display:flex; font-size:28px; color:#8A94A6;">~${txt(n.name || "?")} · ${date}</div>
  </div>
  <div style="display:flex; width:1072px; height:3px; background:#2D5FB6; margin-top:22px;"></div>
  <div style="display:flex; flex-grow:1; align-items:center;">
    <div style="display:flex; font-size:${size}px; line-height:1.45; color:#16181D;">${txt(text)}</div>
  </div>
  <div style="display:flex; justify-content:space-between; align-items:center;">
    <div style="display:flex; font-size:26px; color:#8A94A6;">notice #${Number(n.gid) || 0}</div>
    <div style="display:flex; font-size:26px; color:#8A94A6;">plaintext.numetal.xyz</div>
  </div>
</div>`;

    return new ImageResponse(html, {
        width: 1200,
        height: 630,
        fonts: [
            {name: "Courier Prime", data: regular, weight: 400, style: "normal"},
            {name: "Courier Prime", data: bold, weight: 700, style: "normal"},
        ],
    });
}
