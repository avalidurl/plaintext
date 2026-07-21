# plaintext

Contracts for a plaintext bulletin board. One textarea. Each hand keeps its own page.
Every notice is an ERC-721 whose `tokenURI` points at IPFS.

Chain: **Robinhood Chain (4663)**, an Arbitrum Orbit L2. Gas is **ETH**.

## Design

**No owner. No admin. No setter. No upgrade path.** Prices are `constant`, expressed in
US cents, and converted to ETH at call time through Chainlink. Nobody can change them
— including whoever deploys it.

| | |
|---|---|
| `enter()` | $1.00 — a name is dealt to you |
| `enterAs(handle)` | $5.00 — you choose the name |
| `post(cid)` | $3.00 — publish a notice |
| `reply(parent, cid)` | $0.50 — reply |
| `tip(id)` | any amount, straight to the author, **no cut taken** |

Payment and publication are a single call from the user's own wallet. The contract never
custodies anything: fees forward to the treasury in the same transaction, overage is
refunded, and `address(this).balance` is asserted to be zero after every path. There is
no `receive`/`fallback` — ETH only enters through a priced door.

## Verified facts (checked by direct RPC call, not assumed)

- Chain **4663** (`0x1237`), `nitro/v3.11.3`, ~101ms blocks. Testnet is **46630**.
- Contract deployment is **permissionless** — docs, `eth_estimateGas` from an unfunded
  EOA, and ArbOwner having no `isAllowedSender` all agree.
- Chainlink **ETH/USD** at `0x78F3556b67E17Df817D51Ef5a990cDaF09E8d3A9` —
  `description()` = `"ETH / USD"`, 8 decimals. Exercised live in `test/Fork.t.sol`.
- **PUSH0 is supported.** ArbOS reports 116 (threshold 11) and a raw `PUSH0 PUSH0 RETURN`
  payload executes on-chain. No EVM-version downgrade needed for solc 0.8.28.

## ⚠️ Three traps

**1. The ETH/USD feed on 4663 has an 86400s (24h) heartbeat — not the 3600s used on
Ethereum mainnet.** It is routinely many hours stale by design. A copy-pasted
`require(block.timestamp - updatedAt < 1 hours)` guard **bricks the contract on an
ordinary afternoon.** `MAX_STALENESS` is 25h. Do not lower it. Two tests exist solely
to hold this line.

**2. Chainlink does not operate a feed on testnet 46630.** The mainnet aggregator address
has no code there and no testnet entry exists in Chainlink's directory. Testnet therefore
deploys `src/testnet/StubFeed.sol`. That stub is the **only** difference between a testnet
and a mainnet deployment — `Plaintext` itself is byte-identical. Never point mainnet at it.

**3. An `[etherscan]` block naming chain 4663 breaks `--fork-url`** with
`Error: Chain 4663 not supported`. It is deliberately absent from `foundry.toml`; pass
verifier flags explicitly instead.

## Use

```bash
forge build
forge test                                                          # 29 local
forge test --match-contract ForkTest --fork-url rh_mainnet \
           --no-storage-caching                                     # 3 against the live feed

# deploy (PRIVATE_KEY in env; never commit it)
forge script script/Deploy.s.sol --rpc-url rh_testnet --broadcast   # stub feed
forge script script/Deploy.s.sol --rpc-url rh_mainnet --broadcast   # real feed
```

## Audit status

**Slither, Aderyn, Mythril and Semgrep have all been run.** 34 tests pass (31 local,
3 against the live mainnet feed). Aderyn reports **zero High issues**.

Fixed as a result: checks-effects-interactions in `_take`/`_disburse` and in the
constructor; `name` shadowing `ERC721.name()`; missing zero-check on the treasury;
and the dealt-name entropy bug below.

**Mythril: "No issues were detected."** That result is only meaningful because the
tool was proven live first — Mythril 0.24.8 fetches solc from a dead hostname and
**silently exits 0 when that fails**, so a clean scan can mean no scan. A
deliberately reentrant control contract was run through the identical invocation
and correctly fired SWC-107/114 before the clean result was believed.

**Semgrep: 13 findings, all INFO/performance, zero security.** Caveat worth keeping:
`p/security-audit` contains **no Solidity rules at all** — its clean result is
absence of evidence. `p/smart-contracts` (50 rules) is the one that ran.

### The entropy bug, and why it mattered

`_deal()` originally hashed `(msg.sender, block.prevrandao)`. On chain 4663
**PREVRANDAO returns literally `1`** — verified by `eth_call` against a raw `0x44`
payload. So the dealt name had *zero* entropy: a pure, publicly computable function
of the address.

That is not just a griefing risk. With a 16-character alphabet and 8-character
names, anyone could grind addresses offline until one dealt a desirable name and
take it for **$1, bypassing the $5 chosen-name tier** — hollowing out the price
ladder. Now seeded with `blockhash(block.number - 1)` (verified to return real,
block-varying values on 4663) plus an entry counter. At ~101ms blocks there is no
window to grind 16^8 candidates. Two tests hold this line.

### Accepted, deliberate

- **`timestamp` comparison** (Slither) — that comparison *is* the staleness guard.
- **`unused-return`** (Slither) — false positive; the tuple is destructured.
- **ETH can be force-fed via `selfdestruct`** and there is no sweep. No user funds
  at risk, no attacker gain; every normal path is exactly balance-neutral.
- **`enterAs` is mempool-snipeable** — first-come naming with no commit-reveal.
  Inherent, and uninteresting at $5 a name.
- **`cid` is only checked non-empty**, so `tokenURI` can return `ipfs://` + an
  arbitrary string. An off-chain rendering concern; the site escapes it.

**Still unaudited by a third party. Do not deploy to mainnet on this basis alone.**

## Layout

```
src/Plaintext.sol            the contract
src/testnet/StubFeed.sol     TESTNET ONLY price feed stand-in
script/Deploy.s.sol          picks the feed by chain id
test/Plaintext.t.sol         29 tests, incl. 2 fuzz campaigns
test/Fork.t.sol              3 tests against the live mainnet feed
test/MockFeed.sol            drives price, staleness, malformed rounds
```
