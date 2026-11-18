/**
 * x402 payment adapter (PaymentProvider boundary). Staging = Base Sepolia + the
 * x402.org testnet facilitator; production flips to Base mainnet + CDP (redacted).
 * Protocol / network / facilitator are kept separate so a better facilitator can drop
 * in without touching Ishtar. verify() is FAIL-CLOSED: any error → not verified.
 */
import type { Env } from "../env";
import { buildMppChallengeHeader, mppEnabled, mppSkuActive } from "./mpp";

export interface Sku {
  id: string;
  priceUsd: string; // "$5.00"
  route: string;
}

// The board's two paid writes. Same prices as the on-chain contract ($3 notice,
// $0.50 remark) — an agent pays in USDC (Base, x402) or on Tempo (MPP) and the
// board's relay submits the on-chain post on Robinhood Chain for them.
export const SKUS: Record<string, Sku> = {
  notice: { id: "notice", priceUsd: "$3.00", route: "/api/v1/notice" },
  remark: { id: "remark", priceUsd: "$0.50", route: "/api/v1/remark" },
};

// Staging defaults (testnet only, no key). eip155:84532 = Base Sepolia.
export const STAGING_NETWORK = "eip155:84532";
export const STAGING_FACILITATOR = "https://x402.org/facilitator";
// USDC on Base Sepolia.
export const USDC_BASE_SEPOLIA = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";

// Mainnet (real USDC) — Coinbase CDP facilitator. eip155:8453 = Base mainnet.
export const MAINNET_NETWORK = "eip155:8453";
export const CDP_FACILITATOR = "https://api.cdp.coinbase.com/platform/v2/x402";
// Canonical USDC on Base mainnet.
export const USDC_BASE_MAINNET = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";

// Solana mainnet (CAIP-2) + canonical SPL USDC mint.
export const SOLANA_MAINNET_NETWORK = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";
export const SOLANA_DEVNET_NETWORK = "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1";
export const USDC_SOLANA_MAINNET = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
/** Default Solana payTo when X402_SOLANA_ENABLED — founder pubkey only; no SOL private key on the Worker. */
export const DEFAULT_PAY_TO_SOLANA = "2GvLgz2ovzNkrYEzJsZ1kRovXjVQnmm7WRWFd3vFzsma";

const FEE_PAYER_CACHE_TTL_MS = 5 * 60 * 1000;
const feePayerCache: Record<string, { feePayer: string; expiresAt: number }> = {};

export interface VerifiedPayment {
  verified: boolean;
  payer?: string;
  tx?: string;
  amountUsdc?: string;
  nonce?: string; // EIP-3009 authorization nonce — the anti-replay key (red-team C4)
  network?: string;
  payTo?: string;
  raw?: string;
}

export type PaymentRail = "evm" | "svm";

export interface PaymentTerms {
  rail: PaymentRail;
  network?: string;
  to?: string;
  value?: string;
  nonce?: string;
}

/** True when at least one x402 rail is configured (Base and/or Solana). */
export function paymentsConfigured(env: Env): boolean {
  return !!(env.PAY_TO || solanaEnabled(env));
}

export function solanaEnabled(env: Env): boolean {
  const on = env.X402_SOLANA_ENABLED === "1" || env.X402_SOLANA_ENABLED === "true";
  return on && !!payToSolana(env);
}

export function payToSolana(env: Env): string {
  return (env.PAY_TO_SOLANA || DEFAULT_PAY_TO_SOLANA).trim();
}

function solanaNetwork(env: Env): string {
  return env.X402_MODE === "mainnet" ? SOLANA_MAINNET_NETWORK : SOLANA_DEVNET_NETWORK;
}

function solanaUsdcAsset(env: Env): string {
  // Devnet USDC mint varies by faucet; mainnet is canonical. x402.org devnet facilitator documents a faucet mint.
  return env.X402_MODE === "mainnet" ? USDC_SOLANA_MAINNET : USDC_SOLANA_MAINNET;
}

function payToMatches(expected: string, actual: string, rail: PaymentRail): boolean {
  return rail === "evm" ? expected.toLowerCase() === actual.toLowerCase() : expected === actual;
}

/** Decode an X-PAYMENT / PAYMENT-SIGNATURE header (base64-JSON or raw-JSON). */
function decodePayment(header: string): Record<string, unknown> | null {
  for (const dec of [() => atob(header), () => header]) {
    try {
      return JSON.parse(dec()) as Record<string, unknown>;
    } catch {
      /* try the next form */
    }
  }
  return null;
}

/**
 * Decode the signed x402 payment authorization — the SOURCE OF TRUTH for amount / recipient /
 * network / nonce. The facilitator only attests that the signature is valid; the resource server
 * MUST independently confirm the signed TERMS match what it requires (red-team C3/H8). Best-effort
 * across x402 payload shapes; returns null if it can't extract value + to (→ fail-closed).
 */
const asStr = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);

/** Unified term extraction — EVM (EIP-3009 authorization) OR SVM (accepted.payTo + payload.transaction). */
export function parsePaymentTerms(header: string): PaymentTerms | null {
  const obj = decodePayment(header);
  if (!obj) return null;
  const payload = (obj.payload ?? {}) as Record<string, unknown>;
  const accepted = (obj.accepted ?? {}) as Record<string, unknown>;
  const networkHint = asStr(obj.network ?? payload.network ?? accepted.network);
  const svmPayload = payload.transaction != null || networkHint?.startsWith("solana:");
  if (svmPayload) {
    const to = asStr(accepted.payTo);
    const value = accepted.amount != null ? String(accepted.amount) : undefined;
    return { rail: "svm", network: networkHint, to, value };
  }
  const auth = (payload.authorization ?? obj.authorization ?? payload ?? {}) as Record<string, unknown>;
  const network = networkHint;
  const to = asStr(auth.to);
  const value = auth.value != null ? String(auth.value) : undefined;
  const nonce = asStr(auth.nonce ?? obj.nonce);
  return { rail: "evm", network, to, value, nonce };
}

/** EVM-only backward-compat wrapper — SVM payloads return null here (use parsePaymentTerms). */
export function parsePaymentHeader(header: string): { to?: string; value?: string; nonce?: string; network?: string } | null {
  const terms = parsePaymentTerms(header);
  if (!terms || terms.rail !== "evm") return null;
  return { to: terms.to, value: terms.value, nonce: terms.nonce, network: terms.network };
}

export interface PaymentProvider {
  network: string; // primary EVM network (receipt fallback when unset on verified payload)
  facilitator: string;
  verify(paymentHeader: string, sku: Sku): Promise<VerifiedPayment>;
}

// Public origin for the x402 `resource` field. The x402 PaymentRequirements `resource` MUST be a full
// URL (clients reject a bare path), so we build it from the configured public base + the SKU route.
const DEFAULT_API_BASE = "https://plaintext.numetal.xyz";
function stripTrailingSlashes(value: string): string {
  let end = value.length;
  while (end > 0 && value[end - 1] === "/") end -= 1;
  return value.slice(0, end);
}
function apiBase(env: Env): string {
  return stripTrailingSlashes(env.PUBLIC_API_URL || DEFAULT_API_BASE);
}
// Window (s) a signed payment authorization stays valid — clients set validBefore = now + this. Required field.
export const X402_MAX_TIMEOUT_SECONDS = 300;
// x402 protocol version. The modern @x402 SDK + the CDP facilitator are v2 (CAIP-2 networks); a v2 client
// rejects a `x402Version:1` challenge with "no client registered for version 1".
export const X402_VERSION = 2;

/**
 * The canonical x402 v2 PaymentRequirements for a SKU — the SINGLE source of truth used BOTH in the 402 challenge
 * `accepts[]` (what the client signs against) AND in the CDP verify/settle `paymentRequirements` (what the
 * facilitator checks the payload against). They MUST agree. v2 shape (per @x402/core `PaymentRequirementsV2Schema`):
 * CAIP-2 `network` (the CDP facilitator accepts CAIP-2 only), the amount field is `amount` (v1 called it
 * `maxAmountRequired`), and `resource`/`description`/`mimeType` do NOT live here — `resource` is a top-level
 * ResourceInfo object on the challenge body instead.
 */
export function x402Requirements(env: Env, sku: Sku, payTo: string) {
  const cfg = evmModeCfg(env);
  const dollars = Number(sku.priceUsd.replace("$", ""));
  return {
    scheme: "exact",
    network: cfg.network, // CAIP-2 (eip155:8453 / :84532) — NetworkSchemaV2
    amount: String(Math.round(dollars * 1e6)), // USDC 6dp; v2 field name (v1: maxAmountRequired)
    asset: cfg.asset,
    payTo,
    maxTimeoutSeconds: X402_MAX_TIMEOUT_SECONDS,
    extra: cfg.eip712, // EIP-712 domain {name, version} — required by the v2 exact-EVM client to sign EIP-3009
  };
}

/** Solana exact-scheme requirements — extra.feePayer from CDP/x402.org /supported (facilitator sponsors fees). */
export async function solanaRequirements(env: Env, sku: Sku, payTo: string) {
  const network = solanaNetwork(env);
  const feePayer = await fetchFeePayer(env, network);
  if (!feePayer) return null;
  const dollars = Number(sku.priceUsd.replace("$", ""));
  return {
    scheme: "exact",
    network,
    amount: String(Math.round(dollars * 1e6)),
    asset: solanaUsdcAsset(env),
    payTo,
    maxTimeoutSeconds: X402_MAX_TIMEOUT_SECONDS,
    extra: { feePayer },
  };
}

/** Multi-rail accepts[] for 402 challenges — Base (when PAY_TO set) + Solana (when X402_SOLANA_ENABLED). */
export async function x402Accepts(env: Env, sku: Sku): Promise<unknown[]> {
  const accepts: unknown[] = [];
  if (env.PAY_TO) accepts.push(x402Requirements(env, sku, env.PAY_TO));
  if (solanaEnabled(env)) {
    const sol = await solanaRequirements(env, sku, payToSolana(env));
    if (sol) accepts.push(sol);
  }
  return accepts;
}

function expectedPayTo(env: Env, rail: PaymentRail): string | undefined {
  return rail === "svm" ? (solanaEnabled(env) ? payToSolana(env) : undefined) : env.PAY_TO;
}

function railNetwork(env: Env, rail: PaymentRail): string {
  return rail === "svm" ? solanaNetwork(env) : evmModeCfg(env).network;
}

function railFacilitator(env: Env, rail: PaymentRail): string {
  return evmModeCfg(env).mainnet || rail === "svm" ? CDP_FACILITATOR : STAGING_FACILITATOR;
}

/** Fetch facilitator feePayer for Solana exact scheme — cached ~5 min per network. */
export async function fetchFeePayer(env: Env, network: string): Promise<string | undefined> {
  const cached = feePayerCache[network];
  if (cached && cached.expiresAt > Date.now()) return cached.feePayer;
  const mainnet = env.X402_MODE === "mainnet";
  const facilitator = mainnet ? CDP_FACILITATOR : STAGING_FACILITATOR;
  const headers: Record<string, string> = { accept: "application/json" };
  if (mainnet) {
    if (!env.CDP_API_KEY_ID || !env.CDP_API_KEY_SECRET) return undefined;
    headers.authorization = `Bearer ${await cdpBearer(env.CDP_API_KEY_ID, env.CDP_API_KEY_SECRET, "GET", "api.cdp.coinbase.com", "/platform/v2/x402/supported")}`;
  }
  try {
    const res = await fetch(`${facilitator}/supported`, { headers });
    if (!res.ok) return undefined;
    const data = (await res.json()) as { kinds?: Array<{ scheme?: string; network?: string; extra?: { feePayer?: string } }>; paymentKinds?: typeof data.kinds };
    for (const kind of data.kinds ?? data.paymentKinds ?? []) {
      if (kind.network === network && kind.scheme === "exact" && typeof kind.extra?.feePayer === "string") {
        feePayerCache[network] = { feePayer: kind.extra.feePayer, expiresAt: Date.now() + FEE_PAYER_CACHE_TTL_MS };
        return kind.extra.feePayer;
      }
    }
  } catch {
    /* fail closed — Solana rail omitted from accepts when feePayer unavailable */
  }
  return undefined;
}

async function requirementsForRail(env: Env, sku: Sku, rail: PaymentRail): Promise<Record<string, unknown> | null> {
  if (rail === "svm") return solanaRequirements(env, sku, payToSolana(env));
  if (!env.PAY_TO) return null;
  return x402Requirements(env, sku, env.PAY_TO) as Record<string, unknown>;
}

/** Paid surfaces carrying extensions.bazaar input/output schemas for discovery probes. */
export const BAZAAR_DISCOVERY_SKUS = new Set(["notice", "remark"]);

type BazaarBody = Record<string, unknown>;
type BazaarShape = {
  input: { type: string; method: string; bodyType: string; body: BazaarBody };
  output: { type: string; example: BazaarBody };
  bodySchema: Record<string, unknown>;
  /** Output fields that may be JSON null (OpenAPI 3.1 / JSON Schema 2020-12 union type). */
  nullableOutputFields?: string[];
};

const NOTICE_OUTPUT_EXAMPLE = {
  ok: true,
  gid: 3,
  tokenId: 1,
  cid: "bafkrei…",
  tx: "0x…",
  url: "https://plaintext.numetal.xyz/notices/3",
  owner: "0x…",
};

const BAZAAR_SHAPES: Record<string, BazaarShape> = {
  notice: {
    input: {
      type: "http",
      method: "POST",
      bodyType: "json",
      body: {
        body: "the first line is the title\n\nand the rest is the notice, markdown or nothing at all.",
        owner: "0x0000000000000000000000000000000000000000",
        ref: "notice-idempotency-key-01",
      },
    },
    output: { type: "json", example: NOTICE_OUTPUT_EXAMPLE },
    bodySchema: {
      type: "object",
      properties: {
        body: { type: "string", minLength: 1, maxLength: 64000, description: "The notice text. First non-empty line becomes the title. Markdown (headings/quotes/bullets/fences) + [[wikilinks]] supported." },
        owner: { type: "string", description: "Optional 0x address to receive the notice's ERC-721 token (the relay mints then transfers). Omit = relay keeps custody." },
        ref: { type: "string", minLength: 8, maxLength: 100, description: "Client idempotency key (reuse verbatim on retries)." },
      },
      required: ["body"],
    },
  },
  remark: {
    input: {
      type: "http",
      method: "POST",
      bodyType: "json",
      body: { body: "a remark under a notice.", parent: 1, ref: "remark-idempotency-key-01" },
    },
    output: { type: "json", example: NOTICE_OUTPUT_EXAMPLE },
    bodySchema: {
      type: "object",
      properties: {
        body: { type: "string", minLength: 1, maxLength: 64000, description: "The remark text." },
        parent: { type: "number", description: "The gid of the notice being remarked on (from /api/v1/board or the /notices/<gid> URL)." },
        owner: { type: "string", description: "Optional 0x address to receive the remark's token." },
        ref: { type: "string", minLength: 8, maxLength: 100, description: "Client idempotency key." },
      },
      required: ["body", "parent"],
    },
  },
};

/** OpenAPI requestBody + bazaar 402 input schema — single source of truth from route handlers. */
export function discoveryInputSchema(skuId: string): Record<string, unknown> | undefined {
  return BAZAAR_SHAPES[skuId]?.bodySchema;
}

/** OpenAPI 200 response schema derived from the live handler's success shape. */
export function discoveryOutputSchema(skuId: string): Record<string, unknown> | undefined {
  const shape = BAZAAR_SHAPES[skuId];
  if (!shape) return undefined;
  return bazaarOutputSchema(shape.output.example, shape.nullableOutputFields);
}

function bazaarOutputSchema(example: BazaarBody, nullableFields: string[] = []): Record<string, unknown> {
  const props: Record<string, unknown> = {};
  for (const k of Object.keys(example)) {
    const v = example[k];
    if (nullableFields.includes(k)) props[k] = { type: ["string", "null"] };
    else if (typeof v === "string") props[k] = { type: "string" };
    else if (typeof v === "number") props[k] = { type: "number" };
    else if (typeof v === "boolean") props[k] = { type: "boolean" };
    else if (v === null) props[k] = { type: ["string", "null"] };
    else props[k] = { type: "object" };
  }
  return { type: "object", properties: props, required: Object.keys(example) };
}

/**
 * x402 v2 `extensions.bazaar` — input/output JSON Schema on every discovery-declared paid 402.
 * Required by @agentcash/discovery + MPPScan (extensions.bazaar.schema.properties.input|output).
 * CDP Bazaar settle-time cataloging still only indexes agent_ask; other SKUs carry bazaar for discovery probes only.
 */
export function x402BazaarExtension(sku: Sku): { bazaar: unknown } | null {
  const shape = BAZAAR_SHAPES[sku.id];
  if (!shape || !BAZAAR_DISCOVERY_SKUS.has(sku.id)) return null;
  return {
    bazaar: {
      description: skuDescription(sku),
      info: { input: shape.input, output: shape.output },
      schema: {
        $schema: "https://json-schema.org/draft/2020-12/schema",
        type: "object",
        properties: {
          input: {
            type: "object",
            properties: {
              type: { type: "string" },
              method: { type: "string" },
              bodyType: { type: "string" },
              body: { type: "object", ...shape.bodySchema },
            },
            required: ["type", "method", "body"],
          },
          output: {
            type: "object",
            properties: {
              type: { type: "string" },
              example: bazaarOutputSchema(shape.output.example),
            },
            required: ["example"],
          },
        },
        required: ["input", "output"],
      },
    },
  };
}

/**
 * Human-readable, semantic SKU descriptions. CDP Bazaar's ranking explicitly weights metadata
 * quality (descriptions/schemas/examples), and these read better than "Ishtar agent_ask" to any
 * agent scanning the catalog. Threaded into the 402 ResourceInfo AND the CDP Bazaar extension.
 */
export const SKU_DESCRIPTIONS: Record<string, string> = {
  notice: "Publish a notice on plaintext — a paid plain-text bulletin board. POST your text, pay $3.00, and it is minted as an ERC-721 token onchain with the body content-addressed to a real IPFS CID. Optionally name an owner address to receive the token.",
  remark: "Leave a remark under a plaintext notice — $0.50. POST text + the parent notice's gid; the remark is minted onchain and threads under its parent on the board.",
};
export const skuDescription = (sku: Sku): string => SKU_DESCRIPTIONS[sku.id] ?? `plaintext ${sku.id}`;

/** x402 v2 top-level ResourceInfo (the resource the payment unlocks). `url` is a full URL (required). */
export function x402ResourceInfo(env: Env, sku: Sku) {
  return { url: `${apiBase(env)}${sku.route}`, description: skuDescription(sku), mimeType: "application/json" };
}

/**
 * x402 v2 wire header codec. v2 carries PaymentRequired/PaymentSignature/PaymentResponse as base64(JSON) in
 * HTTP headers (PAYMENT-REQUIRED ← challenge, PAYMENT-SIGNATURE → payment, PAYMENT-RESPONSE ← settlement),
 * matching @x402/core `safeBase64Encode` = btoa(utf8 bytes). The JSON body is only read by v1 clients.
 */
export function encodeX402Header(obj: unknown): string {
  const bytes = new TextEncoder().encode(JSON.stringify(obj));
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

/**
 * 402 challenge — DUAL-RAIL wire. x402 v2 clients read PaymentRequired from the PAYMENT-REQUIRED
 * header; when MPP is enabled for the SKU the same 402 also carries a `WWW-Authenticate: Payment`
 * challenge (disjoint header spaces — each client parses only its own; live-proven pattern).
 * MPP requires `Cache-Control: no-store` on 402s; harmless for x402 clients, so set always.
 */
export async function x402Challenge(env: Env, sku: Sku, orderId: string): Promise<Response> {
  const accepts = await x402Accepts(env, sku);
  if (!accepts.length) {
    return new Response(JSON.stringify({ error: "payments not configured" }), { status: 503, headers: { "content-type": "application/json" } });
  }
  const ext = x402BazaarExtension(sku); // CDP Bazaar discovery metadata (agent_ask only)
  const body = {
    x402Version: X402_VERSION,
    error: "payment required",
    resource: x402ResourceInfo(env, sku), // v2: ResourceInfo object at the top level, not inside accepts
    accepts,
    ...(ext ? { extensions: ext } : {}), // top-level extensions (client echoes them into the payload)
  };
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "cache-control": "no-store",
    "x-order-id": orderId,
    "PAYMENT-REQUIRED": encodeX402Header(body), // v2 clients read here; body is v1-only fallback
  };
  if (mppEnabled(env) && mppSkuActive(env, sku)) headers["WWW-Authenticate"] = await buildMppChallengeHeader(env, sku);
  return new Response(JSON.stringify(body, null, 2), { status: 402, headers });
}

// ── CDP (mainnet) auth: a per-request EdDSA Bearer JWT ─────────────────────────────────────────────
const jwtEnc = new TextEncoder();
const b64url = (b: Uint8Array): string => btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const fromB64 = (s: string): Uint8Array => Uint8Array.from(atob(s.trim()), (c) => c.charCodeAt(0));

/**
 * Mint a Coinbase CDP Bearer JWT (EdDSA / Ed25519) bound to ONE request (method+host+path), valid ~2 min.
 * A CDP "Secret API Key" is base64 of a 64-byte Ed25519 key ([32-byte seed][32-byte public]); we wrap the
 * seed in the fixed Ed25519 PKCS8 prefix and sign with Web Crypto (no Node deps; runs in the Worker).
 */
export async function cdpBearer(keyId: string, secretB64: string, method: string, host: string, path: string): Promise<string> {
  const raw = fromB64(secretB64);
  const seed = raw.length >= 32 ? raw.slice(0, 32) : raw; // Ed25519 private seed = first 32 bytes
  const pkcs8 = new Uint8Array([0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20, ...seed]);
  const key = await crypto.subtle.importKey("pkcs8", pkcs8, { name: "Ed25519" }, false, ["sign"]);
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "EdDSA", typ: "JWT", kid: keyId, nonce: b64url(crypto.getRandomValues(new Uint8Array(16))) };
  const payload = { sub: keyId, iss: "cdp", aud: ["cdp_service"], nbf: now, exp: now + 120, uris: [`${method} ${host}${path}`] };
  const signingInput = `${b64url(jwtEnc.encode(JSON.stringify(header)))}.${b64url(jwtEnc.encode(JSON.stringify(payload)))}`;
  const sig = new Uint8Array(await crypto.subtle.sign({ name: "Ed25519" }, key, jwtEnc.encode(signingInput)));
  return `${signingInput}.${b64url(sig)}`;
}

interface ModeCfg {
  network: string;
  facilitator: string;
  asset: string;
  mainnet: boolean;
  // EIP-712 domain of the asset, required in PaymentRequirements.extra so the v2 exact-EVM client can build the
  // EIP-3009 typed-data signature. Base USDC mainnet: name "USD Coin", version "2" (verified on-chain + SDK registry).
  eip712: { name: string; version: string };
}
function evmModeCfg(env: Env): ModeCfg {
  if (env.X402_MODE === "mainnet")
    return { network: MAINNET_NETWORK, facilitator: CDP_FACILITATOR, asset: USDC_BASE_MAINNET, mainnet: true, eip712: { name: "USD Coin", version: "2" } };
  return { network: STAGING_NETWORK, facilitator: STAGING_FACILITATOR, asset: USDC_BASE_SEPOLIA, mainnet: false, eip712: { name: "USDC", version: "2" } };
}

/**
 * Facilitator-backed provider. Staging = Base-Sepolia + Solana Devnet via x402.org (/verify only).
 * Mainnet = Base + Solana via CDP, JWT-authed, verify→SETTLE. verify() FAIL-CLOSED; signed TERMS
 * (amount/recipient/network) checked independently of the facilitator (red-team C3/C4/H8).
 * Resource server holds NO chain private keys — only payTo pubkeys; CDP sponsors Solana fees via feePayer.
 */
export function makeX402Provider(env: Env): PaymentProvider {
  const evmCfg = evmModeCfg(env);
  return {
    network: evmCfg.network,
    facilitator: evmCfg.facilitator,
    async verify(paymentHeader: string, sku: Sku): Promise<VerifiedPayment> {
      try {
        const terms = parsePaymentTerms(paymentHeader);
        if (!terms || !terms.value || !terms.to) return { verified: false, raw: "payment terms unreadable" };
        const payTo = expectedPayTo(env, terms.rail);
        if (!payTo) return { verified: false, raw: "rail not configured" };
        let value: bigint;
        try {
          value = BigInt(terms.value);
        } catch {
          return { verified: false, raw: "bad amount" };
        }
        const required = BigInt(Math.round(Number(sku.priceUsd.replace("$", "")) * 1e6));
        if (value < required) return { verified: false, raw: "underpayment" };
        if (!payToMatches(payTo, terms.to, terms.rail)) return { verified: false, raw: "payTo mismatch" };
        const network = railNetwork(env, terms.rail);
        if (terms.network && terms.network !== network) return { verified: false, raw: "network mismatch" };
        const ok = (): VerifiedPayment => ({
          verified: true,
          nonce: terms.nonce,
          payTo: terms.to,
          network,
          amountUsdc: (Number(value) / 1e6).toFixed(6),
        });

        const paymentRequirementsRaw = await requirementsForRail(env, sku, terms.rail);
        if (!paymentRequirementsRaw) return { verified: false, raw: "requirements unavailable" };
        const ext = x402BazaarExtension(sku);
        const paymentRequirements = { ...paymentRequirementsRaw, ...(ext ? { extensions: ext } : {}) };
        const mainnet = env.X402_MODE === "mainnet";
        const facilitator = railFacilitator(env, terms.rail);

        if (mainnet) {
          if (!env.CDP_API_KEY_ID || !env.CDP_API_KEY_SECRET) return { verified: false, raw: "cdp keys missing" };
          const host = "api.cdp.coinbase.com";
          const base = "/platform/v2/x402";
          const paymentPayload = decodePayment(paymentHeader);
          if (!paymentPayload) return { verified: false, raw: "payment payload unreadable" };
          if (!paymentPayload.resource) paymentPayload.resource = x402ResourceInfo(env, sku).url;
          const body = JSON.stringify({ x402Version: X402_VERSION, paymentPayload, paymentRequirements });
          const vTok = await cdpBearer(env.CDP_API_KEY_ID, env.CDP_API_KEY_SECRET, "POST", host, `${base}/verify`);
          const vr = await fetch(`${facilitator}/verify`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${vTok}` }, body });
          if (!vr.ok) return { verified: false, raw: `cdp verify ${vr.status}` };
          const vj = (await vr.json()) as { isValid?: boolean; invalidReason?: string; payer?: string };
          if (!vj.isValid) return { verified: false, raw: vj.invalidReason ?? "cdp rejected" };
          const sTok = await cdpBearer(env.CDP_API_KEY_ID, env.CDP_API_KEY_SECRET, "POST", host, `${base}/settle`);
          const sr = await fetch(`${facilitator}/settle`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${sTok}` }, body });
          const extResp = sr.headers.get("EXTENSION-RESPONSES");
          if (extResp) console.log(JSON.stringify({ at: "x402.settle", sku: sku.id, rail: terms.rail, extensionResponses: extResp }));
          if (!sr.ok) return { verified: false, raw: `cdp settle ${sr.status}` };
          const sj = (await sr.json()) as { success?: boolean; errorReason?: string; transaction?: string; payer?: string };
          if (!sj.success) return { verified: false, raw: sj.errorReason ?? "cdp settle failed" };
          return { ...ok(), payer: sj.payer, tx: sj.transaction };
        }

        // Staging: keyless x402.org facilitator, /verify only (testnet — no real settlement).
        const res = await fetch(`${facilitator}/verify`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            x402Version: X402_VERSION,
            paymentPayload: decodePayment(paymentHeader),
            paymentRequirements,
          }),
        });
        if (!res.ok) return { verified: false, raw: `facilitator ${res.status}` };
        const j = (await res.json()) as VerifiedPayment & { isValid?: boolean };
        if (!(j.verified ?? j.isValid ?? false)) return { verified: false, raw: j.raw ?? "facilitator rejected" };
        return { ...j, ...ok(), payer: j.payer };
      } catch (err) {
        return { verified: false, raw: `verify_error: ${(err as Error).message}` };
      }
    },
  };
}
