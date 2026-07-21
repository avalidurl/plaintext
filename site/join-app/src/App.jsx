import React, {useEffect, useState, useCallback} from "react";
import {usePrivy, useWallets, useSendTransaction, useLinkAccount} from "@privy-io/react-auth";
import {parseEther} from "viem";
import {read, data, balanceOf, CONTRACT} from "./chain.js";
import {normalize, profileMessage} from "./profileMsg.js";

const fmtEth = (wei) => (Number(wei) / 1e18).toFixed(6).replace(/0+$/, "").replace(/\.$/, "");

// Relay deep links, format + "robinhood" slug verified against relay.link's live
// chains API + deep-linking docs. Privy's own on-ramp can't reach 4663, so Relay
// is how funds move in/out and swap.
const USDG = "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168";
const ETH0 = "0x0000000000000000000000000000000000000000";
const DEPOSIT = (addr) => `https://relay.link/bridge/robinhood?toAddress=${addr}`;
const SWAP = (addr) =>
    `https://relay.link/bridge/robinhood?fromChainId=4663&toAddress=${addr}&fromCurrency=${ETH0}&toCurrency=${USDG}`;
const RELAY = DEPOSIT; // "add funds" warning uses the deposit link

// Copy-to-clipboard affordance — makes the EVM address one-click copyable.
function Copy({text}) {
    const [done, setDone] = useState(false);
    return (
        <a
            href="#"
            onClick={(e) => {
                e.preventDefault();
                navigator.clipboard?.writeText(text);
                setDone(true);
                setTimeout(() => setDone(false), 1200);
            }}
        >
            {done ? "copied" : "copy"}
        </a>
    );
}

export default function App() {
    const {ready, authenticated, user, login, logout} = usePrivy();
    const {wallets} = useWallets();
    const {sendTransaction} = useSendTransaction();
    const {linkEmail} = useLinkAccount();

    // A user can have more than one wallet — an X/email login mints an embedded
    // one, and they may also have connected their own (e.g. gokhan.eth). There is
    // no single right default (the embedded wallet is what a paying user funds;
    // the connected wallet is what a founder posts free from), so let them choose
    // which wallet they're acting as. Default to the embedded one when present.
    const [selectedAddr, setSelectedAddr] = useState(null);
    useEffect(() => {
        if (!selectedAddr && wallets?.length) {
            const embedded = wallets.find((w) => w.walletClientType === "privy");
            setSelectedAddr((embedded || wallets[0]).address);
        }
    }, [wallets, selectedAddr]);
    const wallet = wallets?.find((w) => w.address === selectedAddr) || wallets?.[0];
    const address = wallet?.address;
    const walletLabel = (w) => (w.walletClientType === "privy" ? "plaintext wallet" : "your wallet");

    const [state, setState] = useState(null); // {name, exempt, balance}
    const [status, setStatus] = useState("");
    const [busy, setBusy] = useState(false);

    const reply = new URLSearchParams(location.search).get("reply");
    const isReply = reply && /^\d+$/.test(reply);

    const refresh = useCallback(async () => {
        if (!address) return;
        try {
            const [name, exempt, balance] = await Promise.all([
                read("nameOf", [address]),
                read("exempt", [address]),
                balanceOf(address),
            ]);
            setState({name, exempt, balance});
        } catch (e) {
            setStatus("Couldn't read the chain. Retry in a moment.");
        }
    }, [address]);

    useEffect(() => {
        if (authenticated && address) refresh();
    }, [authenticated, address, refresh]);

    // Once we know this session's name, drop a cookie so the board's /me button
    // can resolve to /~name server-side (the board itself stays JS-free).
    useEffect(() => {
        if (state?.name && /^[a-z0-9-]{1,16}$/.test(state.name)) {
            document.cookie = `pt_hand=${state.name};path=/;max-age=31536000;samesite=lax`;
        }
    }, [state?.name]);

    // Arriving from a profile's "edit your page" link (/join#profile): once the
    // editor has rendered, scroll to it so the option isn't lost below the fold.
    useEffect(() => {
        if (state?.name && location.hash === "#profile") {
            const t = setTimeout(() => document.getElementById("profile")?.scrollIntoView({behavior: "smooth"}), 250);
            return () => clearTimeout(t);
        }
    }, [state?.name]);

    // Only social login? Nudge a durable backup — Privy's own warning: a
    // suspended X account otherwise means a permanently lost wallet + funds.
    const onlySocial =
        authenticated &&
        user &&
        !user.email &&
        !user.phone &&
        !(user.linkedAccounts || []).some((a) => ["email", "phone", "passkey"].includes(a.type));

    async function send(fnName, args, valueWei, pending) {
        try {
            setBusy(true);
            setStatus(pending);
            const tx = {to: CONTRACT, data: data(fnName, args)};
            if (valueWei && valueWei > 0n) tx.value = valueWei;
            const {hash} = await sendTransaction(tx, {address});
            setStatus("Sent. Waiting for the chain…");
            // brief poll so the UI settles before we send them to the board
            await new Promise((r) => setTimeout(r, 2500));
            setStatus("Done. It may take a minute to appear on the board.");
            await refresh();
            if (fnName === "post" || fnName === "reply") setTimeout(() => (location.href = "/"), 1500);
        } catch (e) {
            const m = (e && (e.shortMessage || e.message)) || "Transaction failed.";
            setStatus(/insufficient|funds|exceeds balance/i.test(m) ? "You need ETH on Robinhood Chain to pay for this." : m);
        } finally {
            setBusy(false);
        }
    }

    if (!ready) return <p className="t">Loading…</p>;

    if (!authenticated)
        return (
            <>
                <p>Sign in with X, an email, or a wallet. A wallet is made for you if you don't have one.</p>
                <p>
                    <button onClick={login}>Sign in</button>
                </p>
                <p className="t">Reading the board is free and needs none of this. This is only to write.</p>
            </>
        );

    return (
        <>
            <p className="t">
                {state?.name ? (
                    <>
                        <a href={`/~${state.name}`}>
                            <b>~{state.name}</b>
                        </a>
                        {" · "}
                    </>
                ) : ""}
                {address ? `${address.slice(0, 6)}…${address.slice(-4)}` : "provisioning your wallet…"}
                {address ? <> <Copy text={address} /></> : ""}
                {wallet ? ` · ${walletLabel(wallet)}` : ""}
                {state?.exempt ? " · writes free" : ""}
                {" · "}
                <a href="#" onClick={(e) => (e.preventDefault(), logout())}>
                    sign out
                </a>
            </p>

            {wallets && wallets.length > 1 && (
                <p className="t">
                    posting from:{" "}
                    {wallets.map((w, i) => (
                        <span key={w.address}>
                            {i > 0 && " · "}
                            <a
                                href="#"
                                onClick={(e) => (e.preventDefault(), setSelectedAddr(w.address))}
                                style={{fontWeight: w.address === address ? "bold" : "normal"}}
                            >
                                {w.address.slice(0, 6)}…{w.address.slice(-4)} ({walletLabel(w)})
                            </a>
                        </span>
                    ))}
                </p>
            )}

            {onlySocial && (
                <p className="warn">
                    You signed in with a social account only. If that account is ever suspended, this wallet and
                    anything in it are lost for good.{" "}
                    <a href="#" onClick={(e) => (e.preventDefault(), linkEmail())}>
                        Add an email backup
                    </a>
                    .
                </p>
            )}

            {state && !state.exempt && state.balance === 0n && (
                <p className="warn">
                    This wallet has no ETH on Robinhood Chain, so it can't pay yet.{" "}
                    <a href={RELAY(address)} target="_blank" rel="noreferrer">
                        Add funds
                    </a>{" "}
                    (bridges in from another chain).
                </p>
            )}

            {!state ? (
                <p className="t">Reading the chain…</p>
            ) : !state.name ? (
                <Door state={state} busy={busy} send={send} />
            ) : (
                <>
                    <Compose name={state.name} exempt={state.exempt} isReply={isReply} reply={reply} busy={busy} send={send} />
                    {!isReply && (
                        <>
                            <div className="b" />
                            <ProfileEditor wallet={wallet} address={address} />
                            <div className="b" />
                            <RenameBox exempt={state.exempt} busy={busy} send={send} />
                        </>
                    )}
                </>
            )}

            {wallets?.some((w) => w.walletClientType === "privy") && (
                <>
                    <div className="b" />
                    <WalletTools embedded={wallets.find((w) => w.walletClientType === "privy")} />
                </>
            )}

            <p id="status">{status}</p>
        </>
    );
}

function Door({state, busy, send}) {
    const [name, setName] = useState("");
    const [dealt, setDealt] = useState(null);
    const [chosen, setChosen] = useState(null);
    useEffect(() => {
        (async () => {
            if (state.exempt) {
                setDealt(0n);
                setChosen(0n);
            } else {
                setDealt(await read("doorAssignedWei"));
                setChosen(await read("doorChosenWei"));
            }
        })();
    }, [state.exempt]);
    const usd = state.exempt ? "free" : null;
    return (
        <>
            <p className="t">You're not through the door yet.</p>
            <p>
                <button disabled={busy || dealt === null} onClick={() => send("enter", [], dealt, "Entering…")}>
                    {state.exempt ? "Enter free — name dealt to you" : "Enter for ~$1 — name dealt to you"}
                </button>
            </p>
            <p>
                <input
                    value={name}
                    onChange={(e) => setName(e.target.value.toLowerCase())}
                    placeholder="a name: a-z 0-9 -, up to 16"
                    maxLength={16}
                    autoCapitalize="off"
                    autoComplete="off"
                />{" "}
                <button
                    disabled={busy || chosen === null}
                    onClick={() => {
                        if (!/^[a-z][a-z0-9-]{0,15}$/.test(name)) return alert("Name must start with a letter; a-z 0-9 - only.");
                        send("enterAs", [name], chosen, "Taking the name…");
                    }}
                >
                    {state.exempt ? "Take it free" : "Take it for ~$5"}
                </button>
            </p>
        </>
    );
}

// Withdraw + export for the Privy embedded wallet. It's the user's key (export
// enabled), so we make leaving easy — both are self-custody escape hatches.
function WalletTools({embedded}) {
    const {sendTransaction} = useSendTransaction();
    const {exportWallet} = usePrivy(); // v2.25: exportWallet is a usePrivy method, not a standalone hook
    const addr = embedded.address;
    const [bal, setBal] = useState(null);
    const [to, setTo] = useState("");
    const [amt, setAmt] = useState("");
    const [msg, setMsg] = useState("");
    const [busy, setBusy] = useState(false);

    const loadBal = () => balanceOf(addr).then(setBal).catch(() => {});
    useEffect(() => {
        loadBal();
    }, [addr]);

    async function withdraw(all) {
        try {
            if (!/^0x[0-9a-fA-F]{40}$/.test(to.trim())) return alert("Enter a valid 0x recipient address.");
            const reserve = 50_000_000_000_000n; // ~0.00005 ETH kept back for gas on "all"
            const value = all ? (bal ?? 0n) - reserve : parseEther(amt || "0");
            if (value <= 0n) return alert("Amount is too small (or the wallet is empty).");
            setBusy(true);
            setMsg("Confirm in your wallet…");
            const {hash} = await sendTransaction({to: to.trim(), value}, {address: addr});
            setMsg(`Sent — ${hash.slice(0, 10)}…`);
            setTo("");
            setAmt("");
            setTimeout(loadBal, 3000);
        } catch (e) {
            const m = e?.shortMessage || e?.message || "Failed.";
            setMsg(/insufficient|exceeds/i.test(m) ? "Not enough ETH (leave a little for gas)." : m);
        } finally {
            setBusy(false);
        }
    }

    return (
        <>
            <p className="t">
                your plaintext wallet{bal != null ? ` · ${fmtEth(bal)} ETH` : ""} · {`${addr.slice(0, 6)}…${addr.slice(-4)}`}{" "}
                <Copy text={addr} />
            </p>
            <p>
                <button onClick={() => window.open(DEPOSIT(addr), "_blank", "noopener")}>Deposit</button>{" "}
                <button onClick={() => window.open(SWAP(addr), "_blank", "noopener")}>Swap</button>{" "}
                <span className="t">(via Relay — bridge in from any chain, or swap ETH ↔ USDG)</span>
            </p>
            <p>
                <input value={to} onChange={(e) => setTo(e.target.value)} placeholder="withdraw to: 0x…" />{" "}
                <input value={amt} onChange={(e) => setAmt(e.target.value)} placeholder="ETH" style={{width: "6rem"}} />{" "}
                <button disabled={busy} onClick={() => withdraw(false)}>
                    Withdraw
                </button>{" "}
                <a href="#" onClick={(e) => (e.preventDefault(), withdraw(true))}>
                    all
                </a>
            </p>
            <p>
                <button disabled={busy} onClick={() => exportWallet({address: addr})}>
                    Export private key
                </button>{" "}
                <span className="t">{msg}</span>
            </p>
            <p className="t">This wallet is yours. Export the key into any wallet, or withdraw its funds anywhere — nothing here holds you.</p>
        </>
    );
}

function ProfileEditor({wallet, address}) {
    const [p, setP] = useState({bio: "", website: "", x: "", github: "", telegram: ""});
    const [msg, setMsg] = useState("");
    const [busy, setBusy] = useState(false);
    useEffect(() => {
        (async () => {
            try {
                const r = await fetch(`/api/profile?address=${address}`);
                if (r.ok) {
                    const cur = await r.json();
                    setP((v) => ({...v, ...cur, bio: cur.bio || "", website: cur.website || "", x: cur.x || "", github: cur.github || "", telegram: cur.telegram || ""}));
                }
            } catch {}
        })();
    }, [address]);

    const field = (k) => (e) => setP((v) => ({...v, [k]: e.target.value}));

    async function save() {
        try {
            setBusy(true);
            setMsg("Sign to save (free — this is a signature, not a transaction)…");
            const norm = normalize(p);
            const ts = Math.floor(Date.now() / 1000);
            const message = profileMessage(address, norm, ts);
            const provider = await wallet.getEthereumProvider();
            const signature = await provider.request({method: "personal_sign", params: [message, address]});
            const r = await fetch("/api/profile", {
                method: "POST",
                headers: {"content-type": "application/json"},
                body: JSON.stringify({address, ...norm, ts, signature}),
            });
            if (!r.ok) throw new Error(await r.text());
            setMsg("Saved. It shows on your page now.");
        } catch (e) {
            setMsg(e?.message || "Could not save.");
        } finally {
            setBusy(false);
        }
    }

    return (
        <div id="profile">
            <h2>edit your profile</h2>
            <p className="t">Bio and links. Saving is a free signature, not a transaction.</p>
            <p>
                <textarea rows={3} value={p.bio} onChange={field("bio")} placeholder="a short bio (up to 500 chars)" />
            </p>
            <p>
                <input value={p.website} onChange={field("website")} placeholder="website — https://…" />
            </p>
            <p>
                <input value={p.x} onChange={field("x")} placeholder="x / twitter handle" />{" "}
                <input value={p.github} onChange={field("github")} placeholder="github" />{" "}
                <input value={p.telegram} onChange={field("telegram")} placeholder="telegram" />
            </p>
            <p>
                <button disabled={busy} onClick={save}>
                    Save profile
                </button>{" "}
                <span className="t">{msg}</span>
            </p>
        </div>
    );
}

function RenameBox({exempt, busy, send}) {
    const [name, setName] = useState("");
    const [price, setPrice] = useState(null);
    useEffect(() => {
        (async () => setPrice(exempt ? 0n : await read("doorChosenWei")))();
    }, [exempt]);
    return (
        <>
            <p className="t">change your name {exempt ? "(free)" : "(~$5)"}</p>
            <p>
                <input
                    value={name}
                    onChange={(e) => setName(e.target.value.toLowerCase())}
                    placeholder="a new name: a-z 0-9 -"
                    maxLength={16}
                    autoCapitalize="off"
                    autoComplete="off"
                />{" "}
                <button
                    disabled={busy || price === null}
                    onClick={() => {
                        if (!/^[a-z][a-z0-9-]{0,15}$/.test(name)) return alert("Name must start with a letter; a-z 0-9 - only.");
                        send("rename", [name], price, "Changing your name…");
                    }}
                >
                    Rename
                </button>
            </p>
        </>
    );
}

function Compose({name, exempt, isReply, reply, busy, send}) {
    const [body, setBody] = useState("");
    const [price, setPrice] = useState(null);
    useEffect(() => {
        (async () => setPrice(exempt ? 0n : await read(isReply ? "remarkWei" : "noticeWei")))();
    }, [exempt, isReply]);
    const cost = exempt ? "free" : isReply ? "~$0.50" : "~$3.00";
    async function publish() {
        if (!body.trim()) return;
        const r = await fetch("/pin", {method: "POST", body});
        if (!r.ok) return alert("Could not store the text.");
        const {cid} = await r.json();
        if (isReply) send("reply", [BigInt(reply), cid], price, "Confirm in your wallet…");
        else send("post", [cid], price, "Confirm in your wallet…");
    }
    return (
        <>
            <p className="t">
                {isReply ? `replying to notice #${reply}` : `writing as ${name}`} · {cost}
            </p>
            <textarea
                rows={12}
                value={body}
                onChange={(e) => setBody(e.target.value)}
                placeholder="markdown, or nothing at all. the first line is the title. link with [[a title]]."
            />
            <p>
                <button disabled={busy || price === null} onClick={publish}>
                    {isReply ? "Post remark" : "Publish notice"}
                </button>
            </p>
        </>
    );
}
