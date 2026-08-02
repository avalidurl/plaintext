// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {PlaintextName} from "../src/PlaintextName.sol";
import {MockFeed, RejectsEth} from "./MockFeed.sol";
import {IERC721Errors} from "@openzeppelin/contracts/interfaces/draft-IERC6093.sol";

contract PlaintextNameTest is Test {
    PlaintextName nm;
    MockFeed feed;

    address treasury = address(0xBEEF);
    address alice = address(0xA11CE);
    address bob = address(0xB0B);
    address founder = address(0xF0);

    int256 constant ETH_USD = 183_552_000_000; // $1,835.52 at 8 decimals (live mainnet reading)

    event Entered(address indexed hand, string name, bool chosen);
    event Renamed(address indexed hand, string oldName, string newName);

    function setUp() public {
        vm.warp(1_784_479_639);
        feed = new MockFeed(ETH_USD);
        address[] memory ex = new address[](1);
        ex[0] = founder;
        nm = new PlaintextName(payable(treasury), address(feed), ex);
        vm.deal(alice, 10 ether);
        vm.deal(bob, 10 ether);
        vm.deal(founder, 10 ether);
    }

    // ─── pricing ─────────────────────────────────────────────────────────────

    function test_pricing_matchesPeg() public view {
        assertEq(nm.doorAssignedWei(), (100 * 1e24) / uint256(ETH_USD));
        assertEq(nm.doorChosenWei(), (500 * 1e24) / uint256(ETH_USD));
    }

    // ─── enter ───────────────────────────────────────────────────────────────

    function test_enterAs_mintsChosenName() public {
        uint256 p = nm.doorChosenWei();
        vm.expectEmit(true, false, false, true);
        emit Entered(alice, "alice", true);
        vm.prank(alice);
        nm.enterAs{value: p}("alice");

        assertEq(nm.nameOf(alice), "alice");
        assertEq(nm.holderOfName(keccak256("alice")), alice);
        assertEq(nm.ownerOf(1), alice);
        assertEq(nm.tokenOf(alice), 1);
        assertEq(nm.nameOfToken(1), "alice");
        assertTrue(nm.hasName(alice));
        assertEq(nm.totalNames(), 1);
        assertEq(treasury.balance, p);
    }

    function test_enter_dealsAndMints() public {
        uint256 p = nm.doorAssignedWei();
        vm.prank(alice);
        nm.enter{value: p}();

        string memory dealt = nm.nameOf(alice);
        assertEq(bytes(dealt).length, 8);
        assertEq(nm.ownerOf(1), alice);
        assertTrue(nm.hasName(alice));
    }

    function test_oneNamePerAddress() public {
        uint256 p = nm.doorChosenWei();
        vm.startPrank(alice);
        nm.enterAs{value: p}("alice");
        vm.expectRevert(PlaintextName.AlreadyEntered.selector);
        nm.enterAs{value: p}("alicia");
        vm.stopPrank();
    }

    function test_nameTaken() public {
        uint256 p = nm.doorChosenWei();
        vm.prank(alice);
        nm.enterAs{value: p}("shared");
        vm.prank(bob);
        vm.expectRevert(PlaintextName.NameTaken.selector);
        nm.enterAs{value: p}("shared");
    }

    function test_badNames_revert() public {
        uint256 p = nm.doorChosenWei();
        vm.startPrank(alice);
        vm.expectRevert(PlaintextName.BadName.selector);
        nm.enterAs{value: p}("Alice"); // uppercase
        vm.expectRevert(PlaintextName.BadName.selector);
        nm.enterAs{value: p}("1abc"); // starts with digit
        vm.expectRevert(PlaintextName.BadName.selector);
        nm.enterAs{value: p}(""); // empty
        vm.expectRevert(PlaintextName.BadName.selector);
        nm.enterAs{value: p}("this-name-is-way-too-long"); // >16
        vm.stopPrank();
    }

    function test_underpaid_reverts() public {
        uint256 p = nm.doorChosenWei();
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(PlaintextName.Underpaid.selector, p));
        nm.enterAs{value: p - 1}("alice");
    }

    function test_refundsOverage() public {
        uint256 p = nm.doorChosenWei();
        uint256 before = alice.balance;
        vm.prank(alice);
        nm.enterAs{value: p + 1 ether}("alice");
        assertEq(alice.balance, before - p); // only the price left the wallet
        assertEq(treasury.balance, p);
    }

    // ─── rename = burn + mint ─────────────────────────────────────────────────

    function test_rename_burnsOldMintsNew_andFreesName() public {
        uint256 chosen = nm.doorChosenWei();
        vm.prank(alice);
        nm.enterAs{value: chosen}("alice");

        vm.expectEmit(true, false, false, true);
        emit Renamed(alice, "alice", "alicia");
        vm.prank(alice);
        nm.rename{value: chosen}("alicia");

        // old token burned
        vm.expectRevert(abi.encodeWithSelector(IERC721Errors.ERC721NonexistentToken.selector, uint256(1)));
        nm.ownerOf(1);
        // new token minted
        assertEq(nm.ownerOf(2), alice);
        assertEq(nm.nameOf(alice), "alicia");
        assertEq(nm.tokenOf(alice), 2);
        assertEq(nm.nameOfToken(2), "alicia");
        // old name freed and reusable
        assertEq(nm.holderOfName(keccak256("alice")), address(0));
        vm.prank(bob);
        nm.enterAs{value: chosen}("alice");
        assertEq(nm.holderOfName(keccak256("alice")), bob);
    }

    function test_rename_beforeEntering_reverts() public {
        uint256 chosen = nm.doorChosenWei();
        vm.prank(alice);
        vm.expectRevert(PlaintextName.NotEntered.selector);
        nm.rename{value: chosen}("alice");
    }

    function test_rename_toTakenName_reverts() public {
        uint256 chosen = nm.doorChosenWei();
        vm.prank(alice);
        nm.enterAs{value: chosen}("alice");
        vm.prank(bob);
        nm.enterAs{value: chosen}("bob");
        vm.prank(alice);
        vm.expectRevert(PlaintextName.NameTaken.selector);
        nm.rename{value: chosen}("bob");
    }

    // ─── tradable identity (name follows the token) ──────────────────────────────

    function test_transfer_movesNameToNewOwner() public {
        uint256 chosen = nm.doorChosenWei();
        vm.prank(alice);
        nm.enterAs{value: chosen}("alice"); // token 1 = "alice"

        vm.prank(alice);
        nm.transferFrom(alice, bob, 1);

        // identity followed the token, automatically
        assertEq(nm.ownerOf(1), bob);
        assertEq(nm.nameOf(bob), "alice");
        assertEq(nm.nameOf(alice), "");
        assertEq(nm.tokenOf(bob), 1);
        assertEq(nm.tokenOf(alice), 0);
        assertEq(nm.holderOfName(keccak256(bytes("alice"))), bob);
        assertTrue(nm.hasName(bob));
        assertFalse(nm.hasName(alice));
    }

    function test_receivingName_updatesActiveHandle_andSetNameSwitches() public {
        uint256 chosen = nm.doorChosenWei();
        vm.prank(bob);
        nm.enterAs{value: chosen}("bob"); // token 1 = "bob"
        vm.prank(alice);
        nm.enterAs{value: chosen}("alice"); // token 2 = "alice"

        // bob receives "alice" — his active handle auto-updates to what he just got
        vm.prank(alice);
        nm.transferFrom(alice, bob, 2);
        assertEq(nm.nameOf(bob), "alice");
        assertEq(nm.tokenOf(bob), 2);
        assertEq(nm.ownerOf(1), bob); // still owns "bob" too
        assertEq(nm.ownerOf(2), bob);

        // he switches his active handle back to "bob"
        vm.prank(bob);
        nm.setName(1);
        assertEq(nm.nameOf(bob), "bob");
        assertEq(nm.tokenOf(bob), 1);

        // selling the INACTIVE name leaves his active handle untouched
        vm.prank(bob);
        nm.transferFrom(bob, alice, 2);
        assertEq(nm.nameOf(bob), "bob");
        assertEq(nm.nameOf(alice), "alice");
        assertEq(nm.holderOfName(keccak256(bytes("alice"))), alice);
    }

    function test_setName_notOwner_reverts() public {
        uint256 chosen = nm.doorChosenWei();
        vm.prank(alice);
        nm.enterAs{value: chosen}("alice");

        vm.prank(bob);
        vm.expectRevert(PlaintextName.NotEntered.selector);
        nm.setName(1);
    }

    // ─── exempt (founder writes free) ────────────────────────────────────────

    function test_exempt_entersFree() public {
        vm.prank(founder);
        nm.enterAs{value: 0}("founder");
        assertEq(nm.nameOf(founder), "founder");
        assertEq(nm.ownerOf(1), founder);
        assertEq(treasury.balance, 0);
    }

    function test_exempt_renamesFree() public {
        vm.startPrank(founder);
        nm.enterAs{value: 0}("founder");
        nm.rename{value: 0}("gokhan");
        vm.stopPrank();
        assertEq(nm.nameOf(founder), "gokhan");
        assertEq(nm.ownerOf(2), founder);
        assertEq(treasury.balance, 0);
    }

    // ─── staleness (2h heartbeat guard) ──────────────────────────────────────

    function test_staleFeed_reverts_pastTwoHours() public {
        vm.warp(block.timestamp + 2 hours + 1);
        vm.expectRevert(PlaintextName.StaleFeed.selector);
        nm.doorChosenWei();
    }

    function test_freshFeed_underTwoHours_ok() public {
        vm.warp(block.timestamp + 2 hours - 1);
        assertGt(nm.doorChosenWei(), 0);
    }

    // ─── metadata ────────────────────────────────────────────────────────────

    function test_tokenURI_isBase64Json_withSvgCard() public {
        uint256 chosen = nm.doorChosenWei();
        vm.prank(alice);
        nm.enterAs{value: chosen}("alice");
        string memory uri = nm.tokenURI(1);

        // base64 JSON data URI carrying a multi-KB embedded SVG card (content decoded + checked off-chain)
        assertTrue(_startsWith(uri, "data:application/json;base64,"));
        assertGt(bytes(uri).length, 800);
    }

    function _startsWith(string memory s, string memory p) internal pure returns (bool) {
        bytes memory sb = bytes(s);
        bytes memory pb = bytes(p);
        if (sb.length < pb.length) return false;
        for (uint256 i; i < pb.length; ++i) {
            if (sb[i] != pb[i]) return false;
        }
        return true;
    }

    function test_tokenURI_nonexistent_reverts() public {
        vm.expectRevert(PlaintextName.NotEntered.selector);
        nm.tokenURI(999);
    }

    // ─── treasury that rejects ETH ───────────────────────────────────────────

    function test_treasuryRejectingEth_revertsEntry() public {
        RejectsEth bad = new RejectsEth();
        address[] memory ex = new address[](0);
        PlaintextName nm2 = new PlaintextName(payable(address(bad)), address(feed), ex);
        uint256 p = nm2.doorChosenWei();
        vm.prank(alice);
        vm.expectRevert(PlaintextName.TransferFailed.selector);
        nm2.enterAs{value: p}("alice");
    }
}
