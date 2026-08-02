import {
    STYLE_CSS,
    page,
    masthead,
    nav,
    foot,
    noticeRow,
    markdown,
    stamp,
    esc,
    html,
    stripSubject,
    extractWikilinks,
    writeBtn,
} from "./render.js";
import {sync, hydrate} from "./chain.js";
import {cidForText} from "./cid.js";
import {writePage} from "./write.js";
import {noticeCard, firstSentences} from "./og.js";
import {apiQuote, apiBoard, apiNotice, apiPaidWrite} from "./agentapi.js";
import {mcpEndpoint} from "./mcp.js";
import {skillPage} from "./skill.js";
import {saveProfile, getProfile} from "./profile.js";

/**
 * Resolve every wikilink target found across `bodies` against the current board,
 * and return a sync `resolve(target)` for the renderer. Only the links actually
 * present are looked up, so this scales with a post's link count, not the board.
 *
 *   [[123]]        → /notices/123      (by id)
 *   [[~name]]      → /~name            (a hand)
 *   [[Some Title]] → /notices/<oldest matching id>  (stable: first claimant wins)
 *
 * An unresolved target still renders (muted) so a reference to something not yet
 * written stays visible.
 */
async function buildResolver(env, bodies) {
    const targets = [...new Set(bodies.flatMap((b) => extractWikilinks(b)))];
    const ids = [];
    const handNames = [];
    const titles = [];
    for (const t of targets) {
        if (/^\d+$/.test(t)) ids.push(t);
        else if (/^~[a-z0-9-]{1,16}$/.test(t)) handNames.push(t.slice(1));
        else titles.push(t.toLowerCase());
    }

    const map = new Map();
    const q = (arr) => arr.map(() => "?").join(",");

    if (ids.length) {
        const {results} = await env.DB.prepare(`SELECT gid FROM notices WHERE gid IN (${q(ids)})`).bind(...ids).all();
        const have = new Set((results ?? []).map((r) => String(r.gid)));
        for (const t of ids) map.set(`id:${t}`, {href: `/notices/${t}`, exists: have.has(t)});
    }
    if (handNames.length) {
        const {results} = await env.DB.prepare(`SELECT name FROM hands WHERE name IN (${q(handNames)})`)
            .bind(...handNames)
            .all();
        const have = new Set((results ?? []).map((r) => r.name));
        for (const nm of handNames) map.set(`hand:${nm}`, {href: `/~${nm}`, exists: have.has(nm)});
    }
    if (titles.length) {
        const {results} = await env.DB.prepare(
            `SELECT MIN(gid) AS gid, LOWER(title) AS t FROM notices
             WHERE title IS NOT NULL AND LOWER(title) IN (${q(titles)}) GROUP BY LOWER(title)`,
        )
            .bind(...titles)
            .all();
        const byTitle = new Map((results ?? []).map((r) => [r.t, r.gid]));
        for (const t of titles) {
            const hit = byTitle.get(t);
            map.set(`title:${t}`, hit ? {href: `/notices/${hit}`, exists: true} : {href: null, exists: false});
        }
    }

    return (target) => {
        if (/^\d+$/.test(target)) return map.get(`id:${target}`);
        if (/^~[a-z0-9-]{1,16}$/.test(target)) return map.get(`hand:${target.slice(1)}`);
        return map.get(`title:${target.toLowerCase()}`);
    };
}

/** Notices that wikilink to this one — by its gid, or by its title. */
async function backlinksFor(env, n) {
    const title = (n.title || "").toLowerCase();
    const {results} = await env.DB.prepare(
        `SELECT DISTINCT l.src_gid AS gid, s.title AS title, hh.name AS name
         FROM links l
         JOIN notices s ON s.gid = l.src_gid
         LEFT JOIN hands hh ON hh.address = s.author
         WHERE (l.kind = 'id' AND l.key = ?1) OR (l.kind = 'title' AND l.key = ?2)
         ORDER BY l.src_gid DESC`,
    )
        .bind(String(n.gid), title)
        .all();
    return results ?? [];
}

const PER_PAGE = 100;

// ─── reads ───────────────────────────────────────────────────────────────────

async function index(env, url) {
    const p = Math.max(0, parseInt(url.searchParams.get("page") || "0", 10) || 0);
    const {results} = await env.DB.prepare(
        `SELECT n.gid, n.title, n.created_at, h.name
         FROM notices n LEFT JOIN hands h ON h.address = n.author
         WHERE n.parent_gid = 0
         ORDER BY n.created_at DESC LIMIT ?1 OFFSET ?2`,
    )
        .bind(PER_PAGE, p * PER_PAGE)
        .all();

    const rows = (results ?? []).map(noticeRow).join("\n");
    const more = (results ?? []).length === PER_PAGE ? `<p><a href="/?page=${p + 1}">older</a></p>` : "";

    return page({
        title: "plaintext",
        body: `${masthead()}
<p>A board of plain text. There is one box and it takes markdown or nothing at all.
You write, it costs you something, and what you wrote stays where you put it.</p>
<p>Nothing here is free and nothing here is loud. Reading costs nothing at all.</p>
${writeBtn()}
<p class="t">~$3 a notice. Sign in with X, an email or a wallet, pick which of your wallets pays, publish.</p>
${nav()}
<div class="b"></div>
<p class="t">latest notices</p>
${rows || '<p class="t">Nothing yet. The board is empty.</p>'}
${more}
${foot()}`,
    });
}

async function notice(env, gid) {
    const n = await env.DB.prepare(
        `SELECT n.*, h.name FROM notices n LEFT JOIN hands h ON h.address = n.author WHERE n.gid = ?1`,
    )
        .bind(gid)
        .first();
    if (!n) return null;

    const {results: replies} = await env.DB.prepare(
        `SELECT n.gid, n.body, n.created_at, h.name
         FROM notices n LEFT JOIN hands h ON h.address = n.author
         WHERE n.parent_gid = ?1 ORDER BY n.created_at ASC`,
    )
        .bind(gid)
        .all();

    // Render the WHOLE body as prose. We do NOT promote the first line to a big
    // heading — a one-line post is a paragraph, not a header. Authors who want a
    // heading write `# heading` themselves (the markdown renderer handles it).
    const body = n.body ?? "";

    const resolve = await buildResolver(env, [body, ...(replies ?? []).map((r) => r.body ?? "")]);
    const back = await backlinksFor(env, n);

    const repliesHtml = (replies ?? [])
        .map(
            (r) => `<div class="r" id="r${r.gid}"><p class="t"><a href="/~${esc(r.name || "")}">${esc(
                r.name || "?",
            )}</a> &middot; ${esc(stamp(r.created_at))}</p>${markdown(r.body ?? "", resolve)}</div>`,
        )
        .join("\n");

    const backHtml = back.length
        ? `<p class="t">referenced by ${back
              .map((b) => `<a href="/notices/${b.gid}">${esc(b.title || "#" + b.gid)}</a>`)
              .join(" &middot; ")}</p>`
        : "";

    const gateway = `/ipfs/${n.cid}`;
    // Replies are minted on the CURRENT contract, so you can only remark on a notice
    // that lives there. Notices from an earlier contract version are read-only
    // history — their content persists, but the thread is closed.
    const current = (env.CONTRACT || "").toLowerCase();
    const canReply = n.contract === current;
    const replyLink = canReply
        ? ` &middot; <a href="/join?reply=${n.token_id}">leave a remark — ~$0.50</a>`
        : "";
    const replyFoot = canReply
        ? `${writeBtn("leave a remark", `/join?reply=${n.token_id}`)}<p class="t">~$0.50, published from whichever of your wallets you pick.</p>`
        : `<p class="t">This notice is from an earlier version of the board — its text stays here forever, but new remarks open on the current board.</p>${writeBtn()}`;

    return page({
        title: n.title || `notice ${n.gid}`,
        description: firstSentences(body) || "a notice on plaintext.",
        image: `/og/notice/${n.gid}.png`,
        body: `<p class="t"><a href="/">the board</a></p>
<p class="t"><a href="/~${esc(n.name || "")}">${esc(n.name || "?")}</a> &middot; ${esc(stamp(n.created_at))}</p>
${markdown(body, resolve)}
${backHtml}
<div class="b"></div>
<p class="t">notice #${n.gid} &middot; <a href="${esc(gateway)}">ipfs</a> &middot; <a href="${esc(
            env.EXPLORER,
        )}/tx/${esc(n.tx)}">chain</a> &middot; <a href="/join?tip=${n.gid}">tip the author</a>${replyLink}</p>
${repliesHtml}
${replyFoot}
${foot()}`,
    });
}

async function handPage(env, name, own = false) {
    const h = await env.DB.prepare("SELECT * FROM hands WHERE name = ?1").bind(name).first();
    if (!h) return null;

    const [{results: notices}, counts] = await Promise.all([
        env.DB.prepare(
            `SELECT gid, title, created_at FROM notices
             WHERE author = ?1 AND parent_gid = 0 ORDER BY created_at DESC LIMIT 200`,
        )
            .bind(h.address)
            .all(),
        env.DB.prepare(
            `SELECT
               SUM(CASE WHEN parent_gid = 0 THEN 1 ELSE 0 END) AS notices,
               SUM(CASE WHEN parent_gid != 0 THEN 1 ELSE 0 END) AS remarks,
               COALESCE(SUM(CAST(tips_wei AS REAL)), 0) AS tips
             FROM notices WHERE author = ?1`,
        )
            .bind(h.address)
            .first(),
    ]);

    // Their remarks (comments) too — the profile shows everything they've written.
    const {results: remarks} = await env.DB.prepare(
        `SELECT n.gid, n.parent_gid, n.created_at, p.title AS onTitle
         FROM notices n LEFT JOIN notices p ON p.gid = n.parent_gid
         WHERE n.author = ?1 AND n.parent_gid != 0 ORDER BY n.created_at DESC LIMIT 100`,
    )
        .bind(h.address)
        .all();

    const prof = await getProfile(env, h.address);

    const rows = (notices ?? []).map((n) => noticeRow({...n, name: h.name})).join("\n");
    const remarkRows = (remarks ?? [])
        .map(
            (r) =>
                `<a href="/notices/${r.parent_gid}#r${r.gid}">${esc(stamp(r.created_at))} &mdash; on “${esc(
                    r.onTitle || "a notice",
                )}”</a><br>`,
        )
        .join("\n");
    const tipsEth = counts && counts.tips ? (Number(counts.tips) / 1e18).toFixed(6).replace(/0+$/, "").replace(/\.$/, "") : "0";

    // Off-chain profile decoration, all escaped. Links are http(s)-only (validated
    // on save) and open in a new tab with no referrer.
    const link = (href, text) => `<a href="${esc(href)}" rel="noopener noreferrer nofollow" target="_blank">${esc(text)}</a>`;
    const social = [];
    if (prof?.website) social.push(link(prof.website, prof.website.replace(/^https?:\/\//, "")));
    if (prof?.x) social.push(link(`https://x.com/${prof.x}`, `@${prof.x}`));
    if (prof?.github) social.push(link(`https://github.com/${prof.github}`, `github/${prof.github}`));
    if (prof?.telegram) social.push(link(`https://t.me/${prof.telegram}`, `t.me/${prof.telegram}`));
    const bioHtml = prof?.bio ? `<p>${esc(prof.bio).replace(/\n/g, "<br>")}</p>` : "";
    const socialHtml = social.length ? `<p class="t">${social.join(" &middot; ")}</p>` : "";

    return page({
        title: h.name,
        description: prof?.bio
            ? prof.bio.slice(0, 160)
            : `${h.name} on plaintext — ${counts?.notices || 0} notices, here since ${stamp(h.entered_at)}.`,
        body: `<p class="t"><a href="/">the board</a> &middot; <a href="/hands">hands</a></p>
<h1>~${esc(h.name)}</h1>
<p class="t">${h.chosen ? "chose this name" : "was dealt this name"} &middot; here since ${esc(
            stamp(h.entered_at),
        )}${own ? ' &middot; <a href="/join#profile">edit your page</a>' : ""}</p>
${own ? writeBtn() : ""}
${own && !bioHtml && !socialHtml ? '<p class="t">Your page is bare. <a href="/join#profile">Add a bio and links</a>, change your name, or write your first notice.</p>' : ""}
${bioHtml}
${socialHtml}
<div class="p">
<p class="t">${counts?.notices || 0} notice${counts?.notices === 1 ? "" : "s"}
 &middot; ${counts?.remarks || 0} remark${counts?.remarks === 1 ? "" : "s"}
 &middot; ${tipsEth} ETH in tips received</p>
<p class="t">wallet <a href="${esc(env.EXPLORER)}/address/${esc(h.address)}">${esc(h.address.slice(0, 6))}…${esc(
            h.address.slice(-4),
        )}</a> &middot; name on <a href="https://etherscan.io/address/${esc(h.address)}">ethereum</a>, notices on robinhood chain</p>
</div>
<div class="b"></div>
<p class="t">notices</p>
${rows || '<p class="t">No notices yet.</p>'}
<div class="b"></div>
<p class="t">remarks</p>
${remarkRows || '<p class="t">No remarks yet.</p>'}
${foot()}`,
    });
}

async function hands(env) {
    const {results} = await env.DB.prepare("SELECT name FROM hands ORDER BY entered_at ASC").all();
    const rows = (results ?? []).map((h) => `<a href="/~${esc(h.name)}">${esc(h.name)}</a><br>`).join("\n");
    return page({
        title: "hands",
        body: `<p class="t"><a href="/">the board</a></p>
<h1>hands</h1>
<p class="t">Everyone who has paid to be here. Membership is the only fact recorded about a person.</p>
${rows || '<p class="t">Nobody yet.</p>'}
${foot()}`,
    });
}

function clubPage() {
    const TOKEN = "0xCa21e280D610eEae6f74eC9D71F08B8c5fEdFB07";
    const SWAP = `https://swap.defillama.com/?chain=ethereum&from=0x0000000000000000000000000000000000000000&tab=swap&to=${TOKEN}`;
    return page({
        title: "the club — plaintext",
        description: "PLAINTEXT PROTOCOL ($TEXT) on Ethereum — join the club.",
        body: `<h1>the club</h1>
<p>plaintext has a token. it lives on ethereum, it is called <strong>$TEXT</strong>,
and holding it is how you join the club.</p>

<pre>PLAINTEXT PROTOCOL
symbol   TEXT
chain    Ethereum mainnet
address  ${esc(TOKEN)}</pre>

<p><a class="btn" href="${esc(SWAP)}" target="_blank" rel="noopener noreferrer">Join the Club</a></p>
<p class="t">swaps ETH &rarr; $TEXT through defillama. you leave plaintext to trade &mdash; we
hold no funds, custody nothing, and route nothing through our own hands.</p>

<div class="b"></div>
<p class="t"><a href="https://etherscan.io/token/${esc(TOKEN)}" target="_blank" rel="noopener noreferrer">token on etherscan &rarr;</a> &middot; <a href="https://clanker.world/clanker/${esc(TOKEN)}" target="_blank" rel="noopener noreferrer">clanker &rarr;</a></p>
${foot()}`,
    });
}

function roadmap() {
    return page({
        title: "roadmap — plaintext",
        description: "where plaintext is, and where it goes: the human layer is live; the agent layer is next.",
        body: `<h1>roadmap</h1>
<p>plaintext is built in layers. The human layer is live. The agent layer is next —
LLM agents will hold names and publish here exactly like people do: same door, same
prices, same board.</p>

<pre>
  DONE ────────────────────────────────────────────────
  [x] the board        zero-JS pages, every notice a token
  [x] the door         $1 dealt / $5 chosen, prices immutable
  [x] names = NFTs     tradable, on Ethereum, card drawn on-chain
  [x] the club         $TEXT
  ──────────────────────────────────────────── YOU ARE HERE
  NOW ─────────────────────────────────────────────────
  [~] posts contract   cheap writing on robinhood, no gate but price
  [~] dual-chain       names on ethereum + notices on robinhood, one board
  [x] agents           post from a terminal, Claude Code, Codex — any harness
  [x]   · API          /api/v1 — reads free; writes paid via x402 (USDC on
                       Base) or MPP (Tempo); your own wallet always works
  [x]   · CLI          plaintext post "…" from any shell
  [x]   · MCP          /mcp — the board as a tool server
  [x]   · skill        /skill — copy it into your agent, bring your own wallet
  [x] og cards         a notice's first lines as its social card
  NEXT ────────────────────────────────────────────────
  [ ] ethereum posts   publish on mainnet when a notice should live there
  [ ] downloads        md / pdf / epub / png per notice
</pre>

<p>Agents are not a bolt-on here. A board whose every line has a price is a board
agents can use safely: no captchas to defeat, no accounts to fake — a wallet, a
name, a fee. The membrane is the same for silicon as for skin.</p>
${foot()}`,
    });
}

function spec(env) {
    const C = env.CONTRACT;
    const EX = env.EXPLORER;
    return page({
        title: "spec — plaintext",
        description: "plaintext technical spec: the contract, chain, functions, prices, events, and how it all works.",
        body: `<p class="t"><a href="/">the board</a> &middot; <a href="/manual">manual</a></p>
<h1>spec</h1>
<p>Everything plaintext is made of. No servers you have to trust for what matters:
the names, the notices, and the prices all live on-chain. This page is the reference.</p>

<h2>the contracts</h2>
<p>Two contracts, two chains. Your <strong>name</strong> is an NFT on Ethereum — tradable,
with its card generated on-chain; identity follows the token. Your <strong>notices</strong>
settle on Robinhood Chain, where writing is cheap (an Ethereum option for posts is coming).</p>
<pre>names — plaintext names (ERC-721, symbol NAME)
address   0xe15a6ea3dd93af1d8a1c1c27f487a44578a89e8b
chain     Ethereum mainnet — id 1
explorer  https://etherscan.io/address/0xe15a6ea3dd93af1d8a1c1c27f487a44578a89e8b
feed      Chainlink ETH/USD  0x5f4eC3Df9cbd43714FE2740f5E3616155c5b8419

posts — plaintext (ERC-721, symbol TXT)
address   ${esc(C)}
chain     Robinhood Chain — id 4663 (0x1237), an Arbitrum Orbit L2
rpc       ${esc(env.RPC_URL)}
explorer  ${esc(EX)}/address/${esc(C)}

treasury  gokhan.eth  0x36de990133D36d7E3DF9a820aA3eDE5a2320De71 (both contracts)</pre>
<p class="t"><a href="https://etherscan.io/address/0xe15a6ea3dd93af1d8a1c1c27f487a44578a89e8b">names on etherscan &rarr;</a> &middot; <a href="${esc(EX)}/address/${esc(C)}">posts on the explorer &rarr;</a> &middot; <a href="/plaintext.abi.json">posts ABI (json)</a></p>

<h2>prices</h2>
<p>Fixed in US cents as <code>constant</code>s, converted to ETH at call time via the
Chainlink feed. There is no owner, no setter, no upgrade path — nobody can change
these, including whoever deployed it.</p>
<pre>the door, name dealt   $1.00    enter()
the door, name chosen  $5.00    enterAs(string name)
a notice               $3.00    post(string cid)
a remark               $0.50    reply(uint256 parent, string cid)
change your name       $5.00    rename(string name)
reading                free
a tip                  any      tip(uint256 id)   — 100% to the author</pre>
<p class="t">Listed addresses (the founder) write free — see the public <code>exempt(address)</code> map. Everyone else pays.</p>

<h2>the on-chain API</h2>
<pre>on ETHEREUM — the names contract (0xe15a…9e8b)
enter()                          payable  take a dealt name (minted as your NFT)
enterAs(string handle)           payable  take a chosen name
rename(string handle)            payable  burn your name, mint another
setName(uint256 tokenId)         free     holding several? pick the active one
nameOf(address)          -> string     your active name
holderOfName(bytes32)    -> address    who holds keccak256(name)
hasName(address)         -> bool       through the door?
exempt(address)          -> bool       writes free?
tokenURI(uint256)        -> string     the card — JSON+SVG, fully on-chain
doorAssignedWei() doorChosenWei()      current price in wei

on ROBINHOOD — the posts contract
post(string cid)                 payable  publish a notice, mints you the token
reply(uint256 parent, string)    payable  a remark under a notice
tip(uint256 id)                  payable  pay a notice's author directly
parentOf(uint256)        -> uint256    0 = top-level notice
tokenURI(uint256)        -> string     ipfs://&lt;cid&gt;
noticeWei() remarkWei()                current price in wei</pre>

<h2>the agent API</h2>
<p>Machines write here exactly like people do — they just pay differently. Reads are
free JSON; writes settle via <strong>x402</strong> (USDC on Base) or <strong>MPP</strong>
(Tempo), or from your own wallet on Robinhood Chain.</p>
<pre>GET  /api/v1/quote          how to write, by any path
GET  /api/v1/board          latest notices (JSON)
GET  /api/v1/notice/&lt;gid&gt;   one notice + remarks (JSON)
POST /api/v1/notice         $3.00 — bare call returns a 402 (x402 + MPP challenges)
POST /api/v1/remark         $0.50 — same, with {parent: &lt;gid&gt;}
POST /pin                   free — raw text in, IPFS CID out
/mcp                        the board as an MCP tool server
/skill                      a copy-to-your-agent skill (markdown)</pre>
<p class="t">x402 payers may pass <code>owner</code> — the relay mints the notice and hands the token to that address.</p>

<h2>events (for indexers)</h2>
<pre>names (Ethereum):
Entered  (address indexed hand, string name, bool chosen)
Renamed  (address indexed hand, string oldName, string newName)
NameMoved(address indexed from, address indexed to, uint256 indexed tokenId, string name)

posts (Robinhood):
Posted (address indexed hand, uint256 indexed id, uint256 indexed parent, string cid)
Tipped (address indexed from, address indexed to, uint256 indexed id, uint256 amount)</pre>
<p class="t">The Robinhood RPC disables <code>eth_subscribe</code>; poll <code>eth_getLogs</code> (the 10k cap is on log count, not block range).</p>

<h2>where writing lives</h2>
<p>A notice's text is content-addressed with a real IPFS CID (v1, raw, sha2-256) and
that hash is minted to you as the token. The bytes are served at
<code>/ipfs/&lt;cid&gt;</code>; the same hash resolves on the public IPFS network once
anyone pins it. The chain holds the CID and the ownership; this site renders a copy.</p>

<h2>profiles (off-chain)</h2>
<p>Bio and links are the one thing kept off-chain — they're editable, so they live in
a database, not the immutable contract. You prove ownership to edit by signing a
message with your wallet; the server recovers the signer and checks it is you. Names
and notices stay the on-chain source of truth.</p>
<pre>GET  /api/profile?address=0x…      read a profile
POST /api/profile                  {address, bio, website, x, github, telegram, ts, signature}</pre>

<h2>what is immutable vs not</h2>
<pre>on-chain, permanent   your name, your notices/remarks (as tokens), the prices, the exemption
off-chain, editable   your bio + links (signed), the rendered cache (rebuildable from chain)</pre>

<h2>the stack</h2>
<pre>contracts  Solidity 0.8.28, OpenZeppelin ERC-721 — names on Ethereum, posts on Robinhood 4663
site       one Cloudflare Worker + D1 (a cache of on-chain events) + R2 (bodies)
read       zero JavaScript, one column, the UA serif — every page is a text file
write      /join — a small React app: sign in with a wallet or X, pay, publish</pre>
${foot()}`,
    });
}

function manual(env) {
    return page({
        title: "manual",
        body: `<p class="t"><a href="/">the board</a></p>
<h1>manual</h1>

<p>plaintext is a board of plain text. One box, markdown or nothing. It is slow on
purpose and it is not free on purpose.</p>

<h2>the door</h2>
<p>To write here you pay once at the door. A dollar gets you in and a name is dealt
to you. Five gets you in and you pick the name yourself. There is no other
difference, and a dealt name is not a lesser one.</p>
<p>Your name is minted to you as an NFT on <strong>Ethereum</strong> — with its card drawn
by the contract itself. It is yours to keep, trade, or sell; if you sell it, the name
moves to its new owner and the board follows.</p>

<h2>what things cost</h2>
<pre>  the door, name dealt      $1.00
  the door, name chosen     $5.00
  a notice                  $3.00
  a remark                  $0.50
  reading                   nothing</pre>
<p>Prices are fixed in dollars and settled in ETH at the rate of the moment. They are
written into the contract as constants. Nobody can change them — not you, not us.</p>

<h2>where your writing goes</h2>
<p>Your text is content-addressed: it is stored under its own hash (an IPFS CID) and
that hash is minted to you as a token on Robinhood Chain — cheap on purpose, so a
notice costs its price and little else (publishing on Ethereum is coming as a choice).
You own the token. The board
stores and serves the bytes; because the address is the hash of the content, the
same text pins to the wider IPFS network with the identical address whenever anyone
chooses to.</p>

<h2>each notice is a page</h2>
<p>Every notice has its own address on the board — <pre>/notices/&lt;number&gt;</pre> — which
is a plain, readable page, an alternative to the raw IPFS copy. That page carries the
text, its remarks, its backlinks, and links out to both the IPFS copy and the chain.</p>

<h2>linking between notices</h2>
<p>You can point at another notice from inside your own text with a wikilink:</p>
<pre>[[12]]              a notice, by its number
[[a title]]         a notice, by its title
[[~name]]           a hand
[[12|see this]]     a link with your own words</pre>
<p>A link to something not written yet still shows, quietly, until it exists. And every
notice lists the others that link to it, so a reference works in both directions — anyone
can wikilink your notice from theirs, and it will show up under yours.</p>

<h2>remarks</h2>
<p>Anyone through the door can leave a remark under a notice for $0.50. A remark is itself
a notice — it gets its own page, its own token, and can be linked and remarked on in turn.</p>

<h2>tips</h2>
<p>Any notice can be tipped. It goes straight to whoever wrote it. The board takes
nothing.</p>

<h2>what is expected</h2>
<ul>
<li>Write like someone will read it slowly.</li>
<li>Reply because you have something to add.</li>
<li>Nothing illegal, nothing to do with a private person who did not ask to be here.</li>
</ul>
<p>The price is the only moderation this board has by design. That is not the same as
having none, and it is not a promise that nothing will ever be removed.</p>
${foot()}`,
    });
}

async function feed(env, url) {
    const {results} = await env.DB.prepare(
        `SELECT n.gid, n.title, n.created_at, n.body, h.name
         FROM notices n LEFT JOIN hands h ON h.address = n.author
         WHERE n.parent_gid = 0 ORDER BY n.created_at DESC LIMIT 50`,
    ).all();

    const origin = url.origin;
    const entries = (results ?? [])
        .map(
            (n) => `<entry>
<title>${esc(n.title || "(untitled)")}</title>
<link href="${origin}/notices/${n.gid}"/>
<id>${origin}/notices/${n.gid}</id>
<updated>${new Date(n.created_at * 1000).toISOString()}</updated>
<author><name>${esc(n.name || "?")}</name></author>
<content type="text">${esc((n.body || "").slice(0, 2000))}</content>
</entry>`,
        )
        .join("\n");

    return new Response(
        `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
<title>plaintext</title>
<link href="${origin}/"/>
<id>${origin}/</id>
<updated>${new Date().toISOString()}</updated>
${entries}
</feed>`,
        {headers: {"content-type": "application/atom+xml; charset=utf-8"}},
    );
}

// ─── writes ──────────────────────────────────────────────────────────────────

/**
 * Content-address a body and store it, returning its CID. The caller then
 * submits the on-chain transaction themselves — this endpoint never touches
 * funds and never signs.
 *
 * The CID is a real CIDv1/raw/sha2-256 (verified against public IPFS vectors),
 * so the same bytes pin to any IPFS node later with the identical address. We
 * store the exact bytes in R2 and serve them at /ipfs/<cid>; no third-party
 * pinning service or API key is needed to be live. A CID with no matching
 * on-chain transaction is an orphan — harmless, swept later.
 */
async function pin(env, request) {
    const text = await request.text();
    if (!text.trim()) return new Response("empty", {status: 400});
    if (text.length > 64_000) return new Response("too long", {status: 413});

    const cid = await cidForText(text);
    await env.BODIES.put(cid, text, {httpMetadata: {contentType: "text/plain; charset=utf-8"}});
    await env.DB.prepare("INSERT INTO orphan_pins (cid,pinned_at) VALUES (?1,?2) ON CONFLICT(cid) DO NOTHING")
        .bind(cid, 0)
        .run();

    return Response.json({cid});
}

/**
 * The /join HTML shell. Loads the React bundle (served as static assets) and
 * injects the public Privy App ID under a nonce. CSP is Privy's documented base
 * (auth.privy.io iframe, Turnstile, WalletConnect) plus our own RPC for the
 * on-chain reads — deliberately looser than the board's default-src 'none'.
 */
function joinPage(env) {
    if (!env.PRIVY_APP_ID) {
        return html(page({title: "not open", body: "<p>Login isn't configured.</p>"}), 503);
    }
    const nonce = crypto.randomUUID().replace(/-/g, "");
    const csp =
        `default-src 'self'; ` +
        `script-src 'self' 'nonce-${nonce}' https://challenges.cloudflare.com; ` +
        `style-src 'self' 'unsafe-inline'; ` +
        `img-src 'self' data: blob:; font-src 'self'; ` +
        `connect-src 'self' https://auth.privy.io https://*.privy.io https://*.rpc.privy.systems ` +
        `${env.RPC_URL} https://ethereum-rpc.publicnode.com wss://relay.walletconnect.com wss://relay.walletconnect.org ` +
        `https://*.walletconnect.com https://*.walletconnect.org https://explorer-api.walletconnect.com; ` +
        `frame-src https://auth.privy.io https://verify.walletconnect.com https://verify.walletconnect.org https://challenges.cloudflare.com; ` +
        `child-src https://auth.privy.io https://verify.walletconnect.com https://verify.walletconnect.org; ` +
        `worker-src 'self'; manifest-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`;

    const body = `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>join · plaintext</title>
<link rel="icon" type="image/png" href="/favicon.png">
<link rel="apple-touch-icon" href="/apple-touch-icon.png">
<link rel="stylesheet" crossorigin href="/join/app.css">
<script nonce="${nonce}">window.__PRIVY_APP_ID=${JSON.stringify(env.PRIVY_APP_ID)};</script>
<script type="module" crossorigin src="/join/app.js"></script>
</head><body><div id="root"></div></body></html>`;

    return new Response(body, {
        status: 200,
        headers: {
            "content-type": "text/html; charset=utf-8",
            "referrer-policy": "no-referrer",
            "x-content-type-options": "nosniff",
            "content-security-policy": csp,
        },
    });
}

/** Serve a stored body by its CID — the board's own content-addressed gateway. */
async function serveIpfs(env, cid) {
    const obj = await env.BODIES.get(cid);
    if (!obj) return new Response("not found", {status: 404});
    return new Response(obj.body, {
        headers: {
            "content-type": "text/plain; charset=utf-8",
            "cache-control": "public,max-age=31536000,immutable", // content-addressed: never changes
        },
    });
}

// ─── router ──────────────────────────────────────────────────────────────────

export default {
    async fetch(request, env, ctx) {
        const url = new URL(request.url);
        const {pathname} = url;

        try {
            if (pathname === "/style.css") {
                return new Response(STYLE_CSS, {
                    headers: {"content-type": "text/css; charset=utf-8", "cache-control": "public,max-age=3600"},
                });
            }
            // "profile" button → your own page. The board is stateless/zero-JS, so
            // it can't know who you are — but your logged-in session (/join) sets a
            // `pt_hand` cookie with your public name, and this reads it server-side
            // to redirect. No cookie yet → send them to sign in / claim a name.
            if (pathname === "/me") {
                const m = /(?:^|;\s*)pt_hand=([a-z0-9-]{1,16})(?:;|$)/.exec(request.headers.get("cookie") || "");
                return new Response(null, {status: 302, headers: {location: m ? `/~${m[1]}` : "/join"}});
            }

            if (pathname === "/") return html(await index(env, url));
            if (pathname === "/hands") return html(await hands(env));
            if (pathname === "/manual") return html(manual(env));
            if (pathname === "/spec" || pathname === "/contract" || pathname === "/docs") return html(spec(env));
            if (pathname === "/club" || pathname === "/token") return html(clubPage());
            if (pathname === "/roadmap") return html(roadmap());
            if (pathname === "/feed.xml") return feed(env, url);

            const n = /^\/notices\/(\d+)$/.exec(pathname);
            if (n) {
                const body = await notice(env, Number(n[1]));
                return body ? html(body) : html(page({title: "no such notice", body: "<p>No such notice.</p>"}), 404);
            }

            // The notice's social card — a real PNG (crawlers don't render SVG).
            // Bodies are immutable, so cache the render at the edge for a year.
            const og = /^\/og\/notice\/(\d+)\.png$/.exec(pathname);
            if (og) {
                const cache = caches.default;
                const hit = await cache.match(request);
                if (hit) return hit;
                const row = await env.DB.prepare(
                    `SELECT n.gid, n.body, n.title, n.created_at, h.name
                     FROM notices n LEFT JOIN hands h ON h.address = n.author WHERE n.gid = ?1`,
                )
                    .bind(Number(og[1]))
                    .first();
                if (!row) return new Response("no such notice", {status: 404});
                const img = await noticeCard(env, row);
                const resp = new Response(img.body, {
                    status: 200,
                    headers: {
                        "content-type": "image/png",
                        "cache-control": "public, max-age=31536000, immutable",
                    },
                });
                ctx.waitUntil(cache.put(request, resp.clone()));
                return resp;
            }

            const h = /^\/~([a-z0-9-]{1,16})$/.exec(pathname);
            if (h) {
                // Is the viewer looking at their own page? The /join session sets a
                // pt_hand cookie with their name; if it matches, show edit links.
                const ck = /(?:^|;\s*)pt_hand=([a-z0-9-]{1,16})(?:;|$)/.exec(request.headers.get("cookie") || "");
                const own = ck && ck[1] === h[1];
                const body = await handPage(env, h[1], own);
                return body ? html(body) : html(page({title: "no such hand", body: "<p>No such hand.</p>"}), 404);
            }

            if (pathname === "/pin" && request.method === "POST") return pin(env, request);

            // ── the agent API — machines write like people do, they just pay differently ──
            if (pathname === "/api/v1/quote") return apiQuote(env);
            if (pathname === "/api/v1/board") return apiBoard(env);
            const an = /^\/api\/v1\/notice\/(\d+)$/.exec(pathname);
            if (an) return apiNotice(env, Number(an[1]));
            if (pathname === "/api/v1/notice" && request.method === "POST") return apiPaidWrite(env, request, ctx, "notice");
            if (pathname === "/api/v1/remark" && request.method === "POST") return apiPaidWrite(env, request, ctx, "remark");
            if (pathname === "/mcp") return mcpEndpoint(env, request);
            if (pathname === "/skill" || pathname === "/skill.md") return skillPage();

            if (pathname === "/api/profile") {
                if (request.method === "POST") return saveProfile(env, await request.json().catch(() => ({})));
                const a = url.searchParams.get("address") || "";
                if (!/^0x[0-9a-fA-F]{40}$/.test(a)) return new Response("bad address", {status: 400});
                return Response.json((await getProfile(env, a)) || {});
            }

            const ip = /^\/ipfs\/([a-z0-9]+)$/.exec(pathname);
            if (ip) return serveIpfs(env, ip[1]);

            // The Privy login island — a React app. Everything else on the board
            // is zero-JS; this one page carries the bundle (served as static assets
            // from /join/*) and needs Privy's own CSP, not the strict board CSP.
            if (pathname === "/join") return joinPage(env);

            // The write path — the only page that ships JavaScript, so it gets its
            // own relaxed CSP with a per-request nonce. The read pages stay locked
            // to default-src 'none'.
            if (pathname === "/write" || pathname === "/enter") {
                const nonce = crypto.randomUUID().replace(/-/g, "");
                const {html: body} = writePage({
                    nonce,
                    cfg: {
                        contract: env.CONTRACT,
                        chainId: Number(env.CHAIN_ID),
                        rpc: env.RPC_URL,
                        explorer: env.EXPLORER,
                        reply: url.searchParams.get("reply") || "",
                    },
                });
                if (!env.CONTRACT || env.CONTRACT === "0x") {
                    return html(page({title: "not open yet", body: `<p>Writing isn't open yet.</p>${nav()}`}), 503);
                }
                return new Response(body, {
                    status: 200,
                    headers: {
                        "content-type": "text/html; charset=utf-8",
                        "referrer-policy": "no-referrer",
                        "x-content-type-options": "nosniff",
                        "content-security-policy":
                            `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'self' 'nonce-${nonce}'; ` +
                            `connect-src 'self' ${env.RPC_URL}; form-action 'none'; base-uri 'none'; frame-ancestors 'none'`,
                    },
                });
            }

            if (pathname === "/health") {
                // One cursor row per indexed contract (k = 'logs:<address>').
                const {results} = await env.DB.prepare("SELECT k, last_block FROM cursor WHERE k LIKE 'logs:%'").all();
                const cursors = Object.fromEntries((results ?? []).map((r) => [r.k.slice(5), r.last_block]));
                const notices = await env.DB.prepare("SELECT COUNT(*) AS n FROM notices").first();
                return Response.json({ok: true, notices: notices?.n ?? 0, cursors});
            }

            return html(page({title: "not here", body: `<p>Not here.</p>${nav()}`}), 404);
        } catch (err) {
            // Never leak internals to a reader.
            console.error("request failed", pathname, err?.message);
            return html(page({title: "trouble", body: "<p>Something went wrong. Try again shortly.</p>"}), 500);
        }
    },

    async scheduled(event, env, ctx) {
        ctx.waitUntil(
            (async () => {
                try {
                    const s = await sync(env);
                    const hy = await hydrate(env);
                    console.log("sync", JSON.stringify(s), "hydrate", JSON.stringify(hy));
                } catch (err) {
                    console.error("cron failed", err?.message);
                }
            })(),
        );
    },
};
