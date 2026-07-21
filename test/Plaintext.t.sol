// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {Plaintext} from "../src/Plaintext.sol";
import {MockFeed, RejectsEth} from "./MockFeed.sol";

contract PlaintextTest is Test {
    Plaintext pt;
    MockFeed feed;

    address treasury = address(0xBEEF);
    address alice = address(0xA11CE);
    address bob = address(0xB0B);
    address founder = address(0xF0);

    // $1,873.05, the live 4663 reading on 2026-07-19, at 8 decimals.
    int256 constant ETH_USD = 187_304_999_420;

    function setUp() public {
        vm.warp(1_784_479_639); // a realistic 2026 timestamp; block.timestamp starts at 1 otherwise
        feed = new MockFeed(ETH_USD);
        address[] memory ex = new address[](1);
        ex[0] = founder; // one exempt address, to prove free-writes without breaking the paid path
        pt = new Plaintext(payable(treasury), address(feed), ex);
        vm.deal(alice, 10 ether);
        vm.deal(bob, 10 ether);
        vm.deal(founder, 10 ether);
    }

    // ─── pricing ─────────────────────────────────────────────────────────────

    function test_priceWei_matchesHandComputedValues() public view {
        // $3.00 at $1873.04999420/ETH = 0.001601665737321300... ETH
        assertEq(pt.priceWei(300), (300 * 1e24) / uint256(ETH_USD));
        assertEq(pt.noticeWei(), 1_601_665_737_321_300);
        assertEq(pt.doorAssignedWei(), 533_888_579_107_100);
        assertEq(pt.doorChosenWei(), 2_669_442_895_535_500);
        assertEq(pt.remarkWei(), 266_944_289_553_550);
    }

    function test_priceWei_fallsWhenEthRises() public {
        uint256 before = pt.noticeWei();
        feed.setAnswer(ETH_USD * 2);
        assertApproxEqAbs(pt.noticeWei(), before / 2, 1);
    }

    /// The whole point of the peg: $3 stays $3 across a 10x move.
    function testFuzz_priceAlwaysWorthThreeDollars(int256 price) public {
        price = bound(price, ETH_USD / 10, ETH_USD * 10);
        feed.setAnswer(price);
        uint256 wei_ = pt.noticeWei();
        uint256 usdCents = (wei_ * uint256(price)) / 1e24;
        assertApproxEqAbs(usdCents, 300, 1);
    }

    // ─── the 24h heartbeat trap ──────────────────────────────────────────────

    /// The live 4663 feed publishes on an 86400s heartbeat and is routinely
    /// hours stale. A 1h guard would brick the board. 24h must pass.
    function test_sixHourStaleness_isAccepted() public {
        feed.setUpdatedAt(block.timestamp - 6 hours);
        pt.noticeWei(); // must not revert
    }

    function test_twentyFourHourStaleness_isAccepted() public {
        feed.setUpdatedAt(block.timestamp - 24 hours);
        pt.noticeWei();
    }

    function test_pastTwentyFiveHours_reverts() public {
        feed.setUpdatedAt(block.timestamp - 25 hours - 1);
        vm.expectRevert(Plaintext.StaleFeed.selector);
        pt.noticeWei();
    }

    function test_nonPositiveAnswer_reverts() public {
        feed.setAnswer(0);
        vm.expectRevert(Plaintext.BadRound.selector);
        pt.noticeWei();
    }

    function test_incompleteRound_reverts() public {
        feed.setIncompleteRound();
        vm.expectRevert(Plaintext.BadRound.selector);
        pt.noticeWei();
    }

    // ─── the door ────────────────────────────────────────────────────────────

    function test_enterAs_takesChosenNameAndPaysTreasury() public {
        uint256 price = pt.doorChosenWei();
        vm.prank(alice);
        pt.enterAs{value: price}("alice");

        assertEq(pt.nameOf(alice), "alice");
        assertEq(pt.holderOfName(keccak256(bytes("alice"))), alice);
        assertEq(treasury.balance, price);
    }

    function test_enter_dealsAName() public {
        uint256 p = pt.doorAssignedWei();
        vm.prank(alice);
        pt.enter{value: p}();
        assertEq(bytes(pt.nameOf(alice)).length, 8);
    }

    function test_dealtNamesAreDistinct() public {
        uint256 p = pt.doorAssignedWei();
        vm.prank(alice);
        pt.enter{value: p}();
        vm.prank(bob);
        pt.enter{value: p}();
        assertTrue(keccak256(bytes(pt.nameOf(alice))) != keccak256(bytes(pt.nameOf(bob))));
    }

    function test_cannotEnterTwice() public {
        uint256 p = pt.doorAssignedWei();
        vm.startPrank(alice);
        pt.enter{value: p}();
        vm.expectRevert(Plaintext.AlreadyEntered.selector);
        pt.enter{value: p}();
        vm.stopPrank();
    }

    function test_cannotTakeATakenName() public {
        uint256 p = pt.doorChosenWei();
        vm.prank(alice);
        pt.enterAs{value: p}("alice");
        vm.prank(bob);
        vm.expectRevert(Plaintext.NameTaken.selector);
        pt.enterAs{value: p}("alice");
    }

    function test_rejectsBadNames() public {
        uint256 p = pt.doorChosenWei();
        string[6] memory bad = ["", "Alice", "1alice", "al ice", "alice!", "thisnameiswaytoolong"];
        for (uint256 i; i < bad.length; ++i) {
            address who = address(uint160(0x1000 + i));
            vm.deal(who, 1 ether);
            vm.prank(who);
            vm.expectRevert(Plaintext.BadName.selector);
            pt.enterAs{value: p}(bad[i]);
        }
    }

    function test_acceptsHyphensAndDigits() public {
        uint256 p = pt.doorChosenWei();
        vm.prank(alice);
        pt.enterAs{value: p}("a-1");
        assertEq(pt.nameOf(alice), "a-1");
    }

    function test_underpayingTheDoor_reverts() public {
        uint256 price = pt.doorChosenWei();
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Plaintext.Underpaid.selector, price));
        pt.enterAs{value: price - 1}("alice");
    }

    // ─── writing ─────────────────────────────────────────────────────────────

    function _enter(address who) internal {
        uint256 p = pt.doorAssignedWei();
        vm.prank(who);
        pt.enter{value: p}();
    }

    function test_post_mintsAndPays() public {
        _enter(alice);
        uint256 before = treasury.balance;
        uint256 price = pt.noticeWei();

        vm.prank(alice);
        uint256 id = pt.post{value: price}("bafyTEST");

        assertEq(pt.ownerOf(id), alice);
        assertEq(pt.tokenURI(id), "ipfs://bafyTEST");
        assertEq(pt.parentOf(id), 0);
        assertEq(treasury.balance - before, price);
        assertEq(pt.totalPosted(), 1);
    }

    function test_mustEnterBeforePosting() public {
        uint256 p = pt.noticeWei();
        vm.prank(alice);
        vm.expectRevert(Plaintext.NotEntered.selector);
        pt.post{value: p}("bafy");
    }

    function test_reply_costsLessAndRecordsParent() public {
        _enter(alice);
        _enter(bob);
        uint256 np = pt.noticeWei();
        uint256 rp = pt.remarkWei();
        vm.prank(alice);
        uint256 parent = pt.post{value: np}("bafyA");

        vm.prank(bob);
        uint256 child = pt.reply{value: rp}(parent, "bafyB");

        assertEq(pt.parentOf(child), parent);
        assertEq(pt.ownerOf(child), bob);
        assertLt(pt.remarkWei(), pt.noticeWei());
    }

    function test_replyToNothing_reverts() public {
        _enter(alice);
        uint256 p = pt.remarkWei();
        vm.prank(alice);
        vm.expectRevert(Plaintext.NoSuchNotice.selector);
        pt.reply{value: p}(999, "bafy");
    }

    function test_emptyCid_reverts() public {
        _enter(alice);
        uint256 p = pt.noticeWei();
        vm.prank(alice);
        vm.expectRevert(Plaintext.BadName.selector);
        pt.post{value: p}("");
    }

    // ─── overpayment is refunded ─────────────────────────────────────────────

    function test_overpayment_isRefunded() public {
        _enter(alice);
        uint256 price = pt.noticeWei();
        uint256 balBefore = alice.balance;

        vm.prank(alice);
        pt.post{value: price + 0.5 ether}("bafy");

        assertEq(alice.balance, balBefore - price, "only the price should be spent");
        assertEq(address(pt).balance, 0, "contract must never retain ETH");
    }

    function testFuzz_contractNeverRetainsEth(uint96 extra) public {
        _enter(alice);
        vm.deal(alice, uint256(extra) + 10 ether);
        uint256 p = pt.noticeWei();
        vm.prank(alice);
        pt.post{value: p + extra}("bafy");
        assertEq(address(pt).balance, 0);
    }

    // ─── tipping ─────────────────────────────────────────────────────────────

    function test_tip_goesEntirelyToAuthor() public {
        _enter(alice);
        uint256 np = pt.noticeWei();
        vm.prank(alice);
        uint256 id = pt.post{value: np}("bafy");

        uint256 authorBefore = alice.balance;
        uint256 treasuryBefore = treasury.balance;

        vm.prank(bob);
        pt.tip{value: 1 ether}(id);

        assertEq(alice.balance - authorBefore, 1 ether, "author takes all of it");
        assertEq(treasury.balance, treasuryBefore, "house takes no cut");
        assertEq(address(pt).balance, 0);
    }

    function test_tipUnknownNotice_reverts() public {
        vm.prank(bob);
        vm.expectRevert(Plaintext.NoSuchNotice.selector);
        pt.tip{value: 1 ether}(42);
    }

    function test_zeroTip_reverts() public {
        _enter(alice);
        uint256 np = pt.noticeWei();
        vm.prank(alice);
        uint256 id = pt.post{value: np}("bafy");
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(Plaintext.Underpaid.selector, 1));
        pt.tip{value: 0}(id);
    }

    // ─── no admin, no stray ETH ──────────────────────────────────────────────

    function test_contractRejectsBareEth() public {
        vm.prank(alice);
        (bool ok,) = address(pt).call{value: 1 ether}("");
        assertFalse(ok, "no receive/fallback: ETH must come through a priced door");
    }

    function test_treasuryThatRejectsEth_revertsTheWholeCall() public {
        RejectsEth bad = new RejectsEth();
        Plaintext p2 = new Plaintext(payable(address(bad)), address(feed), new address[](0));
        uint256 p = p2.doorAssignedWei();
        vm.prank(alice);
        vm.expectRevert(Plaintext.TransferFailed.selector);
        p2.enter{value: p}();
    }

    function test_pricesAreConstantsNotStorage() public view {
        assertEq(pt.DOOR_ASSIGNED_CENTS(), 100);
        assertEq(pt.DOOR_CHOSEN_CENTS(), 500);
        assertEq(pt.NOTICE_CENTS(), 300);
        assertEq(pt.REMARK_CENTS(), 50);
        assertEq(pt.MAX_STALENESS(), 25 hours);
    }

    // ─── dealt names must not be precomputable ───────────────────────────────

    /// PREVRANDAO returns literally 1 on chain 4663, so a name derived from
    /// (msg.sender, prevrandao) would be a pure function of the address —
    /// grindable offline to get a chosen-quality name for $1 instead of $5.
    /// These two tests hold the line against that regression.

    function test_dealtName_dependsOnBlock() public {
        uint256 p = pt.doorAssignedWei();
        vm.roll(1000);
        vm.prank(alice);
        pt.enter{value: p}();
        string memory first = pt.nameOf(alice);

        // Same address, fresh contract, different block => different name.
        Plaintext p2 = new Plaintext(payable(treasury), address(feed), new address[](0));
        vm.roll(2000);
        uint256 p2price = p2.doorAssignedWei();
        vm.prank(alice);
        p2.enter{value: p2price}();

        assertTrue(
            keccak256(bytes(first)) != keccak256(bytes(p2.nameOf(alice))),
            "dealt name must not be a pure function of msg.sender"
        );
    }

    function test_dealtName_dependsOnArrivalOrder() public {
        vm.roll(1000);
        uint256 p = pt.doorAssignedWei();
        vm.prank(alice);
        pt.enter{value: p}();
        string memory aliceAlone = pt.nameOf(alice);

        // Identical contract and identical block, but bob enters first.
        Plaintext p2 = new Plaintext(payable(treasury), address(feed), new address[](0));
        uint256 q = p2.doorAssignedWei();
        vm.prank(bob);
        p2.enter{value: q}();
        vm.prank(alice);
        p2.enter{value: q}();

        assertTrue(
            keccak256(bytes(aliceAlone)) != keccak256(bytes(p2.nameOf(alice))),
            "arrival order must affect the dealt name"
        );
    }

    // ─── the founder exemption ───────────────────────────────────────────────

    function test_exempt_isPublic() public view {
        assertTrue(pt.exempt(founder));
        assertFalse(pt.exempt(alice));
    }

    function test_exempt_entersFreeWithChosenName() public {
        uint256 before = founder.balance;
        vm.prank(founder);
        pt.enterAs{value: 0}("founder"); // sends NOTHING, still gets in
        assertEq(pt.nameOf(founder), "founder");
        // spent only gas — no fee left the wallet, treasury got nothing
        assertEq(treasury.balance, 0);
        assertLt(before - founder.balance, 0.01 ether); // just gas
    }

    function test_exempt_postsFree_treasuryUnpaid() public {
        vm.prank(founder);
        pt.enter{value: 0}();
        uint256 tBefore = treasury.balance;

        vm.prank(founder);
        uint256 id = pt.post{value: 0}("bafyFREE"); // zero ETH, still mints

        assertEq(pt.ownerOf(id), founder);
        assertEq(pt.tokenURI(id), "ipfs://bafyFREE");
        assertEq(treasury.balance, tBefore, "exempt write must not pay the treasury");
        assertEq(address(pt).balance, 0);
    }

    function test_exempt_overpayIsStillRefunded() public {
        vm.prank(founder);
        pt.enter{value: 0}();
        uint256 before = founder.balance;
        vm.prank(founder);
        pt.post{value: 1 ether}("bafy"); // exempt but overpays anyway
        // price is 0, so the entire 1 ether must come back (minus gas)
        assertGt(founder.balance, before - 0.01 ether, "exempt overpay must be refunded");
        assertEq(address(pt).balance, 0);
    }

    /// The exemption must NOT leak to the public — everyone else still pays.
    function test_nonExempt_stillPaysFull() public {
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Plaintext.Underpaid.selector, pt.doorAssignedWei()));
        pt.enter{value: 0}(); // alice is not exempt: sending 0 must revert
    }

    // ─── rename: upgrade a dealt name to a chosen one ────────────────────────
    // NOTE: read prices into vars BEFORE vm.prank — an inline pt.xWei() call
    // consumes the prank and the tx runs as the test contract.

    function test_rename_freesOldName_setsNew_charges() public {
        _enter(alice);
        string memory dealt = pt.nameOf(alice);
        uint256 price = pt.doorChosenWei();
        uint256 tBefore = treasury.balance;
        vm.prank(alice);
        pt.rename{value: price}("alice");
        assertEq(pt.nameOf(alice), "alice");
        assertEq(pt.holderOfName(keccak256(bytes("alice"))), alice);
        assertEq(pt.holderOfName(keccak256(bytes(dealt))), address(0), "old name must be freed");
        assertEq(treasury.balance - tBefore, price);
    }

    function test_rename_freedNameIsClaimable() public {
        _enter(alice);
        string memory dealt = pt.nameOf(alice);
        uint256 price = pt.doorChosenWei();
        vm.prank(alice);
        pt.rename{value: price}("alice");
        vm.prank(bob);
        pt.enterAs{value: price}(dealt);
        assertEq(pt.nameOf(bob), dealt);
    }

    function test_rename_requiresEntered() public {
        uint256 price = pt.doorChosenWei();
        vm.prank(alice);
        vm.expectRevert(Plaintext.NotEntered.selector);
        pt.rename{value: price}("alice");
    }

    function test_rename_rejectsTakenName() public {
        _enter(alice);
        uint256 price = pt.doorChosenWei();
        vm.prank(bob);
        pt.enterAs{value: price}("taken");
        vm.prank(alice);
        vm.expectRevert(Plaintext.NameTaken.selector);
        pt.rename{value: price}("taken");
    }

    function test_rename_free_forExempt() public {
        vm.prank(founder);
        pt.enter{value: 0}();
        vm.prank(founder);
        pt.rename{value: 0}("founder");
        assertEq(pt.nameOf(founder), "founder");
    }

    function test_rename_doesNotTouchNotices() public {
        _enter(alice);
        uint256 np = pt.noticeWei();
        vm.prank(alice);
        uint256 id = pt.post{value: np}("bafyKEEP");
        uint256 price = pt.doorChosenWei();
        vm.prank(alice);
        pt.rename{value: price}("alice");
        assertEq(pt.ownerOf(id), alice);
        assertEq(pt.tokenURI(id), "ipfs://bafyKEEP");
    }
}
