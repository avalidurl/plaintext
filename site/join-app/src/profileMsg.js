// MUST stay byte-identical to the server's normalize + profileMessage in
// site/src/profile.js — the client signs this exact string and the Worker rebuilds
// it to verify. Any divergence = every save rejected as "bad signature".

const clean = (v, max) => (typeof v === "string" ? v.trim().slice(0, max) : "");
const handle = (v, max) => clean(v, max).replace(/^@+/, "").replace(/[^A-Za-z0-9_.-]/g, "");
const url = (v) => {
    const s = clean(v, 200);
    return /^https?:\/\/[^\s]+$/i.test(s) ? s : "";
};

export function normalize(input) {
    return {
        bio: clean(input.bio, 500),
        website: url(input.website),
        x: handle(input.x, 40),
        github: handle(input.github, 40),
        telegram: handle(input.telegram, 40),
    };
}

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
