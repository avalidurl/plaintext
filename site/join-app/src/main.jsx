// Install the Buffer global BEFORE anything else runs. The node-polyfills plugin
// provides it, but only lazily inside chunks — which races the wallet code that
// references a bare `Buffer` at signing time ("Buffer is not defined"). Doing it
// here, at the entry's first line, removes the race entirely.
import {Buffer} from "buffer";
if (typeof globalThis.Buffer === "undefined") globalThis.Buffer = Buffer;

import React from "react";
import {createRoot} from "react-dom/client";
import {PrivyProvider} from "@privy-io/react-auth";
import {rhChain} from "./chain.js";
import App from "./App.jsx";
import "./style.css";

// The Worker injects the real App ID into window.__PRIVY_APP_ID before this runs,
// so the same built bundle works without a rebuild if the ID ever changes.
const APP_ID = window.__PRIVY_APP_ID;

function Root() {
    if (!APP_ID || APP_ID === "__PRIVY_APP_ID__") {
        return <p className="warn">Login isn't configured yet.</p>;
    }
    return (
        <PrivyProvider
            appId={APP_ID}
            config={{
                loginMethods: ["twitter", "email", "wallet"],
                appearance: {theme: "light", accentColor: "#2D5FB6", walletChainType: "ethereum-only"},
                // Only mint an embedded wallet for users who arrive WITHOUT one
                // (X / email login). Someone connecting their own wallet keeps
                // using it — no confusing second address, and their on-chain name
                // + exemption stay attached to the wallet they actually control.
                embeddedWallets: {ethereum: {createOnLogin: "users-without-wallets"}},
                defaultChain: rhChain,
                supportedChains: [rhChain],
            }}
        >
            <div className="wrap">
                <p className="t">
                    <a href="/">the board</a>
                </p>
                <h1>join</h1>
                <App />
                <div className="b" />
                <p className="t">
                    Reading is free. Writing costs what the manual says, settled in ETH on chain 4663. Nobody can
                    change those prices. <a href="/manual">manual</a>
                </p>
            </div>
        </PrivyProvider>
    );
}

createRoot(document.getElementById("root")).render(<Root />);
