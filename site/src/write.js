/**
 * The write path — the only JavaScript in the product.
 *
 * A single self-contained page. No framework, no bundler, no CDN, no external
 * script of any kind: it talks to an injected EIP-1193 wallet (window.ethereum)
 * and reads the contract over the public RPC. Calldata is hand-encoded — the
 * four functions we call are simple enough that pulling in a library to sign a
 * wallet transaction (the one place supply-chain risk actually bites) is not
 * worth it.
 *
 * Selectors are hardcoded because the browser's Web Crypto has SHA-256 but not
 * keccak256; each was computed with `cast sig` and is checked in a comment.
 *
 * X / social login (Privy embedded wallets) is the next increment and needs the
 * Privy dashboard configured for this domain + chain 4663 — not shippable from
 * code alone, so it is deliberately absent here rather than half-wired.
 */

const SEL = {
    enter: "0xe97dcb62", //        enter()
    enterAs: "0xc603e4bf", //      enterAs(string)
    post: "0x8ee93cf3", //         post(string)
    reply: "0xd94c783a", //        reply(uint256,string)
    tip: "0xe8b69bc3", //          tip(uint256)
    nameOf: "0xf5c57382", //       nameOf(address)
    exempt: "0xf1320af2", //       exempt(address)
    doorAssignedWei: "0xc96b3578",
    doorChosenWei: "0x685eb8b5",
    noticeWei: "0x82f1fb59",
    remarkWei: "0x64a2fb5e",
};

// Rendered into an inline <script>. It is a template string, never sees server
// data except the JSON config object below, which is built from trusted vars.
function client(cfg) {
    return `
const CFG = ${JSON.stringify(cfg)};
const SEL = ${JSON.stringify(SEL)};
const $ = (id) => document.getElementById(id);
const enc = new TextEncoder();

function say(msg, kind) {
  const el = $("status");
  el.textContent = msg;
  el.className = kind || "";
}

// ─── tiny ABI helpers (only what these five functions need) ────────────────
const hex = (n) => n.toString(16);
const pad = (h) => h.replace(/^0x/, "").padStart(64, "0");
const addr32 = (a) => pad(a.toLowerCase().replace(/^0x/, ""));

function encStr(s) {
  const bytes = enc.encode(s);
  let data = "";
  for (const b of bytes) data += b.toString(16).padStart(2, "0");
  while (data.length % 64) data += "0";
  return pad(hex(bytes.length)) + data;
}
// dynamic string arg at position 0: head is offset 0x20
const argStr = (s) => pad("20") + encStr(s);

async function rpc(method, params) {
  const r = await fetch(CFG.rpc, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const j = await r.json();
  if (j.error) throw new Error(j.error.message);
  return j.result;
}

const call = (data) => rpc("eth_call", [{ to: CFG.contract, data }, "latest"]);

function decodeString(ret) {
  const d = ret.replace(/^0x/, "");
  if (d.length < 128) return "";
  const len = parseInt(d.slice(64, 128), 16);
  const bytes = d.slice(128, 128 + len * 2);
  const arr = new Uint8Array(len);
  for (let i = 0; i < len; i++) arr[i] = parseInt(bytes.substr(i * 2, 2), 16);
  return new TextDecoder().decode(arr);
}

// ─── wallet ─────────────────────────────────────────────────────────────────
let account = null;

async function connect() {
  if (!window.ethereum) {
    say("No wallet found. Install a browser wallet, or use a wallet's built-in browser.", "err");
    return;
  }
  try {
    const accts = await window.ethereum.request({ method: "eth_requestAccounts" });
    account = accts[0];
    await ensureChain();
    await refresh();
  } catch (e) {
    say(e.message || "Could not connect.", "err");
  }
}

async function ensureChain() {
  const want = "0x" + (CFG.chainId).toString(16);
  const cur = await window.ethereum.request({ method: "eth_chainId" });
  if (cur === want) return;
  try {
    await window.ethereum.request({ method: "wallet_switchEthereumChain", params: [{ chainId: want }] });
  } catch (e) {
    if (e.code === 4902) {
      await window.ethereum.request({
        method: "wallet_addEthereumChain",
        params: [{
          chainId: want,
          chainName: "Robinhood Chain",
          nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
          rpcUrls: [CFG.rpc],
          blockExplorerUrls: [CFG.explorer],
        }],
      });
    } else throw e;
  }
}

async function refresh() {
  say("Reading the chain…");
  const name = decodeString(await call(SEL.nameOf + addr32(account)));
  const exemptRet = await call(SEL.exempt + addr32(account));
  const free = BigInt(exemptRet) !== 0n;
  window.__free = free;

  $("who").textContent = account.slice(0, 6) + "…" + account.slice(-4) + (free ? "  (writes free)" : "");
  $("connect").style.display = "none";
  $("panel").style.display = "block";

  if (!name) { showDoor(free); return; }
  showCompose(name, free);
}

// ─── the door ─────────────────────────────────────────────────────────────
async function showDoor(free) {
  const dealt = free ? 0n : BigInt(await call(SEL.doorAssignedWei));
  const chosen = free ? 0n : BigInt(await call(SEL.doorChosenWei));
  $("panel").innerHTML =
    '<p class="t">You are not through the door yet.</p>' +
    '<p><button id="deal">' + (free ? "Enter free — name dealt to you" : "Enter for ~$1 — name dealt to you") + '</button></p>' +
    '<p><input id="chosen" placeholder="a name: a-z 0-9 -, up to 16" maxlength="16" autocapitalize="off" autocomplete="off"> ' +
    '<button id="pick">' + (free ? "Take it free" : "Take it for ~$5") + '</button></p>';
  $("deal").onclick = () => send(SEL.enter, free ? 0n : dealt, "Entering…");
  $("pick").onclick = () => {
    const h = $("chosen").value.trim().toLowerCase();
    if (!/^[a-z][a-z0-9-]{0,15}$/.test(h)) { say("Name must start with a letter; a-z 0-9 - only.", "err"); return; }
    send(SEL.enterAs + argStr(h), free ? 0n : chosen, "Taking the name…");
  };
}

// ─── writing ────────────────────────────────────────────────────────────────
async function showCompose(name, free) {
  const isReply = CFG.reply && /^[0-9]+$/.test(CFG.reply);
  const priceSel = isReply ? SEL.remarkWei : SEL.noticeWei;
  const price = free ? 0n : BigInt(await call(priceSel));
  const cost = free ? "free" : "~$" + (isReply ? "0.50" : "3.00");
  $("panel").innerHTML =
    '<p class="t">' + (isReply ? "replying to notice #" + CFG.reply : "writing as " + name) + " &middot; " + cost + '</p>' +
    '<textarea id="body" rows="12" placeholder="markdown, or nothing at all. the first line is the title."></textarea>' +
    '<p><button id="publish">' + (isReply ? "Post remark" : "Publish notice") + "</button></p>";
  $("publish").onclick = async () => {
    const text = $("body").value;
    if (!text.trim()) { say("Nothing to publish.", "err"); return; }
    try {
      say("Storing your text…");
      const r = await fetch("/pin", { method: "POST", body: text });
      if (!r.ok) throw new Error("could not store the text");
      const { cid } = await r.json();
      const data = isReply
        ? SEL.reply + pad(hex(BigInt(CFG.reply))) + pad("40") + encStr(cid)
        : SEL.post + argStr(cid);
      await send(data, price, "Confirm in your wallet…");
    } catch (e) { say(e.message || "Failed.", "err"); }
  };
}

// ─── send a transaction ──────────────────────────────────────────────────────
async function send(data, value, pending) {
  try {
    say(pending);
    const tx = { from: account, to: CFG.contract, data };
    if (value > 0n) tx.value = "0x" + value.toString(16);
    const hash = await window.ethereum.request({ method: "eth_sendTransaction", params: [tx] });
    say("Sent. Waiting for the chain…");
    await waitFor(hash);
    say("Done. It may take a minute to appear on the board.", "ok");
    setTimeout(() => (window.location.href = "/"), 2500);
  } catch (e) {
    const m = (e && (e.data && e.data.message)) || (e && e.message) || "Transaction failed.";
    say(m.includes("Underpaid") ? "You need ETH on Robinhood Chain to pay for this." : m, "err");
  }
}

async function waitFor(hash) {
  for (let i = 0; i < 60; i++) {
    const r = await rpc("eth_getTransactionReceipt", [hash]).catch(() => null);
    if (r) {
      if (BigInt(r.status) === 0n) throw new Error("The transaction reverted.");
      return;
    }
    await new Promise((res) => setTimeout(res, 500));
  }
}

$("connect-btn").onclick = connect;
`;
}

export function writePage({ nonce, cfg }) {
    const replyNote = cfg.reply ? ` — reply to #${cfg.reply}` : "";
    return {
        html: `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>write${replyNote} · plaintext</title>
<link rel="icon" type="image/png" href="/favicon.png">
<link rel="apple-touch-icon" href="/apple-touch-icon.png">
<link rel="stylesheet" href="/style.css">
<style nonce="${nonce}">
button{font:inherit;padding:.3rem .6rem;cursor:pointer}
#status{min-height:1.4em}
#status.err{color:#b00020}#status.ok{color:#1F437E}
@media(prefers-color-scheme:dark){#status.err{color:#ff6b81}#status.ok{color:#64ABF6}}
</style>
</head><body>
<p class="t"><a href="/">the board</a></p>
<h1>write${replyNote}</h1>
<p class="t">Connect a wallet on Robinhood Chain. You keep the token; the board keeps a copy.</p>
<div id="connect"><p><button id="connect-btn">Connect wallet</button></p></div>
<div id="panel" style="display:none"></div>
<p class="t" id="who"></p>
<p id="status"></p>
<div class="b"></div>
<p class="t">Reading is free. Writing costs what the manual says — settled in ETH, on chain 4663.
Nobody can change those prices. <a href="/manual">manual</a></p>
<script nonce="${nonce}">${client(cfg)}</script>
</body></html>`,
    };
}
