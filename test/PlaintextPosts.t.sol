// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {PlaintextPosts} from "../src/PlaintextPosts.sol";
import {MockFeed, RejectsEth} from "./MockFeed.sol";

contract PlaintextPostsTest is Test {
    PlaintextPosts pt;
    MockFeed feed;

    address treasury = address(0xBEEF);
    address alice = address(0xA11CE);
    address bob = address(0xB0B);
    address founder = address(0xF0);

    int256 constant ETH_USD = 183_552_000_000; // $1,835.52 at 8 decimals

    event Posted(address indexed hand, uint256 indexed id, uint256 indexed parent, string cid);

    function setUp() public {
        vm.warp(1_784_479_639);
        feed = new MockFeed(ETH_USD);
        address[] memory ex = new address[](1);
        ex[0] = founder;
        pt = new PlaintextPosts(payable(treasury), address(feed), ex);
        vm.deal(alice, 10 ether);
        vm.deal(bob, 10 ether);
        vm.deal(founder, 10 ether);
    }

    function test_pricing_matchesPeg() public view {
        assertEq(pt.noticeWei(), (300 * 1e24) / uint256(ETH_USD));
        assertEq(pt.remarkWei(), (50 * 1e24) / uint256(ETH_USD));
    }

    // ─── writing needs no name — that's the whole point ──────────────────────

    function test_post_withoutAnyDoor_mintsAndPays() public {
        uint256 price = pt.noticeWei();
        vm.prank(alice);
        vm.expectEmit(true, true, true, true);
        emit Posted(alice, 1, 0, "bafytest");
        uint256 id = pt.post{value: price}("bafytest");

        assertEq(id, 1);
        assertEq(pt.ownerOf(1), alice);
        assertEq(pt.parentOf(1), 0);
        assertEq(pt.tokenURI(1), "ipfs://bafytest");
        assertEq(treasury.balance, price);
    }

    function test_reply_recordsParent_andCostsLess() public {
        uint256 notice = pt.noticeWei();
        uint256 remark = pt.remarkWei();
        assertLt(remark, notice);

        vm.prank(alice);
        pt.post{value: notice}("bafyroot");
        vm.prank(bob);
        uint256 id = pt.reply{value: remark}(1, "bafyreply");

        assertEq(id, 2);
        assertEq(pt.parentOf(2), 1);
        assertEq(pt.ownerOf(2), bob);
        assertEq(treasury.balance, notice + remark);
    }

    function test_replyToNothing_reverts() public {
        vm.prank(alice);
        vm.expectRevert(PlaintextPosts.NoSuchNotice.selector);
        pt.reply{value: 1 ether}(99, "bafy");
    }

    function test_emptyCid_reverts() public {
        vm.prank(alice);
        vm.expectRevert(PlaintextPosts.BadCid.selector);
        pt.post{value: 1 ether}("");
    }

    function test_underpaid_reverts() public {
        uint256 price = pt.noticeWei();
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(PlaintextPosts.Underpaid.selector, price));
        pt.post{value: price - 1}("bafy");
    }

    function test_overpaid_refundsExactly() public {
        uint256 price = pt.noticeWei();
        uint256 before = alice.balance;
        vm.prank(alice);
        pt.post{value: price + 0.5 ether}("bafy");
        assertEq(alice.balance, before - price);
        assertEq(treasury.balance, price);
    }

    function test_exempt_postsFree() public {
        vm.prank(founder);
        pt.post{value: 0}("bafyfree");
        assertEq(pt.ownerOf(1), founder);
        assertEq(treasury.balance, 0);
    }

    function test_exempt_repliesFree() public {
        vm.prank(founder);
        pt.post{value: 0}("bafyroot");
        vm.prank(founder);
        pt.reply{value: 0}(1, "bafyreply");
        assertEq(pt.totalPosted(), 2);
        assertEq(treasury.balance, 0);
    }

    // ─── tipping ─────────────────────────────────────────────────────────────

    function test_tip_goesEntirelyToAuthor() public {
        uint256 price = pt.noticeWei(); // read BEFORE prank — an inline call would consume it
        vm.prank(alice);
        pt.post{value: price}("bafy");
        uint256 before = alice.balance;
        vm.prank(bob);
        pt.tip{value: 1 ether}(1);
        assertEq(alice.balance, before + 1 ether);
    }

    function test_zeroTip_reverts() public {
        uint256 price = pt.noticeWei();
        vm.prank(alice);
        pt.post{value: price}("bafy");
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(PlaintextPosts.Underpaid.selector, 1));
        pt.tip(1);
    }

    // ─── feed guards (25h heartbeat on 4663) ─────────────────────────────────

    function test_staleFeed_pastTwentyFiveHours_reverts() public {
        vm.warp(block.timestamp + 25 hours + 1);
        vm.expectRevert(PlaintextPosts.StaleFeed.selector);
        pt.noticeWei();
    }

    function test_sixHourStale_isAccepted() public {
        vm.warp(block.timestamp + 6 hours);
        assertGt(pt.noticeWei(), 0);
    }

    function test_treasuryThatRejectsEth_revertsTheWholeCall() public {
        RejectsEth bad = new RejectsEth();
        address[] memory ex = new address[](0);
        PlaintextPosts p2 = new PlaintextPosts(payable(address(bad)), address(feed), ex);
        uint256 price = p2.noticeWei();
        vm.prank(alice);
        vm.expectRevert(PlaintextPosts.TransferFailed.selector);
        p2.post{value: price}("bafy");
    }
}
