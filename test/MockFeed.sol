// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @dev Stand-in for the Chainlink ETH/USD aggregator. 8 decimals, like the real one.
///      Lets tests drive price, staleness, and malformed rounds.
contract MockFeed {
    int256 public answer;
    uint256 public updatedAt;
    uint80 public roundId;
    uint80 public answeredInRound;

    constructor(int256 _answer) {
        answer = _answer;
        updatedAt = block.timestamp;
        roundId = 1;
        answeredInRound = 1;
    }

    function setAnswer(int256 a) external {
        answer = a;
        updatedAt = block.timestamp;
        roundId += 1;
        answeredInRound = roundId;
    }

    function setUpdatedAt(uint256 t) external {
        updatedAt = t;
    }

    /// @dev Simulate an incomplete round: answeredInRound < roundId.
    function setIncompleteRound() external {
        roundId += 1;
    }

    function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80) {
        return (roundId, answer, updatedAt, updatedAt, answeredInRound);
    }
}

/// @dev Refuses ETH. Used to prove the treasury-transfer failure path reverts.
contract RejectsEth {
    receive() external payable {
        revert("no");
    }
}
