// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {PlaintextPosts} from "../src/PlaintextPosts.sol";

/// @notice Deploys the posts-only contract to Robinhood Chain 4663. No door, no
///         name-gate — identity is the PlaintextName NFT on Ethereum mainnet and
///         the board joins author address -> name off-chain.
///
///   forge script script/DeployPosts.s.sol --rpc-url rh_mainnet --broadcast
///
/// Requires PRIVATE_KEY in the environment. Never commit it.
contract DeployPosts is Script {
    uint256 constant RH_MAINNET = 4663;

    /// Chainlink ETH/USD on 4663 (8 decimals, 86400s heartbeat — hence the 25h guard).
    address constant FEED = 0x78F3556b67E17Df817D51Ef5a990cDaF09E8d3A9;

    /// gokhan.eth — same treasury as the names contract on Ethereum.
    address payable constant TREASURY = payable(0x36de990133D36d7E3DF9a820aA3eDE5a2320De71);

    function _exemptList() internal pure returns (address[] memory a) {
        a = new address[](2);
        a[0] = 0x36de990133D36d7E3DF9a820aA3eDE5a2320De71; // gokhan.eth
        a[1] = 0xa97011e4Af4c3138F720D7f0438B9379fB1bB9DD; // deployer hot wallet
    }

    function run() external returns (PlaintextPosts posts) {
        require(block.chainid == RH_MAINNET, "deploy only to Robinhood Chain 4663");
        uint256 pk = vm.envUint("PRIVATE_KEY");

        vm.startBroadcast(pk);
        posts = new PlaintextPosts(TREASURY, FEED, _exemptList());
        vm.stopBroadcast();

        console.log("PlaintextPosts", address(posts));
        console.log("notice wei    ", posts.noticeWei());
        console.log("remark wei    ", posts.remarkWei());
    }
}
