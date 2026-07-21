// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @title StubFeed — TESTNET ONLY
/// @notice Chainlink does NOT operate an ETH/USD feed on Robinhood Chain testnet
///         (46630). Verified 2026-07-20: the mainnet aggregator address has no code
///         there, and no testnet entry exists in Chainlink's feed directory.
///
///         So testnet deployments need a stand-in. This is that stand-in, and it is
///         the ONLY difference between a testnet and a mainnet deployment — the
///         Plaintext contract itself is byte-identical in both. Production spec,
///         test input.
///
/// @dev    ⛔ NEVER pass this address to a mainnet deployment. Anyone can move the
///         price. On 4663 the constructor takes the real Chainlink aggregator.
contract StubFeed {
    int256 public answer;
    uint256 public updatedAt;
    uint80 public roundId = 1;

    event AnswerSet(int256 answer);

    constructor(int256 initial) {
        answer = initial;
        updatedAt = block.timestamp;
    }

    /// @notice Deliberately unguarded — this is a testnet toy, not an oracle.
    function setAnswer(int256 a) external {
        answer = a;
        updatedAt = block.timestamp;
        roundId += 1;
        emit AnswerSet(a);
    }

    /// @notice Age the feed artificially, to exercise the staleness guard on testnet.
    function setUpdatedAt(uint256 t) external {
        updatedAt = t;
    }

    function decimals() external pure returns (uint8) {
        return 8;
    }

    function description() external pure returns (string memory) {
        return "STUB ETH / USD (testnet only)";
    }

    function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80) {
        return (roundId, answer, updatedAt, updatedAt, roundId);
    }
}
