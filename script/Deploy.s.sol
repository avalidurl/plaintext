// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {Plaintext} from "../src/Plaintext.sol";
import {StubFeed} from "../src/testnet/StubFeed.sol";

/// @notice Deploys plaintext. Picks the price feed by chain — the real Chainlink
///         aggregator on 4663, a StubFeed on testnet (Chainlink has no 46630 feed).
///
///   testnet: forge script script/Deploy.s.sol --rpc-url rh_testnet --broadcast
///   mainnet: forge script script/Deploy.s.sol --rpc-url rh_mainnet --broadcast
///
/// Requires PRIVATE_KEY in the environment. Never commit it.
contract Deploy is Script {
    uint256 constant RH_MAINNET = 4663;
    uint256 constant RH_TESTNET = 46630;

    /// Chainlink ETH/USD on 4663. Verified live 2026-07-20 (description "ETH / USD",
    /// 8 decimals, 86400s heartbeat).
    address constant FEED_MAINNET = 0x78F3556b67E17Df817D51Ef5a990cDaF09E8d3A9;

    /// gokhan.eth — verified plain EOA (no code on mainnet or 4663), nonce 86 on 4663.
    address payable constant TREASURY = payable(0x36de990133D36d7E3DF9a820aA3eDE5a2320De71);

    /// Addresses that write for free, baked in immutably at deploy. The founder
    /// (gokhan.eth) plus the deployer hot wallet, so the founder can post from
    /// either without paying. Add more here before deploy if needed — they cannot
    /// be added afterwards.
    function _exemptList() internal pure returns (address[] memory a) {
        a = new address[](2);
        a[0] = 0x36de990133D36d7E3DF9a820aA3eDE5a2320De71; // gokhan.eth
        a[1] = 0xa97011e4Af4c3138F720D7f0438B9379fB1bB9DD; // rh-flip-bot hot wallet
    }

    function run() external returns (Plaintext pt, address feed) {
        uint256 pk = vm.envUint("PRIVATE_KEY");

        vm.startBroadcast(pk);

        if (block.chainid == RH_MAINNET) {
            feed = FEED_MAINNET;
            console.log("chain 4663 (mainnet) - using real Chainlink feed");
        } else if (block.chainid == RH_TESTNET) {
            // $1,865.30, roughly the live mainnet reading at authoring time.
            feed = address(new StubFeed(186_530_000_000));
            console.log("chain 46630 (testnet) - deployed StubFeed at", feed);
        } else {
            revert("unsupported chain: deploy only to 4663 or 46630");
        }

        pt = new Plaintext(TREASURY, feed, _exemptList());
        vm.stopBroadcast();

        console.log("plaintext   ", address(pt));
        console.log("treasury    ", TREASURY);
        console.log("feed        ", feed);
        console.log("notice  wei ", pt.noticeWei());
        console.log("remark  wei ", pt.remarkWei());
    }

    /// @dev Guards against the one mistake that would matter: shipping the stub to mainnet.
    function assertMainnetSafe(Plaintext pt) external view {
        require(block.chainid == RH_MAINNET, "not mainnet");
        require(address(pt.feed()) == FEED_MAINNET, "NOT THE REAL FEED");
        require(pt.treasury() == TREASURY, "wrong treasury");
    }
}
