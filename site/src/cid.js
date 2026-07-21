/**
 * Content addressing, computed in the Worker with Web Crypto only — no Node, no
 * external service, no API key.
 *
 * Produces a CIDv1 with the raw codec (0x55) over a sha2-256 multihash. For a
 * single block this is exactly what `ipfs add --cid-version=1 --raw-leaves`
 * yields, so the CID we mint on-chain is a genuine IPFS address: anyone can pin
 * these bytes to any IPFS node later and get the identical CID. Bodies are small
 * (≤64 KB, one block), so there is no chunking to worry about.
 *
 * The board stores the exact bytes it hashes and serves them back at /ipfs/<cid>,
 * so the address always verifies against the content.
 */

const B32 = "abcdefghijklmnopqrstuvwxyz234567";

function base32(bytes) {
    let out = "";
    let bits = 0;
    let value = 0;
    for (const b of bytes) {
        value = (value << 8) | b;
        bits += 8;
        while (bits >= 5) {
            out += B32[(value >>> (bits - 5)) & 31];
            bits -= 5;
        }
    }
    if (bits > 0) out += B32[(value << (5 - bits)) & 31];
    return out;
}

/** CIDv1 / raw / sha2-256 for a UTF-8 string, as a `bafkrei…` multibase string. */
export async function cidForText(text) {
    const bytes = new TextEncoder().encode(text);
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
    // multihash: 0x12 (sha2-256) 0x20 (32 bytes) || digest
    // cid prefix: 0x01 (cidv1) 0x55 (raw codec)
    const wrapped = new Uint8Array(4 + digest.length);
    wrapped.set([0x01, 0x55, 0x12, 0x20], 0);
    wrapped.set(digest, 4);
    return "b" + base32(wrapped); // 'b' = base32 multibase prefix
}
