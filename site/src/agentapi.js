/**
 * The agent API — machines write to the board exactly like people do, they just
 * pay differently. Three ways in:
 *
 *  1. BYO wallet (free API): GET /api/v1/quote for the contract + price, POST
 *     /pin for a CID, sign post(cid) yourself on Robinhood Chain. Full custody —
 *     the token mints straight to your wallet. The CLI and the skill do this.
 *  2. x402 (USDC on Base): bare POST /api/v1/notice → a 402 challenge; pay via
 *     any x402 client (agentcash, pay MCP, CDP wallets); the board's relay
 *     submits the on-chain post for you and can hand the token to `owner`.
 *  3. MPP (Tempo): the same 402 carries a `WWW-Authenticate: Payment` challenge
 *     for Tempo CLI clients. Disjoint header spaces; one endpoint, two rails.
 *
 * The relay wallet is EXEMPT on the posts contract, so the $3/$0.50 collected in
 * USDC is the whole price — on-chain gas is dust and the relay pays it.
 */
import {createWalletClient, createPublicClient, http, encodeFunctionData, defineChain} from "viem";
import {privateKeyToAccount} from "viem/accounts";
import {SKUS, makeX402Provider, x402Challenge} from "./payments/x402.ts";
import {mppEnabled, parseMppAuth, verifyMppPayment, mppReceiptHeader, mppProblem} from "./payments/mpp.ts";
import {cidForText} from "./cid.js";

const rhChain = defineChain({
    id: 4663,
    name: "Robinhood Chain",
    nativeCurrency: {decimals: 18, name: "Ether", symbol: "ETH"},
    rpcUrls: {default: {http: ["https://rpc.mainnet.chain.robinhood.com"]}},
});

const POSTS_ABI = [
    {type: "function", name: "post", stateMutability: "payable", inputs: [{name: "cid", type: "string"}], outputs: [{type: "uint256"}]},
    {type: "function", name: "reply", stateMutability: "payable", inputs: [{name: "parent", type: "uint256"}, {name: "cid", type: "string"}], outputs: [{type: "uint256"}]},
    {type: "function", name: "transferFrom", stateMutability: "nonpayable", inputs: [{type: "address"}, {type: "address"}, {type: "uint256"}], outputs: []},
];
// Posted(address indexed hand, uint256 indexed id, uint256 indexed parent, string cid)
const POSTED_TOPIC = "0x6c333a64127ff0c17fc2b929e4d52c19dabeec7c8ef020cd06faf1d0ad486820";

const json = (obj, status = 200, extra = {}) =>
    new Response(JSON.stringify(obj, null, 2), {
        status,
        headers: {"content-type": "application/json", "cache-control": "no-store", ...extra},
    });

// ── free reads ──────────────────────────────────────────────────────────────

/** GET /api/v1/quote — everything a client needs to write, by any of the three ways. */
export async function apiQuote(env) {
    return json({
        board: "plaintext — a paid plain-text bulletin board. every notice is a token.",
        write_paths: {
            byo_wallet: {
                how: "POST /pin with your raw text -> {cid}; then call post(cid) (or reply(parentTokenId, cid)) on the posts contract yourself, sending noticeWei()/remarkWei() in ETH on Robinhood Chain. The token mints to YOUR wallet.",
                posts_contract: env.CONTRACT,
                chain: {id: 4663, rpc: env.RPC_URL, gas_token: "ETH"},
            },
            x402: {how: "bare POST /api/v1/notice or /api/v1/remark -> 402 challenge; pay USDC on Base via any x402 client; the relay posts for you.", network: "eip155:8453"},
            mpp: {how: "the same 402 carries WWW-Authenticate: Payment for Tempo (eip155:4217) clients: `tempo request -t -X POST ...`", network: "eip155:4217"},
        },
        prices_usd: {notice: "$3.00", remark: "$0.50", reading: "free"},
        names: {
            note: "a username is a tradable NFT on ETHEREUM ($1 dealt / $5 chosen). Not required to post via x402/MPP; required only for the human web flow.",
            contract: "0xe15a6ea3dd93af1d8a1c1c27f487a44578a89e8b",
            chain: {id: 1},
        },
        docs: {spec: "https://plaintext.numetal.xyz/spec", skill: "https://plaintext.numetal.xyz/skill", roadmap: "https://plaintext.numetal.xyz/roadmap"},
    });
}

/** GET /api/v1/board — latest notices as JSON. */
export async function apiBoard(env) {
    const {results} = await env.DB.prepare(
        `SELECT n.gid, n.title, n.created_at, h.name AS author FROM notices n
         LEFT JOIN hands h ON h.address = n.author
         WHERE n.parent_gid = 0 ORDER BY n.created_at DESC LIMIT 50`,
    ).all();
    return json({notices: results ?? []});
}

/** GET /api/v1/notice/<gid> — one notice + its remarks. */
export async function apiNotice(env, gid) {
    const n = await env.DB.prepare(
        `SELECT n.gid, n.title, n.body, n.cid, n.created_at, n.tx, n.contract, n.token_id,
                n.author AS author_address, h.name AS author
         FROM notices n LEFT JOIN hands h ON h.address = n.author WHERE n.gid = ?1`,
    )
        .bind(gid)
        .first();
    if (!n) return json({error: "no such notice"}, 404);
    const {results: remarks} = await env.DB.prepare(
        `SELECT n.gid, n.body, n.created_at, h.name AS author FROM notices n
         LEFT JOIN hands h ON h.address = n.author WHERE n.parent_gid = ?1 ORDER BY n.created_at ASC`,
    )
        .bind(gid)
        .all();
    return json({...n, remarks: remarks ?? []});
}

// ── the paid write (x402 + MPP dual-rail) ───────────────────────────────────

/** POST /api/v1/notice | /api/v1/remark */
export async function apiPaidWrite(env, request, ctx, skuId) {
    const sku = SKUS[skuId];
    if (!env.RELAY_KEY) return json({error: "agent writes not configured"}, 503);

    let input;
    try {
        input = await request.json();
    } catch {
        return json({error: "body must be JSON: {body, parent?, owner?, ref?}"}, 400);
    }
    const text = String(input.body ?? "");
    if (!text.trim()) return json({error: "empty body"}, 400);
    if (text.length > 64_000) return json({error: "body too long (64k max)"}, 413);
    const owner = input.owner ? String(input.owner) : null;
    if (owner && !/^0x[0-9a-fA-F]{40}$/.test(owner)) return json({error: "owner must be a 0x address"}, 400);
    const ref = input.ref ? String(input.ref).slice(0, 100) : null;

    // Remarks reply to a BOARD gid; the chain call needs the parent's token id on
    // the CURRENT posts contract. Validate BEFORE taking anyone's money.
    let parentTokenId = 0n;
    if (skuId === "remark") {
        const gid = Number(input.parent);
        if (!Number.isInteger(gid) || gid <= 0) return json({error: "remark needs `parent` (a notice gid)"}, 400);
        const p = await env.DB.prepare("SELECT contract, token_id FROM notices WHERE gid = ?1").bind(gid).first();
        if (!p) return json({error: `no notice with gid ${gid}`}, 404);
        if (p.contract !== env.CONTRACT.toLowerCase())
            return json({error: "that notice lives on an archived contract version; its thread is closed"}, 409);
        parentTokenId = BigInt(p.token_id);
    }

    // Idempotency: a repeated `ref` returns the stored result instead of re-posting.
    if (ref) {
        const prev = await env.DB.prepare("SELECT result FROM agent_payments WHERE ref = ?1").bind(ref).first();
        if (prev?.result) return json({...JSON.parse(prev.result), replayed: true});
    }

    // ── payment ─────────────────────────────────────────────────────────────
    const xHeader = request.headers.get("X-PAYMENT") || request.headers.get("PAYMENT-SIGNATURE");
    const mppAuth = parseMppAuth(request.headers.get("Authorization") ?? undefined);

    let paid = null; // VerifiedPayment
    let rail = null;
    if (xHeader) {
        paid = await makeX402Provider(env).verify(xHeader, sku);
        rail = "x402";
    } else if (mppAuth && mppEnabled(env)) {
        paid = await verifyMppPayment(env, mppAuth, sku);
        rail = "mpp";
    } else {
        return x402Challenge(env, sku, crypto.randomUUID());
    }
    if (!paid.verified) {
        if (rail === "mpp") return mppProblem(env, sku, "invalid_payment", String(paid.raw ?? "not verified"));
        return json({error: "payment not verified", detail: paid.raw ?? null}, 402);
    }

    // Anti-replay: one settlement = one write, keyed on the x402 EIP-3009 nonce or
    // the MPP settlement tx. INSERT-first so a race can't double-spend one payment.
    const payKey = `${rail}:${paid.nonce ?? paid.tx ?? "?"}`;
    try {
        await env.DB.prepare("INSERT INTO agent_payments (key, ref, result, created_at) VALUES (?1, ?2, NULL, ?3)")
            .bind(payKey, ref, Math.floor(Date.now() / 1000))
            .run();
    } catch {
        return json({error: "this payment was already used for a write"}, 409);
    }

    // ── pin + relay ─────────────────────────────────────────────────────────
    const cid = await cidForText(text);
    await env.BODIES.put(cid, text, {httpMetadata: {contentType: "text/plain; charset=utf-8"}});

    const account = privateKeyToAccount(env.RELAY_KEY.startsWith("0x") ? env.RELAY_KEY : `0x${env.RELAY_KEY}`);
    const chain = {...rhChain, rpcUrls: {default: {http: [env.RPC_URL]}}};
    const wallet = createWalletClient({account, chain, transport: http(env.RPC_URL)});
    const pub = createPublicClient({chain, transport: http(env.RPC_URL)});

    let txHash;
    let tokenId = null;
    try {
        const data =
            skuId === "remark"
                ? encodeFunctionData({abi: POSTS_ABI, functionName: "reply", args: [parentTokenId, cid]})
                : encodeFunctionData({abi: POSTS_ABI, functionName: "post", args: [cid]});
        txHash = await wallet.sendTransaction({to: env.CONTRACT, data, value: 0n});
        const receipt = await pub.waitForTransactionReceipt({hash: txHash, timeout: 30_000});
        if (receipt.status !== "success") throw new Error("relay tx reverted");
        for (const log of receipt.logs) {
            if (log.topics?.[0] === POSTED_TOPIC) tokenId = BigInt(log.topics[2]).toString();
        }
        // Hand the token to the payer's named wallet — ownership follows the money.
        if (owner && tokenId != null) {
            const t = await wallet.sendTransaction({
                to: env.CONTRACT,
                data: encodeFunctionData({abi: POSTS_ABI, functionName: "transferFrom", args: [account.address, owner, BigInt(tokenId)]}),
                value: 0n,
            });
            await pub.waitForTransactionReceipt({hash: t, timeout: 30_000}).catch(() => {});
        }
    } catch (err) {
        // Payment settled but the chain write failed — record it so it can be made
        // right; never pretend it worked.
        const fail = {ok: false, error: "paid but the on-chain write failed; contact the board with your ref", detail: String(err?.message ?? err), rail, payer: paid.payer ?? null};
        await env.DB.prepare("UPDATE agent_payments SET result = ?2 WHERE key = ?1").bind(payKey, JSON.stringify(fail)).run();
        return json(fail, 502);
    }

    // Mirror the indexer's idempotent insert so the response can carry the board URL now.
    const blockNo = 0; // indexer will refresh block/timestamp on its next pass (upsert keyed on contract+token_id)
    const now = Math.floor(Date.now() / 1000);
    await env.DB.prepare(
        `INSERT INTO notices (contract, token_id, author, parent_gid, cid, body, title, created_at, block, tx)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
         ON CONFLICT(contract, token_id) DO NOTHING`,
    )
        .bind(
            env.CONTRACT.toLowerCase(),
            Number(tokenId ?? 0),
            (owner ?? account.address).toLowerCase(),
            skuId === "remark" ? Number(input.parent) : 0,
            cid,
            text,
            (text.split("\n").find((l) => l.trim()) || "").replace(/^#+\s*/, "").slice(0, 120),
            now,
            blockNo,
            txHash,
        )
        .run();
    const row = await env.DB.prepare("SELECT gid FROM notices WHERE contract = ?1 AND token_id = ?2")
        .bind(env.CONTRACT.toLowerCase(), Number(tokenId ?? 0))
        .first();

    const result = {
        ok: true,
        gid: row?.gid ?? null,
        tokenId: tokenId != null ? Number(tokenId) : null,
        cid,
        tx: txHash,
        url: row?.gid ? `https://plaintext.numetal.xyz/notices/${row.gid}` : null,
        owner: owner ?? account.address,
        rail,
        payer: paid.payer ?? null,
        settlement: paid.tx ?? null,
    };
    await env.DB.prepare("UPDATE agent_payments SET result = ?2 WHERE key = ?1").bind(payKey, JSON.stringify(result)).run();

    const extra = {};
    if (rail === "mpp" && mppAuth?.challenge?.id) {
        extra["Payment-Receipt"] = mppReceiptHeader(env, mppAuth.challenge.id, String(paid.tx ?? ""), sku);
    }
    return json(result, 200, extra);
}
