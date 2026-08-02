// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

interface IAggregatorV3 {
    function latestRoundData()
        external
        view
        returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound);
}

/// @title plaintext posts
/// @notice One textarea. Every notice is a token. POSTS ONLY: identity lives in the
///         separate `PlaintextName` NFT on Ethereum mainnet, so this contract carries
///         no door and no name-gate — anyone pays the price and publishes; the board
///         joins each author address to its Ethereum name off-chain. This is what
///         lets writing stay cheap here while the name stays a mainnet asset.
/// @dev No owner, no admin, no upgrade path, no setter. Prices are fixed in US cents
///      and converted to ETH at call time. Nobody can change them, including the deployer.
contract PlaintextPosts is ERC721, ReentrancyGuard {
    // ─── fixed prices, in US cents ───────────────────────────────────────────
    uint256 public constant NOTICE_CENTS = 300; // $3.00 — publish
    uint256 public constant REMARK_CENTS = 50; // $0.50 — reply

    // ─── immutable wiring ────────────────────────────────────────────────────
    address payable public immutable treasury;
    IAggregatorV3 public immutable feed;

    /// @dev The 4663 ETH/USD feed publishes on a 86400s heartbeat, NOT the 3600s
    ///      used on mainnet. A one-hour staleness guard would revert on an ordinary
    ///      afternoon. 25h = heartbeat + 1h margin. Do not lower this.
    uint256 public constant MAX_STALENESS = 25 hours;

    uint256 private _nextId = 1;

    mapping(uint256 => string) private _cid;
    mapping(uint256 => uint256) public parentOf; // 0 = top-level notice

    event Posted(address indexed hand, uint256 indexed id, uint256 indexed parent, string cid);
    event Tipped(address indexed from, address indexed to, uint256 indexed id, uint256 amount);

    error BadCid();
    error Underpaid(uint256 required);
    error NoSuchNotice();
    error StaleFeed();
    error BadRound();
    error TransferFailed();
    error ZeroAddress();

    /// @notice Addresses that write for free. Set ONCE at construction and never
    ///         again — there is no function anywhere that can add or remove one.
    ///         Public on purpose: the exemption is auditable, so anyone can see
    ///         exactly who writes without paying.
    mapping(address => bool) public exempt;

    constructor(address payable _treasury, address _feed, address[] memory _exempt) ERC721("plaintext", "TXT") {
        // There is no admin and nothing is upgradeable. A wrong argument here is
        // permanent: a zero treasury burns every fee ever paid, with no recourse.
        if (_treasury == address(0) || _feed == address(0)) revert ZeroAddress();
        treasury = _treasury;
        feed = IAggregatorV3(_feed);
        for (uint256 i; i < _exempt.length; ++i) {
            exempt[_exempt[i]] = true;
        }
        // Probe the feed last, so ALL state is written before the external call.
        // Refuses to deploy against a dead or wrong address — which matters here
        // precisely because there is no admin to fix it afterwards.
        (, int256 answer,,,) = IAggregatorV3(_feed).latestRoundData();
        if (answer <= 0) revert BadRound();
    }

    // ─── pricing ─────────────────────────────────────────────────────────────

    /// @notice Wei currently required for a given price in US cents.
    /// @dev feed has 8 decimals. cents * 1e18 * 1e8 / (100 * answer) == cents * 1e24 / answer.
    function priceWei(uint256 cents) public view returns (uint256) {
        (uint80 roundId, int256 answer,, uint256 updatedAt, uint80 answeredInRound) = feed.latestRoundData();
        if (answer <= 0 || answeredInRound < roundId) revert BadRound();
        if (block.timestamp - updatedAt > MAX_STALENESS) revert StaleFeed();
        return (cents * 1e24) / uint256(answer);
    }

    function noticeWei() external view returns (uint256) {
        return priceWei(NOTICE_CENTS);
    }

    function remarkWei() external view returns (uint256) {
        return priceWei(REMARK_CENTS);
    }

    // ─── writing ─────────────────────────────────────────────────────────────

    function post(string calldata cid) external payable nonReentrant returns (uint256 id) {
        id = _write(cid, 0, NOTICE_CENTS);
    }

    function reply(uint256 parent, string calldata cid) external payable nonReentrant returns (uint256 id) {
        if (_ownerOf(parent) == address(0)) revert NoSuchNotice();
        id = _write(cid, parent, REMARK_CENTS);
    }

    function _write(string calldata cid, uint256 parent, uint256 cents) private returns (uint256 id) {
        if (bytes(cid).length == 0) revert BadCid();

        uint256 price = _take(cents); // checks

        id = _nextId++; // effects
        _cid[id] = cid;
        parentOf[id] = parent;
        emit Posted(msg.sender, id, parent, cid);

        _safeMint(msg.sender, id); // interactions
        _disburse(price);
    }

    // ─── tipping ─────────────────────────────────────────────────────────────

    /// @notice Send ETH straight to a notice's author. Takes no cut.
    function tip(uint256 id) external payable nonReentrant {
        address author = _ownerOf(id);
        if (author == address(0)) revert NoSuchNotice();
        if (msg.value == 0) revert Underpaid(1);

        (bool ok,) = payable(author).call{value: msg.value}("");
        if (!ok) revert TransferFailed();
        emit Tipped(msg.sender, author, id, msg.value);
    }

    // ─── settlement ──────────────────────────────────────────────────────────

    /// @dev Checks half: price the call and confirm the caller covered it.
    ///      Pure of side effects, so callers can complete their state writes
    ///      before any external call happens.
    function _take(uint256 cents) private view returns (uint256 price) {
        if (exempt[msg.sender]) return 0; // listed addresses write for free
        price = priceWei(cents);
        if (msg.value < price) revert Underpaid(price);
    }

    /// @dev Interactions half: pay the treasury, refund the overage. Called LAST,
    ///      after every state write, so checks-effects-interactions holds without
    ///      leaning on nonReentrant alone.
    ///
    ///      Refunding matters: the feed moves on 0.5% deviation, so a client quote
    ///      can go stale between render and submit. require(msg.value == price)
    ///      would fail constantly in normal use.
    function _disburse(uint256 price) private {
        if (price > 0) {
            (bool paid,) = treasury.call{value: price}("");
            if (!paid) revert TransferFailed();
        }

        uint256 change = msg.value - price;
        if (change > 0) {
            (bool sent,) = payable(msg.sender).call{value: change}("");
            if (!sent) revert TransferFailed();
        }
    }

    // ─── metadata ────────────────────────────────────────────────────────────

    function tokenURI(uint256 id) public view override returns (string memory) {
        if (_ownerOf(id) == address(0)) revert NoSuchNotice();
        return string.concat("ipfs://", _cid[id]);
    }

    function totalPosted() external view returns (uint256) {
        return _nextId - 1;
    }

    /// @dev No receive/fallback. ETH arrives only through a priced entry point.
}
