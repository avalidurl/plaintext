// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {PlaintextName} from "../src/PlaintextName.sol";

/// @notice Deploys the plaintext username NFT (PlaintextName) to ETHEREUM MAINNET.
///         A username is a soulbound ERC-721 minted on entry; `rename` burns the
///         old token and mints a new one. Identity lives on mainnet; posts live in
///         the separate Plaintext contract (RH Chain by default, mainnet opt-in).
///
///   mainnet: forge script script/DeployName.s.sol --rpc-url $ETH_RPC --broadcast
///
/// Requires PRIVATE_KEY in the environment. Never commit it.
contract DeployName is Script {
    uint256 constant ETH_MAINNET = 1;

    /// Chainlink ETH/USD on Ethereum mainnet. Verified live: description "ETH / USD",
    /// 8 decimals, 3600s heartbeat (the contract's 2h staleness guard rides that out).
    address constant FEED_MAINNET = 0x5f4eC3Df9cbd43714FE2740f5E3616155c5b8419;

    /// gokhan.eth — receives every priced entry. Same treasury as the RH Chain board.
    address payable constant TREASURY = payable(0x36de990133D36d7E3DF9a820aA3eDE5a2320De71);

    /// Addresses that mint names for free, baked in immutably at deploy: the founder
    /// (gokhan.eth) plus the deployer hot wallet. Cannot be changed afterwards.
    function _exemptList() internal pure returns (address[] memory a) {
        a = new address[](2);
        a[0] = 0x36de990133D36d7E3DF9a820aA3eDE5a2320De71; // gokhan.eth
        a[1] = 0xa97011e4Af4c3138F720D7f0438B9379fB1bB9DD; // rh-flip-bot hot wallet (deployer)
    }

    function run() external returns (PlaintextName names) {
        require(block.chainid == ETH_MAINNET, "deploy only to Ethereum mainnet (chainid 1)");
        uint256 pk = vm.envUint("PRIVATE_KEY");

        vm.startBroadcast(pk);
        names = new PlaintextName(TREASURY, FEED_MAINNET, _exemptList());
        vm.stopBroadcast();

        console.log("PlaintextName ", address(names));
        console.log("treasury      ", TREASURY);
        console.log("feed          ", FEED_MAINNET);
        console.log("assigned wei  ", names.doorAssignedWei());
        console.log("chosen   wei  ", names.doorChosenWei());
    }
}
