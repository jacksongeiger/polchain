// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @title POLToken — Proof of Learning ERC-20 Token
/// @notice Fixed supply of 1,000,000 POL minted to the deployer
contract POLToken is ERC20 {
    uint256 public constant INITIAL_SUPPLY = 1_000_000 * 10 ** 18;

    constructor() ERC20("Proof of Learning", "POL") {
        _mint(msg.sender, INITIAL_SUPPLY);
    }
}
