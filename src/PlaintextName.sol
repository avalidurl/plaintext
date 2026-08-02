// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Base64} from "@openzeppelin/contracts/utils/Base64.sol";
import {Strings} from "@openzeppelin/contracts/utils/Strings.sol";

interface IAggregatorV3 {
    function latestRoundData()
        external
        view
        returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound);
}

/// @title plaintext names
/// @notice A username IS a token, minted when you enter. Names are TRADABLE and identity
///         FOLLOWS the token: transfer (or sell) a name and it moves off you and onto the
///         new owner automatically — `nameOf`/`holderOfName` always track the current
///         holder, so the board updates itself. You can also `rename` (burn + mint a new
///         one) or, if you hold several, pick your active handle with `setName`.
/// @dev No owner, no admin, no upgrade path, no setter. Prices are fixed in US cents and
///      converted to ETH at call time via Chainlink. Deployed for Ethereum mainnet:
///      the feed is mainnet ETH/USD and the staleness guard matches its 1h heartbeat.
///      Posts live in the separate `Plaintext` contract, which reads `hasName(addr)`
///      here to gate writing — so identity and authorship are two clean collections.
contract PlaintextName is ERC721, ReentrancyGuard {
    // ─── fixed prices, in US cents ───────────────────────────────────────────
    uint256 public constant DOOR_ASSIGNED_CENTS = 100; // $1.00 — a name is dealt to you
    uint256 public constant DOOR_CHOSEN_CENTS = 500; // $5.00 — you pick the name (and rename)

    // ─── immutable wiring ────────────────────────────────────────────────────
    address payable public immutable treasury;
    IAggregatorV3 public immutable feed;

    /// @dev Mainnet ETH/USD publishes on a 3600s heartbeat. 2h = heartbeat + 1h margin,
    ///      enough to ride out a delayed round without ever bricking the door. (The 4663
    ///      sibling uses 25h because its feed's heartbeat is 24h — do not copy that here.)
    uint256 public constant MAX_STALENESS = 2 hours;

    uint256 private _nextId = 1;
    uint256 private _entries; // hands admitted; seeds _deal() so arrival order matters

    mapping(address => string) public nameOf; // "" = has not entered
    mapping(bytes32 => address) public holderOfName; // keccak(name) => holder (0 = free)
    mapping(address => uint256) public tokenOf; // the name-token an address currently holds (0 = none)
    mapping(uint256 => string) public nameOfToken; // tokenId => name

    event Entered(address indexed hand, string name, bool chosen);
    event Renamed(address indexed hand, string oldName, string newName);

    error AlreadyEntered();
    error NotEntered();
    error NameTaken();
    error BadName();
    error Underpaid(uint256 required);
    error StaleFeed();
    error BadRound();
    error TransferFailed();
    error ZeroAddress();

    /// @notice Addresses that mint names for free. Set ONCE at construction, never again —
    ///         no function can add or remove one. Public so the carve-out is auditable.
    mapping(address => bool) public exempt;

    constructor(address payable _treasury, address _feed, address[] memory _exempt)
        ERC721("plaintext names", "NAME")
    {
        if (_treasury == address(0) || _feed == address(0)) revert ZeroAddress();
        treasury = _treasury;
        feed = IAggregatorV3(_feed);
        for (uint256 i; i < _exempt.length; ++i) {
            exempt[_exempt[i]] = true;
        }
        // Probe the feed last, after all state is written. Refuses to deploy against a
        // dead or wrong address — which matters because there is no admin to fix it after.
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

    // ─── the door ────────────────────────────────────────────────────────────

    /// @notice Take a name of your choosing and mint it. $5.
    function enterAs(string calldata handle) external payable nonReentrant {
        if (bytes(nameOf[msg.sender]).length != 0) revert AlreadyEntered();
        if (!_validName(handle)) revert BadName();
        if (holderOfName[keccak256(bytes(handle))] != address(0)) revert NameTaken();

        uint256 price = _take(DOOR_CHOSEN_CENTS); // checks
        _mintName(msg.sender, handle); // effects (state + mint)
        emit Entered(msg.sender, handle, true);
        _disburse(price); // interactions
    }

    /// @notice Accept whatever name you are dealt, and mint it. $1.
    function enter() external payable nonReentrant {
        if (bytes(nameOf[msg.sender]).length != 0) revert AlreadyEntered();

        uint256 price = _take(DOOR_ASSIGNED_CENTS); // checks
        unchecked {
            ++_entries; // must precede _deal(), which reads it
        }
        string memory handle = _deal();
        _mintName(msg.sender, handle); // effects
        emit Entered(msg.sender, handle, false);
        _disburse(price); // interactions
    }

    /// @notice Change your name: burn the token you hold, mint a new one. $5 (free for
    ///         exempt). Your posts live in the `Plaintext` contract keyed by ADDRESS, so
    ///         changing your name never touches them.
    function rename(string calldata handle) external payable nonReentrant {
        bytes memory current = bytes(nameOf[msg.sender]);
        if (current.length == 0) revert NotEntered();
        if (!_validName(handle)) revert BadName();
        if (holderOfName[keccak256(bytes(handle))] != address(0)) revert NameTaken(); // includes: same as now

        uint256 price = _take(DOOR_CHOSEN_CENTS); // checks

        string memory old = nameOf[msg.sender]; // effects
        uint256 oldId = tokenOf[msg.sender];
        delete holderOfName[keccak256(current)]; // free the old name for anyone
        delete nameOfToken[oldId];
        _burn(oldId); // burn the old name-token (soulbound allows to==0)
        _mintName(msg.sender, handle); // mint the new one
        emit Renamed(msg.sender, old, handle);

        _disburse(price); // interactions
    }

    /// @dev Writes the name mappings and mints the token. Caller has already validated
    ///      the name is well-formed and free.
    function _mintName(address to, string memory handle) private {
        uint256 id = _nextId++;
        nameOf[to] = handle;
        holderOfName[keccak256(bytes(handle))] = to;
        tokenOf[to] = id;
        nameOfToken[id] = handle;
        _safeMint(to, id);
    }

    // ─── read helpers for the posts contract + clients ───────────────────────

    /// @notice True once `hand` holds a name. The `Plaintext` posts contract gates on this.
    function hasName(address hand) external view returns (bool) {
        return bytes(nameOf[hand]).length != 0;
    }

    function totalNames() external view returns (uint256) {
        return _nextId - 1;
    }

    // ─── tradable identity ───────────────────────────────────────────────────

    /// @notice Emitted on a wallet-to-wallet transfer of a name, so indexers can move the
    ///         board's display name to the new owner without re-deriving it from state.
    event NameMoved(address indexed from, address indexed to, uint256 indexed tokenId, string name);

    /// @dev Identity follows the token. On a true transfer (not mint/burn) we move the
    ///      name off `from` (iff it was their active handle) and make it `to`'s active
    ///      handle, so `nameOf`/`tokenOf`/`holderOfName` always reflect the current owner.
    ///      An address may own several names; the most recently received/minted one is its
    ///      active handle, switchable with `setName`. Mint (from==0) is bookkept by
    ///      `_mintName`; burn (to==0) by `rename` — so we only rewrite on transfers.
    function _update(address to, uint256 tokenId, address auth) internal override returns (address) {
        address from = super._update(to, tokenId, auth);
        if (from != address(0) && to != address(0) && from != to) {
            string memory handle = nameOfToken[tokenId];
            if (tokenOf[from] == tokenId) {
                delete nameOf[from];
                tokenOf[from] = 0;
            }
            nameOf[to] = handle;
            tokenOf[to] = tokenId;
            holderOfName[keccak256(bytes(handle))] = to;
            emit NameMoved(from, to, tokenId, handle);
        }
        return from;
    }

    /// @notice For an address holding more than one name: make `tokenId` your active
    ///         handle (the one the board shows). Free — a plain state change.
    function setName(uint256 tokenId) external {
        if (ownerOf(tokenId) != msg.sender) revert NotEntered();
        nameOf[msg.sender] = nameOfToken[tokenId];
        tokenOf[msg.sender] = tokenId;
    }

    // ─── settlement (identical model to the posts contract) ──────────────────

    function _take(uint256 cents) private view returns (uint256 price) {
        if (exempt[msg.sender]) return 0;
        price = priceWei(cents);
        if (msg.value < price) revert Underpaid(price);
    }

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

    /// @dev Deals a name. Collision-resilient: rehashes until one is free. Uses
    ///      `blockhash(block.number - 1)` as the seed so the dealt name cannot be
    ///      computed before the block exists — the same guarantee the $5 chosen tier
    ///      sells. `_entries` folds in arrival order. Neither is cryptographic
    ///      randomness and neither needs to be; the requirement is only unpredictability.
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

    /// @dev Fully on-chain metadata + art. The card is generated from the name and
    ///      base64-wrapped so it renders anywhere (OpenSea, wallets) with no server,
    ///      no IPFS, no external dependency. Names are `[a-z0-9-]` (see `_validName`),
    ///      so they are safe to inline in the SVG/JSON without escaping.
    function tokenURI(uint256 id) public view override returns (string memory) {
        if (_ownerOf(id) == address(0)) revert NotEntered();
        string memory handle = nameOfToken[id];
        string memory image = Base64.encode(bytes(_card(handle, id)));
        string memory json = string.concat(
            '{"name":"@',
            handle,
            '","description":"a plaintext username, held onchain. tradable - the board follows the owner.","image":"data:image/svg+xml;base64,',
            image,
            '"}'
        );
        return string.concat("data:application/json;base64,", Base64.encode(bytes(json)));
    }

    /// @dev The card. Black monospace on warm off-white, a dotted field and double frame
    ///      echoing the board's masthead, one hairline of our blue. The handle is the art;
    ///      its font shrinks by length so even a 16-char name stays inside the frame.
    function _card(string memory handle, uint256 id) private pure returns (string memory) {
        uint256 len = bytes(handle).length;
        uint256 fs = len <= 8 ? 120 : (len <= 12 ? 84 : 56);
        return string.concat(
            '<svg xmlns="http://www.w3.org/2000/svg" width="1000" height="1000" viewBox="0 0 1000 1000">',
            '<defs><pattern id="d" width="26" height="26" patternUnits="userSpaceOnUse"><circle cx="3" cy="3" r="1.5" fill="#DCE6F5"/></pattern></defs>',
            '<rect width="1000" height="1000" fill="#FBFBF9"/>',
            '<rect x="60" y="60" width="880" height="880" fill="url(#d)"/>',
            '<rect x="60" y="60" width="880" height="880" fill="none" stroke="#16181D" stroke-width="3"/>',
            '<rect x="74" y="74" width="852" height="852" fill="none" stroke="#2D5FB6" stroke-width="1.5"/>',
            '<text x="104" y="140" font-family="monospace" font-size="30" letter-spacing="2" fill="#16181D">plaintext</text>',
            '<text x="896" y="140" text-anchor="end" font-family="monospace" font-size="30" fill="#8A94A6">#',
            Strings.toString(id),
            '</text>',
            '<text x="500" y="512" text-anchor="middle" font-family="monospace" font-weight="700" font-size="',
            Strings.toString(fs),
            '" fill="#16181D">@',
            handle,
            '</text>',
            '<text x="500" y="588" text-anchor="middle" font-family="monospace" font-size="30" fill="#5B6472">a name, held onchain</text>',
            '<text x="104" y="896" font-family="monospace" font-size="26" fill="#8A94A6">ethereum</text>',
            '<text x="896" y="896" text-anchor="end" font-family="monospace" font-size="26" fill="#8A94A6">tradable</text>',
            '</svg>'
        );
    }

    /// @dev No receive/fallback. ETH arrives only through a priced entry point.
}
