// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test, console} from "forge-std/Test.sol";
import {Plaintext} from "../src/Plaintext.sol";

/// @dev Exercises the contract against the REAL Chainlink ETH/USD aggregator on
///      Robinhood Chain mainnet (4663). A mock can be made to say anything; this
///      proves priceWei() works against the actual feed, including its real
///      86400s heartbeat.
///
///      Run: forge test --match-contract ForkTest --fork-url rh_mainnet -vv
///      Skipped automatically when no fork is available (e.g. offline CI).
contract ForkTest is Test {
    address constant FEED = 0x78F3556b67E17Df817D51Ef5a990cDaF09E8d3A9;
    address payable constant TREASURY = payable(0x36de990133D36d7E3DF9a820aA3eDE5a2320De71); // gokhan.eth

    Plaintext pt;

    function setUp() public {
        if (block.chainid != 4663) return;
        pt = new Plaintext(TREASURY, FEED, new address[](0));
    }

    modifier onlyFork() {
        if (block.chainid != 4663) {
            console.log("skipped: not forked onto 4663 (run with --fork-url rh_mainnet)");
            return;
        }
        _;
    }

    function test_fork_realFeedPricesEveryTier() public onlyFork {
        uint256 door = pt.doorAssignedWei();
        uint256 chosen = pt.doorChosenWei();
        uint256 notice = pt.noticeWei();
        uint256 remark = pt.remarkWei();

        console.log("door(assigned) wei", door);
        console.log("door(chosen)   wei", chosen);
        console.log("notice         wei", notice);
        console.log("remark         wei", remark);

        // Sanity: a post must cost more than a reply and less than a chosen name.
        assertGt(notice, remark);
        assertGt(chosen, notice);
        assertGt(door, 0);

        // Ratios are fixed by the cent constants regardless of ETH price.
        assertApproxEqRel(chosen, door * 5, 1e12);
        assertApproxEqRel(notice, door * 3, 1e12);
        assertApproxEqRel(door, remark * 2, 1e12);
    }

    /// The prices must land in a sane band for a real ETH price. If this trips,
    /// either the feed decimals changed or the cent maths is wrong.
    function test_fork_pricesAreInPlausibleBand() public onlyFork {
        uint256 notice = pt.noticeWei();
        // $3 is between 0.0001 ETH (ETH=$30k) and 0.03 ETH (ETH=$100).
        assertGt(notice, 0.0001 ether);
        assertLt(notice, 0.03 ether);
    }

    /// The real feed runs an 86400s heartbeat and is routinely hours stale.
    /// This asserts our 25h guard actually tolerates the live feed's real age —
    /// the exact thing a copy-pasted 1h guard would get wrong.
    function test_fork_liveFeedIsWithinOurStalenessGuard() public onlyFork {
        (, int256 answer,, uint256 updatedAt,) = IFeed(FEED).latestRoundData();
        uint256 age = block.timestamp - updatedAt;
        console.log("live answer (8dp)", uint256(answer));
        console.log("feed age seconds ", age);
        assertLt(age, pt.MAX_STALENESS(), "live feed older than our guard");
        assertGt(answer, 0);
    }
}

interface IFeed {
    function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80);
}
