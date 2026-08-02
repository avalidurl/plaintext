-- plaintext — D1 schema.
--
-- The chain is the source of truth. hands/notices/cursor/links are a CACHE,
-- rebuildable by replaying logs, so this file DROPs and recreates them. `profiles`
-- is off-chain (signed, not derivable from the chain) — it is NEVER dropped.
--
-- MULTI-CONTRACT: the board indexes a LIST of contract versions, not one. A notice
-- is identified on-chain by (contract, token_id); the board gives it a stable global
-- id (`gid`) for its URL. Deploying a new contract ADDS it to the list — the old
-- contract keeps being read, so no update ever nukes existing posts.

DROP TABLE IF EXISTS notices;
DROP TABLE IF EXISTS hands;
DROP TABLE IF EXISTS links;
DROP TABLE IF EXISTS cursor;

CREATE TABLE hands (
    address     TEXT PRIMARY KEY,          -- lowercase 0x… (identity is the address)
    name        TEXT NOT NULL,             -- NOT unique: two addresses can hold the
                                           -- same name on different contract versions
    chosen      INTEGER NOT NULL DEFAULT 0,
    entered_at  INTEGER NOT NULL,
    block       INTEGER NOT NULL,
    name_block  INTEGER NOT NULL DEFAULT 0,-- block of the latest name event; latest wins
    tx          TEXT NOT NULL
);
CREATE INDEX idx_hands_name ON hands(name);

CREATE TABLE notices (
    gid         INTEGER PRIMARY KEY AUTOINCREMENT, -- the board's stable notice id (URLs)
    contract    TEXT NOT NULL,             -- which contract version minted it
    token_id    INTEGER NOT NULL,          -- the ERC-721 token id within that contract
    author      TEXT NOT NULL,             -- lowercase 0x…
    parent_gid  INTEGER NOT NULL DEFAULT 0,-- 0 = top-level; else the parent's gid
    cid         TEXT NOT NULL,
    body        TEXT,                      -- cached from IPFS/R2; NULL until fetched
    title       TEXT,                      -- first non-empty line, for row + tab label
    created_at  INTEGER NOT NULL,
    block       INTEGER NOT NULL,
    tx          TEXT NOT NULL,
    tips_wei    TEXT NOT NULL DEFAULT '0',
    UNIQUE (contract, token_id)
);
CREATE INDEX idx_notices_created ON notices(created_at DESC);
CREATE INDEX idx_notices_author  ON notices(author, created_at DESC);
CREATE INDEX idx_notices_parent  ON notices(parent_gid, created_at ASC);
CREATE INDEX idx_notices_top     ON notices(parent_gid, created_at DESC);

-- Indexer bookkeeping. One row per contract: k = 'logs:<contract>'.
CREATE TABLE cursor (
    k           TEXT PRIMARY KEY,
    last_block  INTEGER NOT NULL
);

-- Wikilink edges keyed on the SOURCE notice's gid. `key` is a target gid (kind='id')
-- or lowercased target title (kind='title'); raw key so forward refs still backlink.
CREATE TABLE links (
    src_gid     INTEGER NOT NULL,
    kind        TEXT NOT NULL,   -- 'id' | 'title'
    key         TEXT NOT NULL,
    UNIQUE (src_gid, kind, key)
);
CREATE INDEX idx_links_target ON links(kind, key);

-- Bodies pinned but not yet confirmed on-chain. Harmless orphans, swept periodically.
CREATE TABLE IF NOT EXISTS orphan_pins (
    cid         TEXT PRIMARY KEY,
    pinned_at   INTEGER NOT NULL
);

-- Agent-write payment ledger (x402/MPP). One settlement = one write; `key` is the
-- EIP-3009 nonce or MPP settlement tx, `ref` the client idempotency key, `result`
-- the JSON we returned. A MONEY RECORD — never dropped, never rebuilt.
CREATE TABLE IF NOT EXISTS agent_payments (
    key         TEXT PRIMARY KEY,
    ref         TEXT,
    result      TEXT,
    created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_agent_payments_ref ON agent_payments(ref);

-- Off-chain profile metadata (bio, links). NOT rebuildable from the chain — signed
-- by the owner (see /api/profile). NEVER dropped.
CREATE TABLE IF NOT EXISTS profiles (
    address     TEXT PRIMARY KEY,
    bio         TEXT,
    website     TEXT,
    x           TEXT,
    github      TEXT,
    telegram    TEXT,
    updated_at  INTEGER NOT NULL
);
