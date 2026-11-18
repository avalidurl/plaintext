/**
 * MPP (Machine Payments Protocol) — the Tempo Labs + Stripe HTTP-402 standard
 * (IETF draft-httpauth-payment-00 + draft-tempo-charge-00). Second payment rail
 * next to x402: ONE 402, disjoint headers — x402 rides PAYMENT-REQUIRED, MPP rides
 * `WWW-Authenticate: Payment …`; the paid retry arrives as `Authorization: Payment
 * <b64url credential>` and success carries a `Payment-Receipt` header.
 *
 * Two submission modes, chosen PER SKU (the mode rides inside the HMAC-bound `request` JSON,
 * so it can't be swapped by a tampering client):
 *  - PUSH (supportedModes:["push"]) — agent_ask: the client broadcasts its own TIP-20 transfer
 *    on Tempo (chainId 4217) and hands us the tx hash; we verify the on-chain Transfer log. Safe
 *    only where payment == one delivery and NO bearer credential is minted — a public tx hash
 *    proves a transfer landed, NOT that the caller controls the paying wallet.
 *  - PULL (supportedModes:["pull"]) — chat_topup: the client signs (but does NOT broadcast) a
 *    type-0x76 Tempo transaction and hands us the signed RLP. We deserialize it, verify the
 *    transfer terms, RECOVER the signer from the signature (secp256k1) and cross-check it equals
 *    the tx `from` — that recovery is cryptographic proof the caller controls the paying wallet,
 *    so it is safe to bind a bearer SESSION to the recovered address (top-up mints a session).
 *    We then broadcast (eth_sendRawTransaction, feePayer:false → the client pays its own gas, so
 *    we hold ZERO hot keys) and gate on the CONFIRMED on-chain receipt, never the broadcast.
 *
 * v1 scope:
 *  - method "tempo", intent "charge". All live agent paid SKUs offer MPP (push except chat_topup
 *    pull). Policy-refusal paths AFTER payment (featured board full, chaperone block) still apply —
 *    MPP verify is fail-closed before delivery; refunds for post-pay refusals are a separate policy.
 *  - No fee-payer key: pull mode is feePayer:false (the signer pays its own gas). No hot keys.
 *  - Dark until MPP_ENABLED + MPP_SECRET_KEY are set (recipient defaults to PAY_TO).
 *
 * Challenge ids are HMAC-bound over `realm|method|intent|request|expires|digest|opaque`
 * (empty string for absent slots) with a per-challenge nonce inside `opaque`, so terms
 * can't be swapped and ids are stateless-verifiable yet unique. Single-use is enforced
 * at the route ledger on BOTH the challenge id and the settlement tx hash.
 */
import { decodeFunctionData, keccak256, parseAbi } from "viem";
import * as Tempo from "viem/tempo";
import type { Env } from "../env";
import type { Sku, VerifiedPayment } from "./x402";

// USDC on Tempo mainnet (TIP-20; the token AgentCash-class wallets hold and the one the
// Base→Tempo bridge mints — verified on the live bridge 2026-07-03). Runtime-overridable.
export const TEMPO_USDC = "0x20c000000000000000000000b9537d11c60e8b50";
export const TEMPO_CHAIN_ID = 4217; // Tempo mainnet (testnet Moderato = 42431)
export const MPP_NETWORK = `eip155:${TEMPO_CHAIN_ID}`; // CAIP-2, for the settle ledger
const DEFAULT_TEMPO_RPC = "https://rpc.tempo.xyz";
// keccak("Transfer(address,address,uint256)") — TIP-20 emits the standard event.
const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const CHALLENGE_TTL_MS = 10 * 60 * 1000;

// TIP-20 value-moving calls a pull-mode payment tx may make against the currency token (draft-tempo
// §3, §5.2): the ERC-20 `transfer` + Tempo's `transferWithMemo`. ANY other call in the batch — or
// a `transfer` to some other token — is rejected (only the transfer to us may touch value, §7.2).
const TIP20_TRANSFER_ABI = parseAbi([
  "function transfer(address to, uint256 amount)",
  "function transferWithMemo(address to, uint256 amount, bytes32 memo)",
]);

/**
 * SKUs that offer the MPP rail at all (either mode). All live agent paid surfaces except catalog-only
 * placeholders (date_brief, priority_cycle — no route handlers yet).
 */
export const MPP_SKUS = new Set(["notice", "remark"]);

/**
 * SKUs served in PULL mode. chat_topup mints a bearer SESSION, so push mode (a PUBLIC tx hash ≠
 * proof the caller controls the paying wallet) is an account-takeover vector — it MUST use pull
 * mode, where the signer is recovered from the client-signed tx = cryptographic proof of control.
 * A SKU in MPP_SKUS but NOT here is push-mode (agent_ask). The mode is advertised inside the
 * HMAC-bound `request` JSON (see buildMppChallengeHeader) so a client cannot swap it.
 */
// Both plaintext SKUs are push-mode: payment == one delivery (a minted post) and no
// bearer credential is issued, so a verified on-chain transfer hash is sufficient.
// (Pull mode exists in this module for SKUs that mint sessions — none here.)
export const MPP_PULL_SKUS = new Set<string>([]);

/** The submission mode for a SKU: pull (proof-of-control, mints sessions) or push (hash-only). */
export function mppMode(sku: Sku): "pull" | "push" {
  return MPP_PULL_SKUS.has(sku.id) ? "pull" : "push";
}

export function mppEnabled(env: Env): boolean {
  const on = env.MPP_ENABLED === "1" || env.MPP_ENABLED === "true";
  return on && !!env.MPP_SECRET_KEY && !!(env.MPP_RECIPIENT || env.PAY_TO);
}

/**
 * Pull-mode kill-switch. Pull mints a bearer SESSION off a client-signed Tempo tx; the code is
 * adversarially-verified SOUND, but no LIVE client handshake has been observed and correctness rests
 * on the pinned viem/ox Tempo serializer. So pull ships DARK behind its own flag even after merge —
 * flip MPP_PULL_ENABLED only after one real end-to-end pull settlement is confirmed on staging.
 * Push SKUs (agent_ask) are unaffected.
 */
export function mppPullEnabled(env: Env): boolean {
  return env.MPP_PULL_ENABLED === "1" || env.MPP_PULL_ENABLED === "true";
}

/** Is a SKU's MPP rail ACTIVE right now? Push SKUs are active whenever MPP is on; pull SKUs
 *  (session-minting) additionally require MPP_PULL_ENABLED, so they advertise/accept MPP only once
 *  the kill-switch is flipped. Used everywhere the dual-rail 402 / openapi is decided. */
export function mppSkuActive(env: Env, sku: Sku): boolean {
  if (!MPP_SKUS.has(sku.id)) return false;
  return mppMode(sku) === "push" || mppPullEnabled(env);
}
export function mppRecipient(env: Env): string {
  return (env.MPP_RECIPIENT || env.PAY_TO || "").toLowerCase();
}
export function mppCurrency(env: Env): string {
  return (env.MPP_CURRENCY || TEMPO_USDC).toLowerCase();
}
function tempoRpc(env: Env): string {
  return env.TEMPO_RPC_URL || DEFAULT_TEMPO_RPC;
}
/** MPPScan attribution realm — hostname only, no scheme (mppscan.com/discovery/spec). */
export function mppRealm(env: Env): string {
  let raw = env.PUBLIC_API_URL || "https://plaintext.numetal.xyz";
  let end = raw.length;
  while (end > 0 && raw[end - 1] === "/") end -= 1;
  raw = raw.slice(0, end);
  try {
    return new URL(raw.includes("://") ? raw : `https://${raw}`).host;
  } catch {
    return raw.replace(/^https?:\/\//, "").split("/")[0] ?? raw;
  }
}

// ── b64url (no padding, RFC 4648 §5) over UTF-8 ────────────────────────────────────────────────
export function b64urlEncode(s: string): string {
  const bytes = new TextEncoder().encode(s);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
export function b64urlDecode(s: string): string {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (s.length % 4)) % 4);
  const bin = atob(b64);
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

async function hmacB64url(secret: string, input: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(input)));
  let bin = "";
  for (const b of sig) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Constant-time string equality (HMAC id comparison — never early-exit on a prefix match). */
function ctEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

/** The HMAC binding input per draft-httpauth-payment: empty string for absent slots. */
function bindingInput(realm: string, method: string, intent: string, request: string, expires: string, digest: string, opaque: string): string {
  return [realm, method, intent, request, expires, digest, opaque].join("|");
}

export function atomicAmount(sku: Sku): string {
  return String(Math.round(Number(sku.priceUsd.replace("$", "")) * 1e6)); // 6-decimal TIP-20 units
}

/**
 * Build the `WWW-Authenticate: Payment …` challenge header value for a SKU.
 * `request`/`opaque` are b64url JCS JSON — objects below are built with keys already in
 * lexicographic order, which is JCS-canonical for these flat shapes.
 */
export async function buildMppChallengeHeader(env: Env, sku: Sku): Promise<string> {
  const realm = mppRealm(env);
  // supportedModes is advertised PER SKU and lives INSIDE `request` (which the HMAC id binds), so a
  // client can't downgrade a pull SKU (session-minting) to push (no proof of control). draft-tempo
  // §4.3: a server supporting only one non-zero mode MUST list exactly that mode.
  const request = b64urlEncode(
    JSON.stringify({
      amount: atomicAmount(sku),
      currency: mppCurrency(env),
      methodDetails: { chainId: TEMPO_CHAIN_ID, supportedModes: [mppMode(sku)] },
      recipient: mppRecipient(env),
    }),
  );
  // Per-challenge nonce lives in opaque → the HMAC-bound id is unique per challenge.
  const opaque = b64urlEncode(JSON.stringify({ n: crypto.randomUUID(), s: sku.id }));
  const expires = new Date(Date.now() + CHALLENGE_TTL_MS).toISOString().replace(/\.\d{3}Z$/, "Z");
  const id = await hmacB64url(env.MPP_SECRET_KEY!, bindingInput(realm, "tempo", "charge", request, expires, "", opaque));
  return `Payment id="${id}", realm="${realm}", method="tempo", intent="charge", expires="${expires}", opaque="${opaque}", request="${request}"`;
}

// ── Credential parsing + verification ──────────────────────────────────────────────────────────
export interface MppCredential {
  challenge: { id?: string; realm?: string; method?: string; intent?: string; request?: string; expires?: string; opaque?: string; digest?: string };
  payload: { type?: string; signature?: string; hash?: string };
  source?: string;
}

/** Extract the MPP credential from an `Authorization: Payment <b64url>` header. Null = not MPP. */
export function parseMppAuth(header: string | undefined): MppCredential | null {
  if (!header) return null;
  const m = header.match(/^Payment\s+([A-Za-z0-9_-]+)$/i);
  if (!m) return null;
  try {
    const cred = JSON.parse(b64urlDecode(m[1]!)) as MppCredential;
    if (!cred || typeof cred !== "object" || !cred.challenge || !cred.payload) return null;
    return cred;
  } catch {
    return null;
  }
}

interface RpcLog {
  address: string;
  topics: string[];
  data: string;
}
async function fetchTempoReceipt(env: Env, hash: string): Promise<{ status?: string; logs?: RpcLog[] } | null> {
  const r = await fetch(tempoRpc(env), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_getTransactionReceipt", params: [hash] }),
  });
  if (!r.ok) return null;
  const j = (await r.json()) as { result?: { status?: string; logs?: RpcLog[] } | null };
  return j.result ?? null;
}
const topicAddr = (topic: string): string => ("0x" + topic.slice(-40)).toLowerCase();

/** Bare Tempo JSON-RPC call. Returns { result, error } or null on a non-2xx / unparseable response. */
async function tempoRpcCall(env: Env, method: string, params: unknown[]): Promise<{ result?: unknown; error?: { message?: string } } | null> {
  const r = await fetch(tempoRpc(env), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  if (!r.ok) return null;
  return (await r.json()) as { result?: unknown; error?: { message?: string } };
}

/**
 * Broadcast a signed raw tx. Returns { hash } on accept, { hash, alreadyKnown } if the node reports
 * the tx is already in the pool / nonce already used (a benign race — someone broadcast the SAME
 * signed tx first; we then verify by receipt rather than fail), or { error } otherwise. `expectHash`
 * is the tx hash we computed locally, used when the node's "already known" error omits it.
 */
async function broadcastRawTx(env: Env, rawTx: string, expectHash: string): Promise<{ hash?: string; alreadyKnown?: boolean; error?: string }> {
  const j = await tempoRpcCall(env, "eth_sendRawTransaction", [rawTx]);
  if (!j) return { error: "rpc-unavailable" };
  if (typeof j.result === "string" && /^0x[0-9a-fA-F]{64}$/.test(j.result)) return { hash: j.result.toLowerCase() };
  const msg = (j.error?.message ?? "").toLowerCase();
  // Benign races: the identical signed tx already reached the pool, or its nonce is already consumed
  // by that same tx. Fall through to receipt verification against the locally-computed hash.
  if (msg.includes("already known") || msg.includes("already exists") || msg.includes("nonce too low") || msg.includes("already imported"))
    return { hash: expectHash, alreadyKnown: true };
  return { error: j.error?.message ?? "broadcast-failed" };
}

/**
 * The challenge-authenticity preamble shared by push AND pull verification: prove the credential
 * echoes a challenge WE minted (HMAC id over the bound slots, constant-time), that it hasn't
 * expired, and that the bound `request` states OUR terms for THIS SKU (currency/recipient/amount).
 * Returns the decoded request on success, or a { raw } reason on any failure. The mode (inside
 * request.methodDetails.supportedModes) is HMAC-bound, so the caller can trust it too.
 */
async function verifyChallengeAuthenticity(
  env: Env,
  cred: MppCredential,
  sku: Sku,
): Promise<{ ok: true; amount: bigint } | { ok: false; raw: string }> {
  const ch = cred.challenge;
  // Wrong METHOD/intent is a 400-class method-unsupported; wrong SUBMISSION MODE (payload type) is a
  // retryable 402 verification-failed — the tempo/charge method IS accepted, only the wrong mode isn't.
  if (ch.method !== "tempo" || ch.intent !== "charge") return { ok: false, raw: "method-unsupported" };
  if (!ch.id || !ch.request || ch.realm !== mppRealm(env)) return { ok: false, raw: "invalid-challenge" };

  const expectId = await hmacB64url(env.MPP_SECRET_KEY!, bindingInput(ch.realm, ch.method, ch.intent, ch.request, ch.expires ?? "", ch.digest ?? "", ch.opaque ?? ""));
  if (!ctEqual(expectId, ch.id)) return { ok: false, raw: "invalid-challenge" };
  if (ch.expires && Date.parse(ch.expires) < Date.now()) return { ok: false, raw: "payment-expired" };

  let req: { amount?: string; currency?: string; recipient?: string };
  try {
    req = JSON.parse(b64urlDecode(ch.request));
  } catch {
    return { ok: false, raw: "malformed-credential" };
  }
  // The bound request must state OUR terms for THIS SKU — an id forged over other terms already
  // failed the HMAC, so this guards against config drift between issue and verify.
  if (req.currency?.toLowerCase() !== mppCurrency(env)) return { ok: false, raw: "verification-failed" };
  if (req.recipient?.toLowerCase() !== mppRecipient(env)) return { ok: false, raw: "verification-failed" };
  if (req.amount !== atomicAmount(sku)) return { ok: false, raw: "payment-insufficient" };
  return { ok: true, amount: BigInt(req.amount) };
}

/**
 * Verify an MPP push-mode credential end-to-end (challenge authenticity → terms → on-chain
 * Transfer log). Returns the same VerifiedPayment shape the x402 provider yields, so routes
 * share the settle/ledger/receipt machinery. `nonce` = the challenge id (single-use key);
 * callers must ALSO dedupe on `tx` (one on-chain transfer can only buy one artifact).
 */
export async function verifyMppPayment(env: Env, cred: MppCredential, sku: Sku): Promise<VerifiedPayment> {
  // Fail-closed like the x402 provider: any throw (malformed RPC/hex, network) → 402, never a 500.
  try {
    const ch = cred.challenge;
    const pre = await verifyChallengeAuthenticity(env, cred, sku);
    if (!pre.ok) return { verified: false, raw: pre.raw };
    const want = pre.amount;

    if (cred.payload.type !== "hash") return { verified: false, raw: "verification-failed" }; // push mode only (supportedModes:[push])
    const hash = cred.payload.hash;
    if (!hash || !/^0x[0-9a-fA-F]{64}$/.test(hash)) return { verified: false, raw: "malformed-credential" };

    // Push mode: the client broadcasts and waits for ~500ms finality BEFORE submitting, so the
    // receipt should exist on the first read — a short bounded retry covers propagation jitter only.
    let receipt: Awaited<ReturnType<typeof fetchTempoReceipt>> = null;
    for (let i = 0; i < 2 && !receipt; i++) {
      receipt = await fetchTempoReceipt(env, hash).catch(() => null);
      if (!receipt && i === 0) await new Promise((r) => setTimeout(r, 500));
    }
    if (!receipt || receipt.status !== "0x1") return { verified: false, raw: "verification-failed" };

    const log = findTransferLog(env, receipt.logs, want);
    if (!log) return { verified: false, raw: "verification-failed" };

    const payer = topicAddr(log.topics[1]!);
    return { verified: true, payer, tx: hash.toLowerCase(), amountUsdc: (Number(want) / 1e6).toFixed(2), nonce: ch.id };
  } catch {
    return { verified: false, raw: "verification-failed" }; // fail-closed
  }
}

/**
 * Find a confirmed on-chain Transfer log to OUR recipient on the currency token for >= `want`.
 * Shared by push-mode receipt verification AND the pull-mode CONFIRMED-receipt gate — both must
 * prove the money actually landed via a real Transfer event, not just a broadcast/success flag.
 */
function findTransferLog(env: Env, logs: RpcLog[] | undefined, want: bigint): RpcLog | undefined {
  const isHex = (s: string) => /^0x[0-9a-fA-F]*$/.test(s);
  return (logs ?? []).find(
    (l) =>
      l.address?.toLowerCase() === mppCurrency(env) &&
      l.topics?.[0] === TRANSFER_TOPIC &&
      l.topics.length >= 3 &&
      topicAddr(l.topics[2]!) === mppRecipient(env) &&
      isHex(l.data) &&
      BigInt(l.data || "0x0") >= want,
  );
}

/**
 * Verify an MPP PULL-mode credential (draft-tempo §5.2 type="transaction", §7.2 verification).
 * Unlike push, the caller hands us a SIGNED-BUT-UNBROADCAST tx; we prove control, broadcast, and
 * gate on the confirmed receipt. Steps:
 *  a. shared challenge-authenticity preamble (HMAC id, expiry, terms).
 *  b. require payload.type === "transaction" + a hex signature (the RLP signed tx).
 *  c. deserialize (viem/tempo Transaction.deserialize) + guard it is a Tempo type-0x76 tx.
 *  d. verify EXACTLY one qualifying call: to === currency, decoding (transfer / transferWithMemo)
 *     to (recipient === ours, amount >= atomicAmount(sku)). REJECT any batch that moves value
 *     elsewhere or hits an unexpected selector — only the transfer call may touch value.
 *  e. RECOVER the signer from the secp256k1 signature and cross-check it equals the tx `from`. The
 *     recovered signer IS the payer AND the proof of key control (safe to bind a session to it).
 *  f. broadcast (eth_sendRawTransaction; feePayer:false → the signer pays its own gas, NO hot key).
 *  g. CRITICAL: gate on the CONFIRMED on-chain receipt (status 0x1 + a matching Transfer log to us
 *     for >= amount), NEVER the successful broadcast. A tx that never confirms = NO session, NO
 *     charge. On an "already known" broadcast (race), fetch the receipt by hash and verify it.
 *  h. fail-closed: any throw → { verified:false } (mirrors push).
 * Returns the VerifiedPayment shape { verified, payer, tx, amountUsdc, nonce: challengeId }.
 */
export async function verifyMppPullPayment(env: Env, cred: MppCredential, sku: Sku): Promise<VerifiedPayment> {
  try {
    const ch = cred.challenge;
    // (a) shared authenticity preamble.
    const pre = await verifyChallengeAuthenticity(env, cred, sku);
    if (!pre.ok) return { verified: false, raw: pre.raw };
    const want = pre.amount;

    // (b) pull mode demands a signed transaction, not a hash. A hash on a pull challenge is the
    // wrong submission mode → retryable verification-failed (the method/intent are still supported).
    if (cred.payload.type !== "transaction") return { verified: false, raw: "verification-failed" };
    const rawTx = cred.payload.signature;
    if (!rawTx || !/^0x[0-9a-fA-F]+$/.test(rawTx)) return { verified: false, raw: "malformed-credential" };

    // (c) deserialize + guard it is a Tempo type-0x76 tx on OUR chain.
    let tx: ReturnType<typeof Tempo.Transaction.deserialize>;
    try {
      tx = Tempo.Transaction.deserialize(rawTx as `0x${string}`);
    } catch {
      return { verified: false, raw: "malformed-credential" };
    }
    const t = tx as unknown as {
      type?: string;
      chainId?: number;
      signature?: { type?: string; signature?: { r: bigint; s: bigint; yParity: number } };
      calls?: readonly { to?: string; data?: string; value?: bigint }[];
    };
    if (Tempo.Transaction.getType(t as never) !== "tempo" || t.type !== "tempo") return { verified: false, raw: "malformed-credential" };
    if (t.chainId !== undefined && Number(t.chainId) !== TEMPO_CHAIN_ID) return { verified: false, raw: "verification-failed" };

    // (d) EXACTLY one qualifying value-moving call, and it must be OUR transfer. Any other call in
    // the batch — a transfer elsewhere, a non-transfer selector, a bare value send — voids the tx.
    const calls = t.calls ?? [];
    if (calls.length !== 1) return { verified: false, raw: "verification-failed" };
    const call = calls[0]!;
    if ((call.to ?? "").toLowerCase() !== mppCurrency(env)) return { verified: false, raw: "verification-failed" };
    if (call.value && BigInt(call.value) !== 0n) return { verified: false, raw: "verification-failed" }; // no native value on a TIP-20 call
    let decoded: { functionName: string; args: readonly unknown[] };
    try {
      decoded = decodeFunctionData({ abi: TIP20_TRANSFER_ABI, data: (call.data ?? "0x") as `0x${string}` });
    } catch {
      return { verified: false, raw: "verification-failed" }; // unexpected selector → not a transfer
    }
    if (decoded.functionName !== "transfer" && decoded.functionName !== "transferWithMemo") return { verified: false, raw: "verification-failed" };
    const to = String(decoded.args[0] ?? "").toLowerCase();
    const amount = BigInt(decoded.args[1] as bigint);
    if (to !== mppRecipient(env)) return { verified: false, raw: "verification-failed" };
    if (amount < want) return { verified: false, raw: "payment-insufficient" };

    // (e) recover the signer independently, cross-check it equals the tx `from`. Recovery = proof of
    // key control (only secp256k1 in v1; P256/WebAuthn envelopes are not caller-recoverable this way).
    const sigEnv = t.signature;
    if (!sigEnv || sigEnv.type !== "secp256k1" || !sigEnv.signature) return { verified: false, raw: "verification-failed" };
    let signer: string;
    try {
      // Presign payload = keccak256 of the tx serialized WITHOUT its signature (verified against a
      // real signed tx: this reproduces the exact secp256k1 recover payload). Uses ONLY viem/tempo
      // runtime exports — ox is not a hoisted dependency.
      const { signature: _sig, ...unsigned } = tx as Record<string, unknown>;
      const presign = await Tempo.Transaction.serialize(unsigned as never);
      const payload = keccak256(presign as `0x${string}`);
      signer = Tempo.Secp256k1.recoverAddress({ payload, signature: sigEnv.signature }).toLowerCase();
    } catch {
      return { verified: false, raw: "verification-failed" };
    }
    if (!/^0x[0-9a-f]{40}$/.test(signer)) return { verified: false, raw: "verification-failed" };
    // The recovered signer is the payer. (Tempo derives `from` from the signature, so recovery IS
    // the from-check; there is no independently-claimed `from` field on a type-0x76 envelope.)
    const payer = signer;

    // Compute the tx hash locally BEFORE broadcast so we can verify by receipt even under an
    // "already known" race where the node's error omits the hash.
    let txHash: string;
    try {
      txHash = keccak256((await Tempo.Transaction.serialize(tx as never, sigEnv as never)) as `0x${string}`).toLowerCase();
    } catch {
      return { verified: false, raw: "verification-failed" };
    }

    // (f) broadcast. feePayer:false — the signer pays its own gas; we add NO fee-payer signature and
    // hold NO hot key.
    const b = await broadcastRawTx(env, rawTx, txHash);
    if (b.error || !b.hash) return { verified: false, raw: "verification-failed" };
    const hash = b.hash;

    // (g) GATE ON THE CONFIRMED RECEIPT, never the broadcast. Immediate finality is ~500ms; poll a
    // few times for propagation. A missing / reverted / non-matching receipt → NO session, NO charge.
    let receipt: Awaited<ReturnType<typeof fetchTempoReceipt>> = null;
    for (let i = 0; i < 4 && !receipt; i++) {
      receipt = await fetchTempoReceipt(env, hash).catch(() => null);
      if (!receipt && i < 3) await new Promise((r) => setTimeout(r, 400));
    }
    if (!receipt || receipt.status !== "0x1") return { verified: false, raw: "verification-failed" };
    const log = findTransferLog(env, receipt.logs, want);
    if (!log) return { verified: false, raw: "verification-failed" };
    // Defense in depth: the confirmed Transfer must originate from the SAME signer we recovered.
    if (topicAddr(log.topics[1]!) !== payer) return { verified: false, raw: "verification-failed" };

    return { verified: true, payer, tx: hash.toLowerCase(), amountUsdc: (Number(want) / 1e6).toFixed(2), nonce: ch.id };
  } catch {
    return { verified: false, raw: "verification-failed" }; // fail-closed
  }
}

/** Success receipt header value (`Payment-Receipt`) — MUST NOT be attached to error responses. */
export function mppReceiptHeader(env: Env, challengeId: string, tx: string, sku: Sku): string {
  return b64urlEncode(
    JSON.stringify({
      challengeId,
      method: "tempo",
      reference: tx,
      settlement: { amount: atomicAmount(sku), currency: mppCurrency(env) },
      status: "success",
      timestamp: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
    }),
  );
}

// Problem registry per draft-httpauth-payment Table 6 + mpp.dev/protocol/http-402. Every code is a
// 402 (with a FRESH challenge) EXCEPT method-unsupported, the registry's lone 4xx-non-402.
const MPP_PROBLEMS: Record<string, { status: number; title: string }> = {
  "payment-required": { status: 402, title: "Payment Required" },
  "payment-insufficient": { status: 402, title: "Payment Insufficient" },
  "payment-expired": { status: 402, title: "Payment Expired" },
  "verification-failed": { status: 402, title: "Payment Verification Failed" },
  "malformed-credential": { status: 402, title: "Malformed Credential" },
  "invalid-challenge": { status: 402, title: "Invalid Challenge" },
  "method-unsupported": { status: 400, title: "Method Not Supported" },
};

/** Map a verifyMppPayment `raw` reason to a problem code (never expose the raw string to clients). */
export function mppProblemCode(raw: unknown): string {
  const s = String(raw ?? "verification-failed").split(":")[0]!.trim();
  return s in MPP_PROBLEMS ? s : "verification-failed";
}

/** MPP failure = problem status + (for 402s) a FRESH challenge + RFC 9457 body — never a receipt. */
export async function mppProblem(env: Env, sku: Sku, code: string, detail: string): Promise<Response> {
  const spec = MPP_PROBLEMS[code] ?? MPP_PROBLEMS["verification-failed"]!;
  const headers: Record<string, string> = {
    "content-type": "application/problem+json",
    "cache-control": "no-store",
  };
  // A 402 MUST carry a Payment challenge; a 400 (method-unsupported) must not invite a blind retry.
  if (spec.status === 402 && mppEnabled(env)) headers["WWW-Authenticate"] = await buildMppChallengeHeader(env, sku);
  return new Response(
    JSON.stringify({ type: `https://paymentauth.org/problems/${code}`, title: spec.title, status: spec.status, detail }),
    { status: spec.status, headers },
  );
}
