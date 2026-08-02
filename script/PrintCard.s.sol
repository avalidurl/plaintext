// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {PlaintextName} from "../src/PlaintextName.sol";
import {MockFeed} from "../test/MockFeed.sol";

/// @dev Local-only: mints @gokhan against a mock feed and prints the real tokenURI so
///      we can decode the embedded SVG off-chain and confirm the card renders.
///      Run: forge script script/PrintCard.s.sol
contract PrintCard is Script {
    function run() external {
        MockFeed feed = new MockFeed(183_552_000_000);
        address caller = address(0xF0);
        address[] memory ex = new address[](1);
        ex[0] = caller; // exempt, so enterAs is free
        PlaintextName nm = new PlaintextName(payable(address(0xBEEF)), address(feed), ex);
        vm.prank(caller);
        nm.enterAs("gokhan");
        console.log(nm.tokenURI(1));
    }
}
