# plaintext — site

The Worker behind `plaintext.numetal.xyz`. Renders the board; never holds funds,
never signs anything.

## Shape

Cloudflare Worker + D1 + R2. No framework, no build step, no dependencies at
runtime — the whole thing is three ES modules.

```
src/index.js    router, page handlers, cron
src/render.js   page shell, minimal block-only markdown, escaping
src/style.js    the entire stylesheet + the masthead
src/chain.js    eth_getLogs indexer and IPFS hydration
schema.sql      D1 tables
scripts/topics.sh  regenerate event topic0 constants
```

**The chain is the source of truth.** D1 is a cache and is rebuildable from
`Entered` / `Posted` / `Tipped` logs by replaying from block 0. If the two ever
disagree, the chain wins.

## Measured, not asserted

Verified against a running dev server with seeded data:

| | |
|---|---|
| stylesheet | **910 bytes** |
| index | 1,457 B |
| a notice with 2 replies | 1,633 B |
| manual | 1,974 B |
| `<script>` / `onclick` / `javascript:` on read paths | **0** |
| console errors | 0 |

Checked at 375×812 dark and desktop light. Reply indent is 24px, non-compounding
— deep threads stay readable on a phone.

## Design rules

Not preferences. Breaking one of these is a regression:

1. **No `font-family`, `font-size` or `line-height` anywhere.** The UA serif at
   its default size is the look. Never load a webfont.
2. `max-width:600px; margin:0 auto; padding:8px`. That rule is the entire
   responsive strategy — there are no breakpoints.
3. Stylesheet **under 1 KB**. There is a check for this; keep it passing.
4. **Zero JavaScript on read paths.** No analytics, no fonts, no embeds. Every
   interaction is a `<form method=post>` or an `<a>`.
5. Links are standalone block lines, never inline in prose.
6. Style four things: body, headings, `pre`, `blockquote`. Everything else stays
   browser-default, especially link colours.
7. Never `#fff`/`#000` — both are tinted.
8. `#1BC3FC` is **decorative only**. It fails WCAG AA on every background
   including white (2.05:1). Never text, never a link, never a meaningful icon.

The first non-empty line of a notice is its subject. It becomes the `<h1>` and is
stripped from the body so the page does not say it twice.

## Running it

```bash
npx wrangler d1 execute plaintext --local --file=schema.sql
npx wrangler dev --port 8794
```

Deploy is `npx wrangler deploy` (a Worker with a custom domain, same pattern as
the other subdomain sites on the zone).

**Before first deploy:** create the D1 database and fill `database_id` in
`wrangler.toml` (currently `REPLACE_ME`), create the R2 bucket, set the
`PINATA_JWT` secret, and set `CONTRACT` + `DEPLOY_BLOCK` once the contract is
live. The indexer no-ops while `CONTRACT` is `"0x"`, so a fresh Worker is inert
rather than wrong.

## ⚠️ Event topics fail silently

`TOPICS` in `src/chain.js` are keccak256 hashes of the event signatures, computed
with `cast keccak` and cross-checked against the compiled ABI. **A wrong constant
does not error — it matches no logs, so the indexer runs clean and the board just
looks empty.** Never hand-type them. Run `scripts/topics.sh` after any event
signature change.

## Not done

- `/enter` and the compose form — these need Privy and are the only pages that
  will carry JavaScript.
- Moderation tooling. There is none. The price is the only filter that exists
  today, and a fee filters casual spam and nothing else.
- No outbound email; Workers Free has none. There is no notification of any kind
  by design, which also means no "your transaction stalled" notice.
- Nothing is deployed and no D1/R2 resources exist yet.
