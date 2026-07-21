import {recoverMessageAddress} from "viem";

// Profile fields we accept, with per-field limits. Everything else is dropped.
const LIMITS = {bio: 500, website: 200, x: 40, github: 40, telegram: 40};

const clean = (v, max) => (typeof v === "string" ? v.trim().slice(0, max) : "");
// Handles: strip a leading @ and anything not handle-ish. Never a full URL.
const handle = (v, max) => clean(v, max).replace(/^@+/, "").replace(/[^A-Za-z0-9_.-]/g, "");
// Website: only http(s), else empty — never emit a javascript:/data: URL later.
const url = (v) => {
    const s = clean(v, LIMITS.website);
    return /^https?:\/\/[^\s]+$/i.test(s) ? s : "";
};

function normalize(input) {
    return {
        bio: clean(input.bio, LIMITS.bio),
        website: url(input.website),
        x: handle(input.x, LIMITS.x),
        github: handle(input.github, LIMITS.github),
        telegram: handle(input.telegram, LIMITS.telegram),
    };
}

/**
 * The exact string the client signs, rebuilt server-side from the NORMALIZED
 * fields. Signing the normalized form means the signature covers exactly what we
 * store — a client can't sign one thing and store another.
 */
export function profileMessage(address, p, ts) {
    return [
        "plaintext profile",
        `address: ${address.toLowerCase()}`,
        `bio: ${p.bio}`,
        `website: ${p.website}`,
        `x: ${p.x}`,
        `github: ${p.github}`,
        `telegram: ${p.telegram}`,
        `ts: ${ts}`,
    ].join("\n");
}

/**
 * Verify a signed profile update and store it. Ownership is the signature: we
 * recover the signer and require it to equal the claimed address, which must
 * already be a hand (has a name on-chain). No session, no password.
 */
export async function saveProfile(env, body) {
    const {address, signature, ts} = body || {};
    if (!/^0x[0-9a-fA-F]{40}$/.test(address || "") || !/^0x[0-9a-fA-F]+$/.test(signature || "")) {
        return new Response("bad request", {status: 400});
    }
    // Replay window: the signed timestamp must be recent.
    const now = Math.floor(Date.now() / 1000);
    if (!Number.isFinite(ts) || Math.abs(now - ts) > 600) {
        return new Response("stale signature", {status: 400});
    }

    const p = normalize(body);
    const message = profileMessage(address, p, ts);

    let recovered;
    try {
        recovered = await recoverMessageAddress({message, signature});
    } catch {
        return new Response("bad signature", {status: 401});
    }
    if (recovered.toLowerCase() !== address.toLowerCase()) {
        return new Response("signature does not match address", {status: 401});
    }

    // Must be a hand — you can only decorate a page you actually hold.
    const hand = await env.DB.prepare("SELECT 1 FROM hands WHERE address = ?1").bind(address.toLowerCase()).first();
    if (!hand) return new Response("not a hand", {status: 403});

    await env.DB.prepare(
        `INSERT INTO profiles (address,bio,website,x,github,telegram,updated_at)
         VALUES (?1,?2,?3,?4,?5,?6,?7)
         ON CONFLICT(address) DO UPDATE SET
           bio=excluded.bio, website=excluded.website, x=excluded.x,
           github=excluded.github, telegram=excluded.telegram, updated_at=excluded.updated_at`,
    )
        .bind(address.toLowerCase(), p.bio, p.website, p.x, p.github, p.telegram, now)
        .run();

    return Response.json({ok: true, profile: p});
}

export const getProfile = (env, address) =>
    env.DB.prepare("SELECT bio,website,x,github,telegram FROM profiles WHERE address = ?1").bind(address.toLowerCase()).first();
