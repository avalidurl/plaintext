import {defineChain, createPublicClient, http, encodeFunctionData} from "viem";
import {mainnet} from "viem/chains";

// ── the two chains ──────────────────────────────────────────────────────────
// Names are ETHEREUM-ONLY: the username NFT lives on mainnet. Posts settle on
// Robinhood Chain (cheap) — an Ethereum option for posts arrives with the new
// posts contract. Chain 4663 isn't in viem/chains, so define it; values match
// the live chain (chainId 0x1237, ETH gas, Blockscout explorer).
export const rhChain = defineChain({
    id: 4663,
    name: "Robinhood Chain",
    network: "robinhood",
    nativeCurrency: {decimals: 18, name: "Ether", symbol: "ETH"},
    rpcUrls: {default: {http: ["https://rpc.mainnet.chain.robinhood.com"]}},
    blockExplorers: {default: {name: "Blockscout", url: "https://robinhoodchain.blockscout.com"}},
});
export const ethChain = mainnet;

// ── the two contracts ───────────────────────────────────────────────────────
// Usernames: tradable ERC-721 with the on-chain card, Ethereum mainnet. FINAL.
export const NAME_CONTRACT = "0xe15a6ea3dd93af1d8a1c1c27f487a44578a89e8b";
// Posts (notices/remarks): Robinhood Chain v3. (Names on this contract are
// retired — identity comes from Ethereum now.)
export const POSTS_CONTRACT = "0xC4bfCb7c103Ad4571D98b5F5bC9bc7b860023f5c";

const NAME_ABI = [
    {type: "function", name: "nameOf", stateMutability: "view", inputs: [{type: "address"}], outputs: [{type: "string"}]},
    {type: "function", name: "exempt", stateMutability: "view", inputs: [{type: "address"}], outputs: [{type: "bool"}]},
    {type: "function", name: "doorAssignedWei", stateMutability: "view", inputs: [], outputs: [{type: "uint256"}]},
    {type: "function", name: "doorChosenWei", stateMutability: "view", inputs: [], outputs: [{type: "uint256"}]},
    {type: "function", name: "enter", stateMutability: "payable", inputs: [], outputs: []},
    {type: "function", name: "enterAs", stateMutability: "payable", inputs: [{type: "string"}], outputs: []},
    {type: "function", name: "rename", stateMutability: "payable", inputs: [{type: "string"}], outputs: []},
];

const POSTS_ABI = [
    {type: "function", name: "noticeWei", stateMutability: "view", inputs: [], outputs: [{type: "uint256"}]},
    {type: "function", name: "remarkWei", stateMutability: "view", inputs: [], outputs: [{type: "uint256"}]},
    {type: "function", name: "post", stateMutability: "payable", inputs: [{type: "string"}], outputs: []},
    {type: "function", name: "reply", stateMutability: "payable", inputs: [{type: "uint256"}, {type: "string"}], outputs: []},
];

export const ethPub = createPublicClient({chain: ethChain, transport: http("https://ethereum-rpc.publicnode.com")});
export const rhPub = createPublicClient({chain: rhChain, transport: http()});

// Name reads go to Ethereum; post reads go to Robinhood.
export const readName = (fn, args = []) =>
    ethPub.readContract({address: NAME_CONTRACT, abi: NAME_ABI, functionName: fn, args});
export const readPosts = (fn, args = []) =>
    rhPub.readContract({address: POSTS_CONTRACT, abi: POSTS_ABI, functionName: fn, args});

// Calldata builders (viem — no hand-rolled ABI on the money path). The caller
// routes the tx to the right chain: names → Ethereum (1), posts → RH (4663).
export const dataName = (fn, args = []) => encodeFunctionData({abi: NAME_ABI, functionName: fn, args});
export const dataPosts = (fn, args = []) => encodeFunctionData({abi: POSTS_ABI, functionName: fn, args});

// Which chain a given write belongs to.
export const NAME_FNS = new Set(["enter", "enterAs", "rename"]);
export const chainFor = (fn) => (NAME_FNS.has(fn) ? ethChain.id : rhChain.id);
export const contractFor = (fn) => (NAME_FNS.has(fn) ? NAME_CONTRACT : POSTS_CONTRACT);
export const dataFor = (fn, args = []) => (NAME_FNS.has(fn) ? dataName(fn, args) : dataPosts(fn, args));

// Balances on both chains — the wallet lives on each.
export const balances = async (address) => {
    const [rh, eth] = await Promise.all([
        rhPub.getBalance({address}).catch(() => null),
        ethPub.getBalance({address}).catch(() => null),
    ]);
    return {rh, eth};
};
export const balanceOf = (address) => rhPub.getBalance({address});
