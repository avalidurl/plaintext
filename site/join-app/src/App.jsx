import React, {useEffect, useState, useCallback} from "react";
import {usePrivy, useWallets, useSendTransaction, useLinkAccount, useConnectWallet} from "@privy-io/react-auth";
import {parseEther, encodeFunctionData} from "viem";
import {
    readName,
    readPosts,
    dataFor,
    chainFor,
    contractFor,
    balances,
    rhChain,
    ethChain,
    TIP_OPTIONS,
    dataErc20Transfer,
    dataContractTip,
    POSTS_CONTRACT,
} from "./chain.js";
import {parseUnits} from "viem";
import {normalize, profileMessage} from "./profileMsg.js";

const fmtEth = (wei) => (Number(wei) / 1e18).toFixed(6).replace(/0+$/, "").replace(/\.$/, "");
const short = (a) => `${a.slice(0, 6)}…${a.slice(-4)}`;

// Privy reports a connected wallet's network CAIP-2 style ("eip155:4663").
const chainOf = (w) => Number(String(w?.chainId ?? "").split(":").pop());

// "plaintext wallet" for the one we minted; otherwise the wallet's own name
// (MetaMask, Rabby, …) so a chooser row says something a human recognises.
const walletLabel = (w) =>
    w.walletClientType === "privy" ? "plaintext wallet" : w.meta?.name || w.walletClientType || "your wallet";

// Relay deep links — deposit FROM any chain/token TO the chain you pick; the
// wallet is one address on every EVM chain, so the destination is just a choice.
// "robinhood" slug verified against relay.link's live chains API. (Swap removed.)
const DEPOSIT_RH = (addr) => `https://relay.link/bridge/robinhood?toAddress=${addr}`;
const DEPOSIT_ETH = (addr) => `https://relay.link/bridge/ethereum?toAddress=${addr}`;
const RELAY = DEPOSIT_RH; // "add funds" warning uses the RH deposit link (notices)

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
    const {connectWallet} = useConnectWallet();

    // A user can have more than one wallet — an X/email login mints an embedded
    // one, and they may also connect their own (e.g. gokhan.eth). There is no
    // single right default (the embedded wallet is what a paying user funds; the
    // connected wallet is what a founder posts free from), and each address is a
    // SEPARATE hand on chain — its own name, its own exemption, its own balance.
    // So the choice is the user's, and the chooser shows what each one is.
    const [selectedAddr, setSelectedAddr] = useState(null);
    useEffect(() => {
        if (wallets?.length && !wallets.some((w) => w.address === selectedAddr)) {
            const embedded = wallets.find((w) => w.walletClientType === "privy");
            setSelectedAddr((embedded || wallets[0]).address);
        }
    }, [wallets, selectedAddr]);
    const wallet = wallets?.find((w) => w.address === selectedAddr) || wallets?.[0];
    const address = wallet?.address;

    // Name / exemption / balance PER wallet, so the chooser can label every row
    // without making you select a wallet just to find out what it is.
    const [info, setInfo] = useState({}); // {address: {name, exempt, balance}}
    const [status, setStatus] = useState("");
    const [busy, setBusy] = useState(false);
    const state = address ? info[address] ?? null : null;

    // The draft lives up here, not inside Compose. Switching wallets can swap the
    // compose box for the door (a wallet that hasn't entered yet), and typed text
    // must survive that — losing a draft to a click is unforgivable.
    const [draft, setDraft] = useState("");

    const reply = new URLSearchParams(location.search).get("reply");
    const isReply = reply && /^\d+$/.test(reply);
    const tipGid = new URLSearchParams(location.search).get("tip");
    const isTip = tipGid && /^\d+$/.test(tipGid);

    const load = useCallback(async (addr) => {
        try {
            // Name + exemption live on ETHEREUM (the name NFT); balances on both chains.
            const [name, exempt, bal] = await Promise.all([
                readName("nameOf", [addr]),
                readName("exempt", [addr]),
                balances(addr),
            ]);
            setInfo((m) => ({...m, [addr]: {name, exempt, rh: bal.rh, eth: bal.eth}}));
        } catch (e) {
            setStatus("Couldn't read the chain. Retry in a moment.");
        }
    }, []);
    const refresh = useCallback(() => (address ? load(address) : undefined), [address, load]);

    useEffect(() => {
        if (!authenticated) return;
        for (const w of wallets ?? []) load(w.address);
    }, [authenticated, wallets, load]);

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
        // Names (enter/enterAs/rename) are ETHEREUM transactions; posts/replies are
        // Robinhood ones. Route each write to its chain explicitly.
        const targetId = chainFor(fnName);
        const chainName = targetId === ethChain.id ? "Ethereum" : "Robinhood Chain (4663)";
        try {
            setBusy(true);
            // The embedded wallet follows the chainId we pass, but a connected
            // wallet is on whatever network its extension last used — sending
            // there would go to the wrong chain. Ask it to switch first.
            if (wallet && chainOf(wallet) !== targetId) {
                setStatus(`Switch your wallet to ${chainName} to continue…`);
                await wallet.switchChain(targetId);
            }
            setStatus(pending);
            const tx = {to: contractFor(fnName), data: dataFor(fnName, args), chainId: targetId};
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
            if (/insufficient|funds|exceeds balance/i.test(m)) {
                setStatus(`You need ETH on ${chainName} to pay for this.`);
            } else if (/chain|network|4663|switch/i.test(m)) {
                setStatus(`This wallet isn't on ${chainName}. Approve the network switch, then try again.`);
            } else {
                setStatus(m);
            }
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
                {address ? short(address) : "provisioning your wallet…"}
                {address ? <> <Copy text={address} /></> : ""}
                {wallet ? ` · ${walletLabel(wallet)}` : ""}
                {state?.exempt ? " · writes free" : ""}
                {" · "}
                <a href="#" onClick={(e) => (e.preventDefault(), logout())}>
                    sign out
                </a>
            </p>

            <WalletPicker
                wallets={wallets ?? []}
                selected={address}
                onSelect={setSelectedAddr}
                info={info}
                connectWallet={connectWallet}
            />

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

            {state && !state.exempt && !state.name && state.eth === 0n && (
                <p className="warn">
                    Your name mints on <b>Ethereum</b>, and this wallet has no ETH there yet. Send ETH on Ethereum
                    mainnet to {address ? short(address) : "it"} first.
                </p>
            )}
            {state && !state.exempt && state.name && state.rh === 0n && (
                <p className="warn">
                    Notices settle on Robinhood Chain, and this wallet has no ETH there.{" "}
                    <a href={RELAY(address)} target="_blank" rel="noreferrer">
                        Add funds
                    </a>{" "}
                    (bridges in from another chain).
                </p>
            )}

            {isTip ? (
                <TipBox wallet={wallet} address={address} gid={tipGid} />
            ) : !state ? (
                <p className="t">Reading the chain…</p>
            ) : !state.name ? (
                <>
                    {draft.trim() && (
                        <p className="t">
                            Your draft is kept — pick a wallet that's already through the door, or take a name with
                            this one.
                        </p>
                    )}
                    <Door state={state} busy={busy} send={send} />
                </>
            ) : (
                <>
                    <Compose
                        name={state.name}
                        exempt={state.exempt}
                        isReply={isReply}
                        reply={reply}
                        busy={busy}
                        send={send}
                        body={draft}
                        setBody={setDraft}
                    />
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

/**
 * Which wallet publishes. Always visible, even with one wallet — the board
 * charges real money to a real address, so which address is paying should never
 * be something you have to guess. Each row states what that wallet IS on chain:
 * its hand name (or that it hasn't been through the door), and what it can pay.
 */
function WalletPicker({wallets, selected, onSelect, info, connectWallet}) {
    if (!wallets.length) return <p className="t">Provisioning your wallet…</p>;
    return (
        <>
            <p className="t">publishing from</p>
            {wallets.map((w) => {
                const i = info[w.address];
                const on = w.address === selected;
                return (
                    <div key={w.address} className={on ? "p" : undefined} style={{padding: ".4rem .5rem"}}>
                        <label style={{cursor: "pointer"}}>
                            <input type="radio" name="wallet" checked={on} onChange={() => onSelect(w.address)} />{" "}
                            <b>{walletLabel(w)}</b> · {short(w.address)}
                            <br />
                            <span className="t">
                                {!i
                                    ? "reading the chain…"
                                    : `${i.name ? `~${i.name}` : "no name yet — the door first"} · ${
                                          i.exempt
                                              ? "writes free"
                                              : `rh ${i.rh != null ? fmtEth(i.rh) : "…"} · eth ${i.eth != null ? fmtEth(i.eth) : "…"}`
                                      }`}
                            </span>
                        </label>{" "}
                        <Copy text={w.address} />
                    </div>
                );
            })}
            <p className="t">
                <a href="#" onClick={(e) => (e.preventDefault(), connectWallet())}>
                    connect another wallet
                </a>{" "}
                · every wallet is its own hand here — its own name, its own notices.
            </p>
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
                setDealt(await readName("doorAssignedWei"));
                setChosen(await readName("doorChosenWei"));
            }
        })();
    }, [state.exempt]);
    return (
        <>
            <p className="t">
                You're not through the door yet. Your name is minted to you as an NFT on <b>Ethereum</b> — it's
                yours to keep, trade, or sell.
            </p>
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
    const [fromChain, setFromChain] = useState("rh"); // which chain the withdraw moves ETH on
    const [msg, setMsg] = useState("");
    const [busy, setBusy] = useState(false);

    const loadBal = () => balances(addr).then(setBal).catch(() => {});
    useEffect(() => {
        loadBal();
    }, [addr]);

    async function withdraw(all) {
        try {
            if (!/^0x[0-9a-fA-F]{40}$/.test(to.trim())) return alert("Enter a valid 0x recipient address.");
            const onEth = fromChain === "eth";
            const have = onEth ? bal?.eth ?? 0n : bal?.rh ?? 0n;
            // Mainnet gas is real; RH gas is dust. Reserve enough on each for the send itself.
            const reserve = onEth ? 300_000_000_000_000n : 50_000_000_000_000n;
            const value = all ? have - reserve : parseEther(amt || "0");
            if (value <= 0n) return alert("Amount is too small (or the wallet is empty on that chain).");
            setBusy(true);
            setMsg("Confirm in your wallet…");
            const {hash} = await sendTransaction(
                {to: to.trim(), value, chainId: onEth ? ethChain.id : rhChain.id},
                {address: addr},
            );
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
                your plaintext wallet · {`${addr.slice(0, 6)}…${addr.slice(-4)}`} <Copy text={addr} />
                {bal != null
                    ? ` · rh ${bal.rh != null ? fmtEth(bal.rh) : "…"} ETH · eth ${bal.eth != null ? fmtEth(bal.eth) : "…"} ETH`
                    : ""}
            </p>
            <p className="t">
                deposit — from any chain or token, to this one address; pick where it lands:
            </p>
            <p>
                <button onClick={() => window.open(DEPOSIT_ETH(addr), "_blank", "noopener")}>
                    Deposit on Ethereum
                </button>{" "}
                <span className="t">(your name lives here)</span>{" "}
                <button onClick={() => window.open(DEPOSIT_RH(addr), "_blank", "noopener")}>
                    Deposit on Robinhood
                </button>{" "}
                <span className="t">(notices settle here)</span>
            </p>
            <p>
                <input value={to} onChange={(e) => setTo(e.target.value)} placeholder="withdraw to: 0x…" />{" "}
                <input value={amt} onChange={(e) => setAmt(e.target.value)} placeholder="ETH" style={{width: "6rem"}} />{" "}
                <select value={fromChain} onChange={(e) => setFromChain(e.target.value)}>
                    <option value="rh">from robinhood</option>
                    <option value="eth">from ethereum</option>
                </select>{" "}
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

/**
 * Tip a notice's author — money to the writer, not to the board. ETH on
 * Robinhood rides the contract's tip(tokenId) (100% forwarded + tallied on the
 * board); every other option is a plain transfer straight to the author's
 * address on that token's own chain. No name needed to tip.
 */
function TipBox({wallet, address, gid}) {
    const {sendTransaction} = useSendTransaction();
    const [n, setN] = useState(null); // the notice (author_address, contract, token_id, title)
    const [opt, setOpt] = useState("eth-rh");
    const [amt, setAmt] = useState("");
    const [msg, setMsg] = useState("");
    const [busy, setBusy] = useState(false);

    useEffect(() => {
        (async () => {
            try {
                const r = await fetch(`/api/v1/notice/${gid}`);
                setN(await r.json());
            } catch {
                setMsg("Couldn't load the notice.");
            }
        })();
    }, [gid]);

    if (!n) return <p className="t">Loading the notice…</p>;
    if (n.error) return <p className="warn">{n.error}</p>;
    // The contract-tip path only exists on the CURRENT posts contract; archived
    // notices still take every direct-transfer option.
    const onCurrent = String(n.contract).toLowerCase() === POSTS_CONTRACT.toLowerCase();
    const options = TIP_OPTIONS.filter((x) => x.kind !== "contract-tip" || onCurrent);
    const o = options.find((x) => x.id === opt) ?? options[0];

    async function tip() {
        try {
            if (!amt || Number(amt) <= 0) return alert("Enter an amount.");
            const value = parseUnits(amt, o.decimals);
            setBusy(true);
            if (wallet && chainOf(wallet) !== o.chainId) {
                setMsg("Approve the network switch in your wallet…");
                await wallet.switchChain(o.chainId);
            }
            setMsg("Confirm in your wallet…");
            let tx;
            if (o.kind === "contract-tip") {
                tx = {to: n.contract, data: dataContractTip(BigInt(n.token_id)), value, chainId: o.chainId};
            } else if (o.kind === "native") {
                tx = {to: n.author_address, value, chainId: o.chainId};
            } else {
                tx = {to: o.token, data: dataErc20Transfer(n.author_address, value), chainId: o.chainId};
            }
            const {hash} = await sendTransaction(tx, {address});
            setMsg(`Sent — thank you. ${hash.slice(0, 10)}…`);
            setAmt("");
        } catch (e) {
            const m = e?.shortMessage || e?.message || "Failed.";
            setMsg(/insufficient|exceeds/i.test(m) ? `Not enough on that chain for this tip.` : m);
        } finally {
            setBusy(false);
        }
    }

    return (
        <>
            <p className="t">
                tipping <b>~{n.author || "?"}</b> for “{n.title || `notice #${gid}`}” — every cent goes to the
                author; the board takes nothing.
            </p>
            <p>
                <select value={opt} onChange={(e) => setOpt(e.target.value)}>
                    {options.map((x) => (
                        <option key={x.id} value={x.id}>
                            {x.label}
                        </option>
                    ))}
                </select>{" "}
                <input value={amt} onChange={(e) => setAmt(e.target.value)} placeholder="amount" style={{width: "8rem"}} />{" "}
                <button disabled={busy} onClick={tip}>
                    Tip
                </button>
            </p>
            <p className="t">
                {o.kind === "contract-tip"
                    ? "goes through the contract and shows in the author's tip tally."
                    : `a direct ${o.label} transfer to the author's wallet.`}{" "}
                <a href={`/notices/${gid}`}>back to the notice</a>
            </p>
            <p id="status">{msg}</p>
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
        (async () => setPrice(exempt ? 0n : await readName("doorChosenWei")))();
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

function Compose({name, exempt, isReply, reply, busy, send, body, setBody}) {
    const [price, setPrice] = useState(null);
    useEffect(() => {
        (async () => setPrice(exempt ? 0n : await readPosts(isReply ? "remarkWei" : "noticeWei")))();
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
                {isReply ? `replying to notice #${reply}` : `writing as ${name}`} · {cost} · publishes on
                robinhood chain (an ethereum option is coming)
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
