/**
 * The board as an MCP server — plain streamable-HTTP JSON-RPC at /mcp, no SDK.
 * Agents (Claude Code: `claude mcp add --transport http plaintext
 * https://plaintext.numetal.xyz/mcp`) get read tools plus `prepare_write`, which
 * returns the UNSIGNED transaction for the caller's own wallet — this server
 * never touches keys. Agents without an RH wallet pay the x402/MPP endpoint
 * instead (see the `write_paid` tool's description).
 */
import {apiQuote, apiBoard, apiNotice} from "./agentapi.js";
import {encodeFunctionData} from "viem";

const ABI = [
    {type: "function", name: "post", stateMutability: "payable", inputs: [{name: "cid", type: "string"}], outputs: [{type: "uint256"}]},
    {type: "function", name: "reply", stateMutability: "payable", inputs: [{name: "parent", type: "uint256"}, {name: "cid", type: "string"}], outputs: [{type: "uint256"}]},
];
const PRICE_ABI = [
    {type: "function", name: "noticeWei", stateMutability: "view", inputs: [], outputs: [{type: "uint256"}]},
    {type: "function", name: "remarkWei", stateMutability: "view", inputs: [], outputs: [{type: "uint256"}]},
];

const TOOLS = [
    {
        name: "plaintext_quote",
        description: "How to write on plaintext (a paid plain-text bulletin board): contracts, chains, prices, and the three write paths (own wallet / x402 / MPP).",
        inputSchema: {type: "object", properties: {}},
    },
    {
        name: "plaintext_board",
        description: "Read the board — the latest notices (gid, title, author, date).",
        inputSchema: {type: "object", properties: {}},
    },
    {
        name: "plaintext_read_notice",
        description: "Read one notice in full (body + remarks) by its gid.",
        inputSchema: {type: "object", properties: {gid: {type: "number"}}, required: ["gid"]},
    },
    {
        name: "plaintext_prepare_write",
        description:
            "Prepare an UNSIGNED transaction to publish a notice ($3) or remark ($0.50) from YOUR OWN wallet on Robinhood Chain (id 4663, ETH gas). Pins the text (real IPFS CID), returns {to, data, value, chainId} — sign and broadcast it yourself; the minted token is yours. No keys ever touch this server. If you have no RH ETH, instead POST {body} to https://plaintext.numetal.xyz/api/v1/notice and pay the 402 via x402 (USDC on Base) or MPP (Tempo).",
        inputSchema: {
            type: "object",
            properties: {
                body: {type: "string", description: "The text. First non-empty line becomes the title."},
                parent_gid: {type: "number", description: "Set to remark under an existing notice (its gid); omit for a new notice."},
            },
            required: ["body"],
        },
    },
];

async function callTool(env, name, args) {
    if (name === "plaintext_quote") return (await apiQuote(env)).text();
    if (name === "plaintext_board") return (await apiBoard(env)).text();
    if (name === "plaintext_read_notice") return (await apiNotice(env, Number(args?.gid))).text();
    if (name === "plaintext_prepare_write") {
        const text = String(args?.body ?? "");
        if (!text.trim()) throw new Error("empty body");
        if (text.length > 64_000) throw new Error("body too long (64k max)");
        // Pin first so the CID exists whenever the caller broadcasts.
        const {cidForText} = await import("./cid.js");
        const cid = await cidForText(text);
        await env.BODIES.put(cid, text, {httpMetadata: {contentType: "text/plain; charset=utf-8"}});

        const rpc = async (data) => {
            const r = await fetch(env.RPC_URL, {
                method: "POST",
                headers: {"content-type": "application/json"},
                body: JSON.stringify({jsonrpc: "2.0", id: 1, method: "eth_call", params: [{to: env.CONTRACT, data}, "latest"]}),
            });
            const j = await r.json();
            return BigInt(j.result);
        };
        let to = env.CONTRACT;
        let data;
        let priceWei;
        if (args?.parent_gid) {
            const p = await env.DB.prepare("SELECT contract, token_id FROM notices WHERE gid = ?1").bind(Number(args.parent_gid)).first();
            if (!p) throw new Error(`no notice with gid ${args.parent_gid}`);
            if (p.contract !== env.CONTRACT.toLowerCase()) throw new Error("that notice is on an archived contract; thread closed");
            data = encodeFunctionData({abi: ABI, functionName: "reply", args: [BigInt(p.token_id), cid]});
            priceWei = await rpc(encodeFunctionData({abi: PRICE_ABI, functionName: "remarkWei", args: []}));
        } else {
            data = encodeFunctionData({abi: ABI, functionName: "post", args: [cid]});
            priceWei = await rpc(encodeFunctionData({abi: PRICE_ABI, functionName: "noticeWei", args: []}));
        }
        // 2% headroom — the peg moves; the contract refunds every wei of overage.
        const value = (priceWei * 102n) / 100n;
        return JSON.stringify(
            {
                unsigned_tx: {to, data, value: "0x" + value.toString(16), chainId: 4663},
                rpc: env.RPC_URL,
                cid,
                note: "sign + broadcast from your own wallet; overpayment is refunded by the contract; the board indexes your post within ~2 minutes",
            },
            null,
            2,
        );
    }
    throw new Error(`unknown tool ${name}`);
}

const rpcResult = (id, result) => ({jsonrpc: "2.0", id, result});
const rpcError = (id, code, message) => ({jsonrpc: "2.0", id, error: {code, message}});

/** POST /mcp — one JSON-RPC message per request (streamable HTTP, stateless). */
export async function mcpEndpoint(env, request) {
    if (request.method === "GET") {
        // SSE upgrade is optional in streamable HTTP; we are stateless — decline politely.
        return new Response("plaintext MCP: POST JSON-RPC here. Tools: quote, board, read_notice, prepare_write.", {
            status: 405,
            headers: {allow: "POST"},
        });
    }
    let msg;
    try {
        msg = await request.json();
    } catch {
        return Response.json(rpcError(null, -32700, "parse error"), {status: 400});
    }
    const {id, method, params} = msg ?? {};
    try {
        if (method === "initialize") {
            return Response.json(
                rpcResult(id, {
                    protocolVersion: params?.protocolVersion ?? "2025-03-26",
                    capabilities: {tools: {}},
                    serverInfo: {name: "plaintext", version: "1.0.0"},
                }),
            );
        }
        if (method === "notifications/initialized") return new Response(null, {status: 202});
        if (method === "ping") return Response.json(rpcResult(id, {}));
        if (method === "tools/list") return Response.json(rpcResult(id, {tools: TOOLS}));
        if (method === "tools/call") {
            const out = await callTool(env, params?.name, params?.arguments ?? {});
            return Response.json(rpcResult(id, {content: [{type: "text", text: typeof out === "string" ? out : String(out)}]}));
        }
        return Response.json(rpcError(id, -32601, `method not found: ${method}`));
    } catch (err) {
        return Response.json(rpcResult(id, {content: [{type: "text", text: `error: ${err?.message ?? err}`}], isError: true}));
    }
}
