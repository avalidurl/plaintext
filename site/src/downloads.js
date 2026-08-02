/**
 * Per-notice downloads — the text you own, in the shape you want it:
 *   /dl/notice/<gid>.md    the raw body (text/markdown)
 *   /dl/notice/<gid>.pdf   a minimal, dependency-free PDF (Courier, paginated)
 *   /dl/notice/<gid>.epub  a minimal EPUB 3 (stored-zip, one chapter)
 *   /dl/notice/<gid>.png   the notice's card (same renderer as the OG image)
 *
 * Everything is generated in the Worker from the D1-cached body — no external
 * service, no browser rendering, nothing to keep alive. PDF uses the core
 * Courier font (WinAnsi): characters outside that encoding are transliterated
 * (ğ→g, ş→s, …) rather than dropped; the .md is always byte-faithful.
 */

const slug = (s) =>
    String(s ?? "notice")
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 48) || "notice";

const attach = (filename, type, body) =>
    new Response(body, {
        headers: {
            "content-type": type,
            "content-disposition": `attachment; filename="${filename}"`,
            "cache-control": "public, max-age=31536000, immutable",
        },
    });

export async function loadNotice(env, gid) {
    return env.DB.prepare(
        `SELECT n.gid, n.title, n.body, n.cid, n.created_at, h.name AS author
         FROM notices n LEFT JOIN hands h ON h.address = n.author WHERE n.gid = ?1`,
    )
        .bind(gid)
        .first();
}

// ── markdown ────────────────────────────────────────────────────────────────

export function mdResponse(n) {
    const meta = `<!-- plaintext.numetal.xyz/notices/${n.gid} · ~${n.author ?? "?"} · ${stampIso(n.created_at)} · ipfs ${n.cid} -->\n\n`;
    return attach(`${slug(n.title)}.md`, "text/markdown; charset=utf-8", meta + (n.body ?? ""));
}

const stampIso = (unix) => new Date((unix || 0) * 1000).toISOString().slice(0, 10);

// ── pdf (minimal, core Courier, WinAnsi) ────────────────────────────────────

/** Transliterate characters WinAnsi can't carry; keep the rest. */
function winAnsi(s) {
    const map = {
        ğ: "g", Ğ: "G", ş: "s", Ş: "S", ı: "i", İ: "I", "—": "-", "–": "-",
        "“": '"', "”": '"', "‘": "'", "’": "'", "…": "...", "→": "->", "←": "<-",
    };
    let out = "";
    for (const ch of String(s ?? "")) {
        if (map[ch] !== undefined) out += map[ch];
        else if (ch.charCodeAt(0) < 0x100) out += ch;
        else out += "?";
    }
    return out;
}

const pdfEscape = (s) => s.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");

/** Hard-wrap at `width` columns, preserving blank lines. */
function wrap(text, width = 78) {
    const out = [];
    for (const raw of String(text ?? "").replace(/\r\n?/g, "\n").split("\n")) {
        if (raw.length <= width) {
            out.push(raw);
            continue;
        }
        let line = raw;
        while (line.length > width) {
            let cut = line.lastIndexOf(" ", width);
            if (cut < width * 0.6) cut = width; // no good break — hard cut
            out.push(line.slice(0, cut));
            line = line.slice(cut).replace(/^ +/, "");
        }
        out.push(line);
    }
    return out;
}

export function pdfResponse(n) {
    const header = [`~${n.author ?? "?"} · ${stampIso(n.created_at)} · plaintext.numetal.xyz/notices/${n.gid}`, ""];
    const lines = header.concat(wrap(winAnsi(n.body ?? "")));
    const PER_PAGE = 54;
    const pages = [];
    for (let i = 0; i < lines.length; i += PER_PAGE) pages.push(lines.slice(i, i + PER_PAGE));
    if (!pages.length) pages.push([""]);

    // Objects: 1 catalog, 2 pages-tree, 3 font, then per page: page obj + content obj.
    const objs = [];
    const pageIds = pages.map((_, i) => 4 + i * 2);
    objs[1] = `<< /Type /Catalog /Pages 2 0 R >>`;
    objs[2] = `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${pages.length} >>`;
    objs[3] = `<< /Type /Font /Subtype /Type1 /BaseFont /Courier /Encoding /WinAnsiEncoding >>`;
    pages.forEach((pg, i) => {
        const pid = 4 + i * 2;
        const cid = pid + 1;
        const content =
            `BT /F1 10 Tf 12 TL 56 780 Td\n` +
            pg.map((l) => `(${pdfEscape(l)}) Tj T*`).join("\n") +
            `\nET`;
        objs[pid] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${cid} 0 R >>`;
        objs[cid] = {stream: content};
    });

    let out = "%PDF-1.4\n";
    const offsets = [0];
    for (let i = 1; i < objs.length; i++) {
        offsets[i] = out.length;
        const o = objs[i];
        if (o && typeof o === "object") {
            out += `${i} 0 obj\n<< /Length ${o.stream.length} >>\nstream\n${o.stream}\nendstream\nendobj\n`;
        } else {
            out += `${i} 0 obj\n${o}\nendobj\n`;
        }
    }
    const xref = out.length;
    out += `xref\n0 ${objs.length}\n0000000000 65535 f \n`;
    for (let i = 1; i < objs.length; i++) out += `${String(offsets[i]).padStart(10, "0")} 00000 n \n`;
    out += `trailer\n<< /Size ${objs.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
    return attach(`${slug(n.title)}.pdf`, "application/pdf", out);
}

// ── epub (minimal EPUB 3, stored zip) ───────────────────────────────────────

const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        t[n] = c >>> 0;
    }
    return t;
})();
function crc32(bytes) {
    let c = 0xffffffff;
    for (const b of bytes) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
}

/** STORED-only zip (no compression — EPUB readers accept it, and it's tiny code). */
function zipStore(entries) {
    const enc = new TextEncoder();
    const chunks = [];
    const central = [];
    let offset = 0;
    for (const [name, text] of entries) {
        const nameB = enc.encode(name);
        const data = enc.encode(text);
        const crc = crc32(data);
        const local = new Uint8Array(30 + nameB.length);
        const dv = new DataView(local.buffer);
        dv.setUint32(0, 0x04034b50, true);
        dv.setUint16(4, 20, true);
        dv.setUint32(14, crc, true);
        dv.setUint32(18, data.length, true);
        dv.setUint32(22, data.length, true);
        dv.setUint16(26, nameB.length, true);
        local.set(nameB, 30);
        chunks.push(local, data);
        const cent = new Uint8Array(46 + nameB.length);
        const cv = new DataView(cent.buffer);
        cv.setUint32(0, 0x02014b50, true);
        cv.setUint16(4, 20, true);
        cv.setUint16(6, 20, true);
        cv.setUint32(16, crc, true);
        cv.setUint32(20, data.length, true);
        cv.setUint32(24, data.length, true);
        cv.setUint16(28, nameB.length, true);
        cv.setUint32(42, offset, true);
        cent.set(nameB, 46);
        central.push(cent);
        offset += local.length + data.length;
    }
    const centralSize = central.reduce((a, c) => a + c.length, 0);
    const end = new Uint8Array(22);
    const ev = new DataView(end.buffer);
    ev.setUint32(0, 0x06054b50, true);
    ev.setUint16(8, central.length, true);
    ev.setUint16(10, central.length, true);
    ev.setUint32(12, centralSize, true);
    ev.setUint32(16, offset, true);
    const all = [...chunks, ...central, end];
    const total = all.reduce((a, c) => a + c.length, 0);
    const outB = new Uint8Array(total);
    let p = 0;
    for (const c of all) {
        outB.set(c, p);
        p += c.length;
    }
    return outB;
}

const xmlEsc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export function epubResponse(n) {
    const title = n.title || `notice #${n.gid}`;
    const paras = String(n.body ?? "")
        .replace(/\r\n?/g, "\n")
        .split(/\n{2,}/)
        .map((p) => `<p>${xmlEsc(p).replace(/\n/g, "<br/>")}</p>`)
        .join("\n");
    const date = new Date((n.created_at || 0) * 1000).toISOString().slice(0, 10);
    const uid = `urn:plaintext:notice:${n.gid}:${n.cid}`;
    const opf = `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="uid">
 <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
  <dc:identifier id="uid">${xmlEsc(uid)}</dc:identifier>
  <dc:title>${xmlEsc(title)}</dc:title>
  <dc:creator>~${xmlEsc(n.author ?? "?")}</dc:creator>
  <dc:language>en</dc:language>
  <meta property="dcterms:modified">${date}T00:00:00Z</meta>
 </metadata>
 <manifest>
  <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
  <item id="text" href="text.xhtml" media-type="application/xhtml+xml"/>
 </manifest>
 <spine><itemref idref="text"/></spine>
</package>`;
    const xhtml = (bodyInner, t) => `<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml"><head><title>${xmlEsc(t)}</title></head><body>${bodyInner}</body></html>`;
    const zip = zipStore([
        ["mimetype", "application/epub+zip"],
        ["META-INF/container.xml", `<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>`],
        ["OEBPS/content.opf", opf],
        ["OEBPS/nav.xhtml", xhtml(`<nav xmlns:epub="http://www.idpf.org/2007/ops" epub:type="toc"><ol><li><a href="text.xhtml">${xmlEsc(title)}</a></li></ol></nav>`, title)],
        ["OEBPS/text.xhtml", xhtml(`<h1>${xmlEsc(title)}</h1><p><i>~${xmlEsc(n.author ?? "?")} · ${date} · plaintext.numetal.xyz/notices/${n.gid}</i></p>\n${paras}`, title)],
    ]);
    return attach(`${slug(n.title)}.epub`, "application/epub+zip", zip);
}
