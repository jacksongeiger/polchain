// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @dev Test-only stand-in for Halo2VerifierReusable. Always verifies, so
///      ranking/settlement tests can force exact scores and ties through
///      synthetic instances. Never deployed to a live network.
contract MockVerifierV2 {
    function verifyProof(
        bytes calldata,
        uint256[] calldata,
        bytes32[] memory vka
    ) external pure returns (bool success, bytes32 vka_digest, int256[] memory rescaled) {
        success = true;
        vka_digest = keccak256(abi.encodePacked(vka));
        rescaled = new int256[](0);
    }
}
