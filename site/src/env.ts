/**
 * Worker env surface used by the payment rails (ported from the proven Ishtar
 * implementation — same names, so the modules drop in unchanged).
 */
export interface Env {
  // payments — x402 (Base USDC via CDP facilitator)
  X402_MODE?: string; // "mainnet" | anything-else = staging
  PAY_TO?: string; // Base USDC recipient (treasury)
  CDP_API_KEY_ID?: string;
  CDP_API_KEY_SECRET?: string;
  X402_SOLANA_ENABLED?: string;
  PAY_TO_SOLANA?: string;
  PUBLIC_API_URL?: string;
  // payments — MPP (Tempo)
  MPP_ENABLED?: string;
  MPP_SECRET_KEY?: string;
  MPP_RECIPIENT?: string;
  MPP_CURRENCY?: string;
  MPP_REALM?: string;
  MPP_PULL_ENABLED?: string;
  TEMPO_RPC?: string;
  // relay — posts on Robinhood Chain for x402/MPP payers
  RELAY_KEY?: string;
  // board
  DB: D1Database;
  BODIES: R2Bucket;
  ASSETS: Fetcher;
  RPC_URL: string;
  CONTRACT: string;
  [key: string]: unknown;
}
