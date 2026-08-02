import {STYLE, MASTHEAD} from "./style.js";

export const esc = (s) =>
    String(s ?? "").replace(/[&<>"']/g, (c) => ({"&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"})[c]);

/**
 * The page shell. Two HTTP requests total: this document and the stylesheet.
 * No JavaScript on any read path — not analytics, not fonts, not embeds.
 */
const ORIGIN = "https://plaintext.numetal.xyz";
const TAGLINE = "a board of plain text. one box, markdown or nothing, a price on every line.";

export function page({title, body, head = "", description = TAGLINE}) {
    return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title>
<meta name="description" content="${esc(description)}">
<link rel="icon" type="image/png" href="/favicon.png">
<link rel="apple-touch-icon" href="/apple-touch-icon.png">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(description)}">
<meta property="og:image" content="${ORIGIN}/og.png">
<meta property="og:type" content="website">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:image" content="${ORIGIN}/og.png">
<link rel="stylesheet" href="/style.css">
<link rel="alternate" type="application/atom+xml" href="/feed.xml">
${head}
</head><body>
<div class="topbar"><a class="home" href="/">plaintext</a><a class="btn" href="/join">write a notice</a></div>
${body}
</body></html>`;
}

export const masthead = () => `<pre>${esc(MASTHEAD)}</pre>`;

export const nav = () => `<p class="t"><a href="/">the board</a> &middot; <a href="/hands">hands</a> &middot; <a href="/me">profile</a> &middot; <a href="/manual">manual</a> &middot; <a href="/join">write</a></p>`;

export const foot = () =>
    `<div class="b"></div><p class="t"><a href="/me">profile</a> &middot; <a href="/join">write</a> &middot; <a href="/hands">hands</a> &middot; <a href="/manual">manual</a> &middot; <a href="/spec">spec</a> &middot; <a href="/club">the club</a> &middot; <a href="/roadmap">roadmap</a> &middot; <a href="/feed.xml">feed</a> &middot; every name is an ethereum NFT &middot; every notice a token onchain</p>`;

/**
 * The one loud affordance on an otherwise quiet board. It is a plain <a> — the
 * read pages ship no JavaScript, so the button leads to /join (the only page
 * that carries the wallet code) rather than trying to be the write box itself.
 */
export const writeBtn = (label = "write a notice", href = "/join") =>
    `<p><a class="btn" href="${esc(href)}">${esc(label)}</a></p>`;

const pad = (n) => String(n).padStart(2, "0");
export function stamp(unix) {
    const d = new Date(unix * 1000);
    return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

/**
 * Notices render as flat dated rows. Links are standalone block lines, never
 * inline in prose — that constraint is what makes a page look like a text file.
 */
export function noticeRow(n) {
    const t = n.title || "(untitled)";
    return `<a href="/notices/${n.gid}">${esc(stamp(n.created_at))} ${esc(n.name || "?")} &mdash; ${esc(t)}</a><br>`;
}

const WIKILINK = /\[\[([^\]\n]+)\]\]/g;

/** `[[target]]` or `[[target|label]]` → {target, label}. */
function parseWikilink(inner) {
    const pipe = inner.indexOf("|");
    if (pipe >= 0) return {target: inner.slice(0, pipe).trim(), label: inner.slice(pipe + 1).trim() || inner.slice(0, pipe).trim()};
    const t = inner.trim();
    return {target: t, label: t};
}

/** Every wikilink target present in a body — for backlink indexing. */
export function extractWikilinks(src) {
    const out = [];
    const s = String(src ?? "");
    WIKILINK.lastIndex = 0;
    let m;
    while ((m = WIKILINK.exec(s))) out.push(parseWikilink(m[1]).target);
    return out;
}

/**
 * Escape a line of text AND turn `[[…]]` into links. `resolve(target)` returns
 * `{href, exists}` or null; an unresolved link still renders (as a muted span)
 * so a reference to a not-yet-written post is visible, Obsidian-style. Labels and
 * hrefs are both escaped; hrefs are always internal paths built by the resolver,
 * never raw user text — so this cannot emit unescaped or off-site input.
 */
function inline(text, resolve) {
    const s = String(text ?? "");
    let out = "";
    let last = 0;
    WIKILINK.lastIndex = 0;
    let m;
    while ((m = WIKILINK.exec(s))) {
        out += esc(s.slice(last, m.index));
        const {target, label} = parseWikilink(m[1]);
        const r = resolve && resolve(target);
        out += r && r.href
            ? `<a href="${esc(r.href)}"${r.exists ? "" : ' class="wl-new"'}>${esc(label)}</a>`
            : `<span class="wl-new">${esc(label)}</span>`;
        last = m.index + m[0].length;
    }
    out += esc(s.slice(last));
    return out;
}

/**
 * Deliberately minimal markdown. Block constructs only: headings, quotes,
 * bullets, fenced code, paragraphs — plus `[[wikilinks]]` inline. Everything is
 * escaped before any markup is added, so this cannot emit unescaped user input.
 * `resolve` is optional; without it, wikilinks render as plain muted text.
 */
export function markdown(src, resolve) {
    const lines = String(src ?? "").replace(/\r\n?/g, "\n").split("\n");
    const out = [];
    let para = [];
    let list = false;
    let code = false;
    let codeBuf = [];

    const flushPara = () => {
        if (para.length) {
            out.push(`<p>${para.map((l) => inline(l, resolve)).join("<br>")}</p>`);
            para = [];
        }
    };
    const flushList = () => {
        if (list) {
            out.push("</ul>");
            list = false;
        }
    };

    for (const line of lines) {
        if (line.trimEnd() === "```") {
            if (code) {
                out.push(`<pre>${esc(codeBuf.join("\n"))}</pre>`);
                codeBuf = [];
                code = false;
            } else {
                flushPara();
                flushList();
                code = true;
            }
            continue;
        }
        if (code) {
            codeBuf.push(line);
            continue;
        }

        const h = /^(#{1,3})\s+(.*)$/.exec(line);
        const q = /^>\s?(.*)$/.exec(line);
        const li = /^[-*]\s+(.*)$/.exec(line);

        if (h) {
            flushPara();
            flushList();
            const lvl = h[1].length;
            out.push(`<h${lvl}>${inline(h[2], resolve)}</h${lvl}>`);
        } else if (q) {
            flushPara();
            flushList();
            out.push(`<blockquote>${inline(q[1], resolve)}</blockquote>`);
        } else if (li) {
            flushPara();
            if (!list) {
                out.push("<ul>");
                list = true;
            }
            out.push(`<li>${inline(li[1], resolve)}</li>`);
        } else if (line.trim() === "") {
            flushPara();
            flushList();
        } else {
            para.push(line);
        }
    }
    if (code && codeBuf.length) out.push(`<pre>${esc(codeBuf.join("\n"))}</pre>`);
    flushPara();
    flushList();
    return out.join("\n");
}

/**
 * The first non-empty line of a notice IS its subject — that is where `title`
 * comes from. Drop it from the rendered body so the page does not say the same
 * thing twice, once as an <h1> and again as a paragraph.
 */
export function stripSubject(body) {
    const lines = String(body ?? "").replace(/\r\n?/g, "\n").split("\n");
    let i = 0;
    while (i < lines.length && lines[i].trim() === "") i++;
    if (i < lines.length) i++; // drop the subject line itself
    while (i < lines.length && lines[i].trim() === "") i++;
    return lines.slice(i).join("\n");
}

export function html(body, status = 200, extra = {}) {
    return new Response(body, {
        status,
        headers: {
            "content-type": "text/html; charset=utf-8",
            "referrer-policy": "no-referrer",
            "x-content-type-options": "nosniff",
            "content-security-policy":
                "default-src 'none'; style-src 'self'; img-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
            ...extra,
        },
    });
}

export const STYLE_CSS = STYLE;
