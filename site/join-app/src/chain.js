import {defineChain, createPublicClient, http, encodeFunctionData} from "viem";

// Chain 4663 isn't in viem/chains, so define it. Matches the values verified on
// the live chain (chainId 0x1237, ETH gas, Blockscout explorer).
export const rhChain = defineChain({
    id: 4663,
    name: "Robinhood Chain",
    network: "robinhood",
    nativeCurrency: {decimals: 18, name: "Ether", symbol: "ETH"},
    rpcUrls: {default: {http: ["https://rpc.mainnet.chain.robinhood.com"]}},
    blockExplorers: {default: {name: "Blockscout", url: "https://robinhoodchain.blockscout.com"}},
});

export const CONTRACT = "0xC4bfCb7c103Ad4571D98b5F5bC9bc7b860023f5c";

// Only the functions the join flow touches.
const ABI = [
    {type: "function", name: "nameOf", stateMutability: "view", inputs: [{type: "address"}], outputs: [{type: "string"}]},
    {type: "function", name: "exempt", stateMutability: "view", inputs: [{type: "address"}], outputs: [{type: "bool"}]},
    {type: "function", name: "doorAssignedWei", stateMutability: "view", inputs: [], outputs: [{type: "uint256"}]},
    {type: "function", name: "doorChosenWei", stateMutability: "view", inputs: [], outputs: [{type: "uint256"}]},
    {type: "function", name: "noticeWei", stateMutability: "view", inputs: [], outputs: [{type: "uint256"}]},
    {type: "function", name: "remarkWei", stateMutability: "view", inputs: [], outputs: [{type: "uint256"}]},
    {type: "function", name: "enter", stateMutability: "payable", inputs: [], outputs: []},
    {type: "function", name: "enterAs", stateMutability: "payable", inputs: [{type: "string"}], outputs: []},
    {type: "function", name: "post", stateMutability: "payable", inputs: [{type: "string"}], outputs: []},
    {type: "function", name: "reply", stateMutability: "payable", inputs: [{type: "uint256"}, {type: "string"}], outputs: []},
    {type: "function", name: "rename", stateMutability: "payable", inputs: [{type: "string"}], outputs: []},
];

export const pub = createPublicClient({chain: rhChain, transport: http()});

export const read = (name, args = []) =>
    pub.readContract({address: CONTRACT, abi: ABI, functionName: name, args});

// Build calldata with viem — no hand-rolled ABI encoding on the money path.
export const data = (name, args = []) => encodeFunctionData({abi: ABI, functionName: name, args});

export const balanceOf = (address) => pub.getBalance({address});
