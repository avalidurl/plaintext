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

/// @title plaintext
/// @notice One textarea. Each hand keeps its own page. Every notice is a token.
/// @dev No owner, no admin, no upgrade path, no setter. Prices are fixed in US cents
///      and converted to ETH at call time. Nobody can change them, including the deployer.
contract Plaintext is ERC721, ReentrancyGuard {
    // ─── fixed prices, in US cents ───────────────────────────────────────────
    uint256 public constant DOOR_ASSIGNED_CENTS = 100; // $1.00 — a name is dealt to you
    uint256 public constant DOOR_CHOSEN_CENTS = 500; // $5.00 — you pick the name
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
    uint256 private _entries; // hands admitted; seeds _deal() so arrival order matters

    mapping(address => string) public nameOf;
    mapping(bytes32 => address) public holderOfName;
    mapping(uint256 => string) private _cid;
    mapping(uint256 => uint256) public parentOf; // 0 = top-level notice

    event Entered(address indexed hand, string name, bool chosen);
    event Renamed(address indexed hand, string oldName, string newName);
    event Posted(address indexed hand, uint256 indexed id, uint256 indexed parent, string cid);
    event Tipped(address indexed from, address indexed to, uint256 indexed id, uint256 amount);

    error AlreadyEntered();
    error NotEntered();
    error NameTaken();
    error BadName();
    error Underpaid(uint256 required);
    error NoSuchNotice();
    error StaleFeed();
    error BadRound();
    error TransferFailed();
    error ZeroAddress();

    /// @notice Addresses that write for free. Set ONCE at construction and never
    ///         again — there is no function anywhere that can add or remove one.
    ///         Public on purpose: the exemption is auditable, so anyone can see
    ///         exactly who writes without paying. Everyone NOT listed pays full
    ///         price, so the "every line has a price" membrane stays intact for
    ///         the public — this is a fixed, transparent founder carve-out, not a
    ///         lever the operator can pull later.
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

    function doorAssignedWei() external view returns (uint256) {
        return priceWei(DOOR_ASSIGNED_CENTS);
    }

    function doorChosenWei() external view returns (uint256) {
        return priceWei(DOOR_CHOSEN_CENTS);
    }

    function noticeWei() external view returns (uint256) {
        return priceWei(NOTICE_CENTS);
    }

    function remarkWei() external view returns (uint256) {
        return priceWei(REMARK_CENTS);
    }

    // ─── the door ────────────────────────────────────────────────────────────

    /// @notice Take a name of your choosing. $5.
    function enterAs(string calldata handle) external payable nonReentrant {
        if (bytes(nameOf[msg.sender]).length != 0) revert AlreadyEntered();
        if (!_validName(handle)) revert BadName();
        bytes32 k = keccak256(bytes(handle));
        if (holderOfName[k] != address(0)) revert NameTaken();

        uint256 price = _take(DOOR_CHOSEN_CENTS); // checks
        nameOf[msg.sender] = handle; // effects
        holderOfName[k] = msg.sender;
        emit Entered(msg.sender, handle, true);
        _disburse(price); // interactions
    }

    /// @notice Accept whatever name you are dealt. $1.
    function enter() external payable nonReentrant {
        if (bytes(nameOf[msg.sender]).length != 0) revert AlreadyEntered();

        uint256 price = _take(DOOR_ASSIGNED_CENTS); // checks
        unchecked {
            ++_entries; // effects — must precede _deal(), which reads it
        }
        string memory handle = _deal();
        bytes32 k = keccak256(bytes(handle));
        nameOf[msg.sender] = handle;
        holderOfName[k] = msg.sender;
        emit Entered(msg.sender, handle, false);
        _disburse(price); // interactions
    }

    /// @notice Trade the name you have for one you choose. $5 (the chosen-name
    ///         price), or free for exempt addresses. Lets a hand that took a dealt
    ///         name at the door upgrade to a real one later. Your notices are held
    ///         by your ADDRESS, not your name, so none of them are affected.
    function rename(string calldata handle) external payable nonReentrant {
        bytes memory current = bytes(nameOf[msg.sender]);
        if (current.length == 0) revert NotEntered();
        if (!_validName(handle)) revert BadName();
        bytes32 k = keccak256(bytes(handle));
        if (holderOfName[k] != address(0)) revert NameTaken(); // includes: same name as now

        uint256 price = _take(DOOR_CHOSEN_CENTS); // checks
        string memory old = nameOf[msg.sender]; // effects
        delete holderOfName[keccak256(current)]; // free the old name for anyone
        nameOf[msg.sender] = handle;
        holderOfName[k] = msg.sender;
        emit Renamed(msg.sender, old, handle);
        _disburse(price); // interactions
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
        if (bytes(nameOf[msg.sender]).length == 0) revert NotEntered();
        if (bytes(cid).length == 0) revert BadName();

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
            // Skipped entirely for exempt writers (price 0): no fee moves, and a
            // free writer need not send any ETH at all.
            (bool paid,) = treasury.call{value: price}("");
            if (!paid) revert TransferFailed();
        }

        uint256 change = msg.value - price;
        if (change > 0) {
            (bool sent,) = payable(msg.sender).call{value: change}("");
            if (!sent) revert TransferFailed();
        }
    }

    // ─── names ───────────────────────────────────────────────────────────────

    /// @dev 1–16 chars, lowercase a-z / 0-9 / hyphen, must start with a letter.
    function _validName(string calldata handle) private pure returns (bool) {
        bytes calldata b = bytes(handle);
        if (b.length == 0 || b.length > 16) return false;
        if (b[0] < 0x61 || b[0] > 0x7A) return false;
        for (uint256 i; i < b.length; ++i) {
            bytes1 c = b[i];
            bool ok = (c >= 0x61 && c <= 0x7A) || (c >= 0x30 && c <= 0x39) || c == 0x2D;
            if (!ok) return false;
        }
        return true;
    }

    /// @dev Deals a name. Collision-resilient: rehashes until one is free.
    ///
    ///      ⚠️ Do NOT reintroduce `block.prevrandao` here. On chain 4663 the
    ///      PREVRANDAO opcode returns literally `1` (verified by eth_call against
    ///      a raw `0x44` payload, 2026-07-20), so a hash over
    ///      (msg.sender, prevrandao) has ZERO entropy — the dealt name becomes a
    ///      pure, publicly computable function of the address.
    ///
    ///      That is not merely a griefing risk. The alphabet is 16 characters and
    ///      names are 8 long, so an attacker could grind addresses offline until
    ///      one deals a desirable name, then take it for $1 — bypassing the $5
    ///      chosen-name tier entirely and hollowing out the price ladder.
    ///
    ///      `blockhash(block.number - 1)` defeats that: it cannot be known before
    ///      the block exists, and at ~101ms per block there is no window in which
    ///      to grind 16^8 candidates. `_entries` additionally makes the result
    ///      depend on arrival order. Neither is cryptographic randomness and
    ///      neither needs to be — the requirement is only that a name cannot be
    ///      chosen in advance, which is exactly what the $5 tier sells.
    function _deal() private view returns (string memory) {
        bytes16 alphabet = "abcdefghijklmnop";
        bytes32 seed = blockhash(block.number - 1);
        for (uint256 salt; salt < 256; ++salt) {
            bytes32 h = keccak256(abi.encodePacked(msg.sender, seed, _entries, salt));
            bytes memory out = new bytes(8);
            for (uint256 i; i < 8; ++i) {
                out[i] = alphabet[uint8(h[i]) & 0x0F];
            }
            if (holderOfName[keccak256(out)] == address(0)) return string(out);
        }
        revert NameTaken();
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
