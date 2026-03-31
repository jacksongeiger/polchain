// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @dev Test double for the EZKL Halo2Verifier. Returns a configurable boolean.
contract MockVerifier {
    bool private _result;

    constructor(bool result) {
        _result = result;
    }

    function verifyProof(bytes calldata, uint256[] calldata) external view returns (bool) {
        return _result;
    }
}
