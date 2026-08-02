import {extractWikilinks} from "./render.js";
/**
 * Log indexer.
 *
 * The public 4663 RPC disables eth_subscribe and eth_newFilter, so this polls
 * eth_getLogs on a cron. Verified 2026-07-19: the 10,000 cap is on LOG COUNT,
 * not block range — a single call spanning 2,000,000 blocks returned 6,190 logs
 * without complaint. Contract-scoped filters will not approach the cap.
 *
 * Chain is the source of truth. This only ever writes a cache.
 */

// keccak256 topic0s, computed from the compiled ABI (`cast keccak "<sig>"`) and
// cross-checked against out/Plaintext.sol/Plaintext.json — NOT hand-written.
// A wrong constant here fails silently: the indexer matches nothing and the
// board simply looks empty. Regenerate with site/scripts/topics.sh if the
// event signatures ever change.
export const TOPICS = {
    // Entered(address indexed hand, string name, bool chosen)
    Entered: "0x519e31bd449c35eb7a5eea6fae2ae58fb7a0abcf4820e29bc7c729df0c2b88cd",
    // Renamed(address indexed hand, string oldName, string newName)
    Renamed: "0xd68ae3eda53127e00f2c878c56025cbaac05ea145d1164c9fb1a9262d6515a05",
    // NameMoved(address indexed from, address indexed to, uint256 indexed tokenId, string name)
    // Emitted by the ETHEREUM names contract when a name NFT is sold/transferred —
    // identity follows the token, so the board moves the display name to the buyer.
    NameMoved: "0xb2aa12def30f1c01f09e4e7db42fea2659b3f9e6b12f5c96de915f1cd633b365",
    // Posted(address indexed hand, uint256 indexed id, uint256 indexed parent, string cid)
    Posted: "0x6c333a64127ff0c17fc2b929e4d52c19dabeec7c8ef020cd06faf1d0ad486820",
    // Tipped(address indexed from, address indexed to, uint256 indexed id, uint256 amount)
    Tipped: "0x2c2d3fe639ed09f250554d4c3efe2aed6ee4570a4a426c236d1f5a227aaa6c9e",
};

async function rpcCall(url, method, params) {
    // Time-boxed: a throttled/hanging RPC must fail fast, not eat the whole tick.
    const r = await fetch(url, {
        method: "POST",
        headers: {"content-type": "application/json"},
        body: JSON.stringify({jsonrpc: "2.0", id: 1, method, params}),
        signal: AbortSignal.timeout(8000),
    });
    if (!r.ok) throw new Error(`rpc ${method} http ${r.status}`);
    const j = await r.json();
    if (j.error) throw new Error(`rpc ${method}: ${j.error.message}`);
    return j.result;
}

export const rpc = (env, method, params) => rpcCall(env.RPC_URL, method, params);

const hexToInt = (h) => parseInt(h, 16);
const topicAddr = (t) => "0x" + t.slice(26).toLowerCase();
const topicInt = (t) => BigInt(t).toString();

/** Decode a single dynamic string from ABI-encoded event data at slot `argIndex`. */
function decodeString(dataHex, argIndex = 0) {
    const d = dataHex.startsWith("0x") ? dataHex.slice(2) : dataHex;
    const word = (i) => d.slice(i * 64, i * 64 + 64);
    const offset = Number(BigInt("0x" + word(argIndex))) / 32;
    const len = Number(BigInt("0x" + word(offset)));
    const bytes = d.slice((offset + 1) * 64, (offset + 1) * 64 + len * 2);
    const arr = new Uint8Array(len);
    for (let i = 0; i < len; i++) arr[i] = parseInt(bytes.substr(i * 2, 2), 16);
    return new TextDecoder().decode(arr);
}

function decodeBool(dataHex, argIndex) {
    const d = dataHex.startsWith("0x") ? dataHex.slice(2) : dataHex;
    return BigInt("0x" + d.slice(argIndex * 64, argIndex * 64 + 64)) !== 0n;
}

/**
 * The list of contracts the board indexes, OLDEST first — across CHAINS. Adding an
 * entry is how the board evolves without nuking old posts — the old contract keeps
 * being read. Comes from env.CONTRACTS (JSON `[{"a":"0x…","b":block,"r":"rpc?"}, …]`,
 * `r` optional — defaults to env.RPC_URL, i.e. Robinhood Chain; the Ethereum names
 * contract sets it). Falls back to the single env.CONTRACT for older configs.
 */
function contractList(env) {
    try {
        const list = JSON.parse(env.CONTRACTS || "[]");
        if (Array.isArray(list) && list.length) {
            return list.map((c) => ({
                address: String(c.a).toLowerCase(),
                block: Number(c.b) || 0,
                rpc: c.r || env.RPC_URL,
            }));
        }
    } catch {
        /* fall through */
    }
    if (env.CONTRACT && env.CONTRACT !== "0x") {
        return [{address: env.CONTRACT.toLowerCase(), block: Number(env.DEPLOY_BLOCK || 0), rpc: env.RPC_URL}];
    }
    return [];
}

/**
 * Pull new logs from every indexed contract (each on its own chain) into D1.
 * Per-contract FAILURE ISOLATION: one throttled RPC or bad range must never
 * starve the contracts after it in the list — each failure is reported and the
 * loop moves on. (Learned live: a rate-limited ETH RPC silently froze every
 * cursor that came after it, and new posts stopped appearing on the board.)
 */
export async function sync(env, {maxBlocks = 500_000} = {}) {
    const contracts = contractList(env);
    if (!contracts.length) return {skipped: "no contracts"};
    // Heads differ per chain, so resolve one per distinct RPC. A dead RPC marks
    // its contracts skipped for this tick — the next tick retries.
    const heads = new Map();
    for (const c of contracts) {
        if (heads.has(c.rpc)) continue;
        try {
            heads.set(c.rpc, hexToInt(await rpcCall(c.rpc, "eth_blockNumber", [])));
        } catch (err) {
            heads.set(c.rpc, null);
            console.error("sync head failed", c.rpc, err?.message);
        }
    }
    const results = [];
    for (const c of contracts) {
        const head = heads.get(c.rpc);
        if (head == null) {
            results.push({address: c.address, skipped: "rpc head unavailable"});
            continue;
        }
        try {
            results.push(await syncContract(env, c, head, maxBlocks));
        } catch (err) {
            results.push({address: c.address, error: err?.message ?? String(err)});
            console.error("sync contract failed", c.address, err?.message);
        }
    }
    return {contracts: results};
}

/**
 * Index one contract. Statements run SEQUENTIALLY (await each) rather than in a
 * batch, so a reply's parent — inserted earlier in the same pass — is already
 * committed when we resolve its gid. Every write is an idempotent upsert keyed on
 * chain-derived identity, so replaying a range changes nothing.
 */
async function syncContract(env, {address, block, rpc: rpcUrl}, head, maxBlocks) {
    const key = `logs:${address}`;
    const row = await env.DB.prepare("SELECT last_block FROM cursor WHERE k=?1").bind(key).first();
    const from = row ? row.last_block + 1 : block;
    if (from > head) return {address, upToDate: true};

    const to = Math.min(head, from + maxBlocks);
    const logs = await rpcCall(rpcUrl, "eth_getLogs", [
        {address, fromBlock: "0x" + from.toString(16), toBlock: "0x" + to.toString(16)},
    ]);

    // Block timestamps, fetched once per distinct block.
    const blocks = [...new Set(logs.map((l) => l.blockNumber))];
    const times = new Map();
    for (const b of blocks) {
        const blk = await rpcCall(rpcUrl, "eth_getBlockByNumber", [b, false]);
        times.set(b, hexToInt(blk.timestamp));
    }

    let entered = 0;
    let renamed = 0;
    let posted = 0;
    let tipped = 0;

    for (const log of logs) {
        const ts = times.get(log.blockNumber) ?? 0;
        const blockNo = hexToInt(log.blockNumber);
        const t0 = log.topics[0];

        if (t0 === TOPICS.Entered) {
            const addr = topicAddr(log.topics[1]);
            const name = decodeString(log.data, 0);
            const chosen = decodeBool(log.data, 1) ? 1 : 0;
            // An address can appear on multiple contract versions; the LATEST name
            // event (highest block) wins, so re-claims/renames on a newer contract
            // take precedence without ever un-showing the person.
            await env.DB.prepare(
                `INSERT INTO hands (address,name,chosen,entered_at,block,name_block,tx)
                 VALUES (?1,?2,?3,?4,?5,?5,?6)
                 ON CONFLICT(address) DO UPDATE SET
                   name=CASE WHEN excluded.name_block>=hands.name_block THEN excluded.name ELSE hands.name END,
                   chosen=CASE WHEN excluded.name_block>=hands.name_block THEN excluded.chosen ELSE hands.chosen END,
                   name_block=MAX(hands.name_block, excluded.name_block)`,
            )
                .bind(addr, name, chosen, ts, blockNo, log.transactionHash)
                .run();
            entered++;
        } else if (t0 === TOPICS.Renamed) {
            const addr = topicAddr(log.topics[1]);
            const newName = decodeString(log.data, 1); // arg 0 = old, arg 1 = new
            await env.DB.prepare("UPDATE hands SET name=?1, chosen=1, name_block=?2 WHERE address=?3 AND ?2>=name_block")
                .bind(newName, blockNo, addr)
                .run();
            renamed++;
        } else if (t0 === TOPICS.NameMoved) {
            // A name NFT was sold/transferred: identity follows the token. Drop the
            // seller's row (iff it still shows this name) and give the buyer the name.
            const fromA = topicAddr(log.topics[1]);
            const toA = topicAddr(log.topics[2]);
            const moved = decodeString(log.data, 0);
            await env.DB.prepare("DELETE FROM hands WHERE address=?1 AND name=?2").bind(fromA, moved).run();
            await env.DB.prepare(
                `INSERT INTO hands (address,name,chosen,entered_at,block,name_block,tx)
                 VALUES (?1,?2,1,?3,?4,?4,?5)
                 ON CONFLICT(address) DO UPDATE SET
                   name=CASE WHEN excluded.name_block>=hands.name_block THEN excluded.name ELSE hands.name END,
                   chosen=CASE WHEN excluded.name_block>=hands.name_block THEN 1 ELSE hands.chosen END,
                   name_block=MAX(hands.name_block, excluded.name_block)`,
            )
                .bind(toA, moved, ts, blockNo, log.transactionHash)
                .run();
            renamed++;
        } else if (t0 === TOPICS.Posted) {
            const addr = topicAddr(log.topics[1]);
            const tokenId = Number(BigInt(log.topics[2]));
            const parentToken = Number(BigInt(log.topics[3]));
            const cid = decodeString(log.data, 0);
            // parent_gid: 0 for a top-level notice, else the gid of the parent token
            // on THIS contract (already inserted earlier in this sequential pass).
            await env.DB.prepare(
                `INSERT INTO notices (contract,token_id,author,parent_gid,cid,created_at,block,tx)
                 VALUES (?1,?2,?3,
                   CASE WHEN ?4=0 THEN 0
                        ELSE COALESCE((SELECT gid FROM notices WHERE contract=?1 AND token_id=?4),0) END,
                   ?5,?6,?7,?8)
                 ON CONFLICT(contract,token_id) DO NOTHING`,
            )
                .bind(address, tokenId, addr, parentToken, cid, ts, blockNo, log.transactionHash)
                .run();
            posted++;
        } else if (t0 === TOPICS.Tipped) {
            const tokenId = Number(BigInt(log.topics[3]));
            const amount = BigInt(log.data).toString();
            await env.DB.prepare(
                `UPDATE notices SET tips_wei=CAST((CAST(tips_wei AS REAL)+CAST(?1 AS REAL)) AS TEXT)
                 WHERE contract=?2 AND token_id=?3`,
            )
                .bind(amount, address, tokenId)
                .run();
            tipped++;
        }
    }

    await env.DB.prepare("INSERT INTO cursor (k,last_block) VALUES (?1,?2) ON CONFLICT(k) DO UPDATE SET last_block=excluded.last_block")
        .bind(key, to)
        .run();

    return {address, from, to, entered, renamed, posted, tipped};
}

/**
 * Fetch notice bodies whose text we have a CID for but no local copy.
 * Runs after sync so a page view never waits on a gateway.
 */
export async function hydrate(env, limit = 20) {
    const {results} = await env.DB.prepare(
        "SELECT gid, cid FROM notices WHERE body IS NULL ORDER BY created_at DESC LIMIT ?1",
    )
        .bind(limit)
        .all();

    let ok = 0;
    for (const n of results ?? []) {
        try {
            // Prefer our own R2 store (where the write path puts bodies); fall back
            // to a public IPFS gateway for content pinned elsewhere.
            let body = null;
            const obj = await env.BODIES.get(n.cid);
            if (obj) {
                body = (await obj.text()).slice(0, 64_000);
            } else {
                const r = await fetch(`${env.IPFS_GATEWAY}/ipfs/${n.cid}`, {
                    cf: {cacheTtl: 3600},
                    signal: AbortSignal.timeout(8000),
                });
                if (!r.ok) continue;
                body = (await r.text()).slice(0, 64_000);
            }
            const title = (body.split("\n").find((l) => l.trim()) || "").replace(/^#+\s*/, "").slice(0, 120);
            await env.DB.prepare("UPDATE notices SET body=?1, title=?2 WHERE gid=?3").bind(body, title, n.gid).run();

            // Index this notice's wikilink edges for backlinks. `[[N]]` targets a
            // board gid; `[[title]]` a title. Raw key so a forward reference resolves
            // once its target appears. Hand links (~name) don't point at a notice.
            const edges = [];
            for (const t of extractWikilinks(body)) {
                if (/^\d+$/.test(t)) edges.push(["id", t]);
                else if (!/^~[a-z0-9-]{1,16}$/.test(t)) edges.push(["title", t.toLowerCase()]);
            }
            for (const [kind, keyv] of edges) {
                await env.DB.prepare(
                    "INSERT INTO links (src_gid,kind,key) VALUES (?1,?2,?3) ON CONFLICT(src_gid,kind,key) DO NOTHING",
                )
                    .bind(n.gid, kind, keyv.slice(0, 120))
                    .run();
            }
            ok++;
        } catch {
            // Leave body NULL; the next cron tries again.
        }
    }
    return {hydrated: ok};
}
