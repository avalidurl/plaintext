import {defineChain, createPublicClient, http, encodeFunctionData} from "viem";
import {mainnet, base} from "viem/chains";

// ── the two chains ──────────────────────────────────────────────────────────
// Names are ETHEREUM-ONLY: the username NFT lives on mainnet. Posts settle on
// Robinhood Chain (cheap) — an Ethereum option for posts arrives with the new
// posts contract. Chain 4663 isn't in viem/chains, so define it; values match
// the live chain (chainId 0x1237, ETH gas, Blockscout explorer).
export const baseChain = base;

// ── tipping ─────────────────────────────────────────────────────────────────
// A tip is money to the AUTHOR, not to the board. ETH on Robinhood goes through
// the posts contract's tip(tokenId) (100% forwarded, and the board tallies it);
// every other option is a plain transfer straight to the author's address on the
// token's own chain. All addresses + decimals verified on-chain 2026-08-02.
export const TIP_OPTIONS = [
    {id: "eth-rh", label: "ETH · robinhood", kind: "contract-tip", chainId: 4663, decimals: 18},
    {id: "eth-eth", label: "ETH · ethereum", kind: "native", chainId: 1, decimals: 18},
    {id: "text", label: "$TEXT · ethereum", kind: "erc20", chainId: 1, token: "0xCa21e280D610eEae6f74eC9D71F08B8c5fEdFB07", decimals: 18},
    {id: "usdc", label: "USDC · ethereum", kind: "erc20", chainId: 1, token: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", decimals: 6},
    {id: "usdt", label: "USDT · ethereum", kind: "erc20", chainId: 1, token: "0xdAC17F958D2ee523a2206206994597C13D831ec7", decimals: 6},
    {id: "numetal", label: "NUMETAL · base", kind: "erc20", chainId: 8453, token: "0x57EDb7FC54ADa9Ef4E113DC05A168449e63cFbA3", decimals: 18},
];

const ERC20_ABI = [
    {type: "function", name: "transfer", stateMutability: "nonpayable", inputs: [{type: "address"}, {type: "uint256"}], outputs: [{type: "bool"}]},
];
const TIP_ABI = [
    {type: "function", name: "tip", stateMutability: "payable", inputs: [{type: "uint256"}], outputs: []},
];
export const dataErc20Transfer = (to, amount) => encodeFunctionData({abi: ERC20_ABI, functionName: "transfer", args: [to, amount]});
export const dataContractTip = (tokenId) => encodeFunctionData({abi: TIP_ABI, functionName: "tip", args: [tokenId]});

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
// Posts (notices/remarks): the posts-only contract on Robinhood Chain — no door,
// no name-gate; having an Ethereum name is what the UI asks for before composing.
export const POSTS_CONTRACT = "0xc9DA0423D4d2245d71c550B8314224119aEcbf99";

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
