// SPDX-License-Identifier: MIT

pragma solidity ^0.8.0;

contract Halo2Verifier {
    uint256 internal constant    DELTA = 4131629893567559867359510883348571134090853742863529169391034518566172092834;
    uint256 internal constant        R = 21888242871839275222246405745257275088548364400416034343698204186575808495617; 

    uint256 internal constant FIRST_QUOTIENT_X_CPTR = 0x0964;
    uint256 internal constant  LAST_QUOTIENT_X_CPTR = 0x0a64;

    uint256 internal constant                VK_MPTR = 0x0d60;
    uint256 internal constant         VK_DIGEST_MPTR = 0x0d60;
    uint256 internal constant     NUM_INSTANCES_MPTR = 0x0d80;
    uint256 internal constant                 K_MPTR = 0x0da0;
    uint256 internal constant             N_INV_MPTR = 0x0dc0;
    uint256 internal constant             OMEGA_MPTR = 0x0de0;
    uint256 internal constant         OMEGA_INV_MPTR = 0x0e00;
    uint256 internal constant    OMEGA_INV_TO_L_MPTR = 0x0e20;
    uint256 internal constant   HAS_ACCUMULATOR_MPTR = 0x0e40;
    uint256 internal constant        ACC_OFFSET_MPTR = 0x0e60;
    uint256 internal constant     NUM_ACC_LIMBS_MPTR = 0x0e80;
    uint256 internal constant NUM_ACC_LIMB_BITS_MPTR = 0x0ea0;
    uint256 internal constant              G1_X_MPTR = 0x0ec0;
    uint256 internal constant              G1_Y_MPTR = 0x0ee0;
    uint256 internal constant            G2_X_1_MPTR = 0x0f00;
    uint256 internal constant            G2_X_2_MPTR = 0x0f20;
    uint256 internal constant            G2_Y_1_MPTR = 0x0f40;
    uint256 internal constant            G2_Y_2_MPTR = 0x0f60;
    uint256 internal constant      NEG_S_G2_X_1_MPTR = 0x0f80;
    uint256 internal constant      NEG_S_G2_X_2_MPTR = 0x0fa0;
    uint256 internal constant      NEG_S_G2_Y_1_MPTR = 0x0fc0;
    uint256 internal constant      NEG_S_G2_Y_2_MPTR = 0x0fe0;

    uint256 internal constant CHALLENGE_MPTR = 0x1c00;

    uint256 internal constant THETA_MPTR = 0x1c40;
    uint256 internal constant  BETA_MPTR = 0x1c60;
    uint256 internal constant GAMMA_MPTR = 0x1c80;
    uint256 internal constant     Y_MPTR = 0x1ca0;
    uint256 internal constant     X_MPTR = 0x1cc0;
    uint256 internal constant  ZETA_MPTR = 0x1ce0;
    uint256 internal constant    NU_MPTR = 0x1d00;
    uint256 internal constant    MU_MPTR = 0x1d20;

    uint256 internal constant       ACC_LHS_X_MPTR = 0x1d40;
    uint256 internal constant       ACC_LHS_Y_MPTR = 0x1d60;
    uint256 internal constant       ACC_RHS_X_MPTR = 0x1d80;
    uint256 internal constant       ACC_RHS_Y_MPTR = 0x1da0;
    uint256 internal constant             X_N_MPTR = 0x1dc0;
    uint256 internal constant X_N_MINUS_1_INV_MPTR = 0x1de0;
    uint256 internal constant          L_LAST_MPTR = 0x1e00;
    uint256 internal constant         L_BLIND_MPTR = 0x1e20;
    uint256 internal constant             L_0_MPTR = 0x1e40;
    uint256 internal constant   INSTANCE_EVAL_MPTR = 0x1e60;
    uint256 internal constant   QUOTIENT_EVAL_MPTR = 0x1e80;
    uint256 internal constant      QUOTIENT_X_MPTR = 0x1ea0;
    uint256 internal constant      QUOTIENT_Y_MPTR = 0x1ec0;
    uint256 internal constant          R_EVAL_MPTR = 0x1ee0;
    uint256 internal constant   PAIRING_LHS_X_MPTR = 0x1f00;
    uint256 internal constant   PAIRING_LHS_Y_MPTR = 0x1f20;
    uint256 internal constant   PAIRING_RHS_X_MPTR = 0x1f40;
    uint256 internal constant   PAIRING_RHS_Y_MPTR = 0x1f60;

    function verifyProof(
        bytes calldata proof,
        uint256[] calldata instances
    ) public returns (bool) {
        assembly {
            // Read EC point (x, y) at (proof_cptr, proof_cptr + 0x20),
            // and check if the point is on affine plane,
            // and store them in (hash_mptr, hash_mptr + 0x20).
            // Return updated (success, proof_cptr, hash_mptr).
            function read_ec_point(success, proof_cptr, hash_mptr, q) -> ret0, ret1, ret2 {
                let x := calldataload(proof_cptr)
                let y := calldataload(add(proof_cptr, 0x20))
                ret0 := and(success, lt(x, q))
                ret0 := and(ret0, lt(y, q))
                ret0 := and(ret0, eq(mulmod(y, y, q), addmod(mulmod(x, mulmod(x, x, q), q), 3, q)))
                mstore(hash_mptr, x)
                mstore(add(hash_mptr, 0x20), y)
                ret1 := add(proof_cptr, 0x40)
                ret2 := add(hash_mptr, 0x40)
            }

            // Squeeze challenge by keccak256(memory[0..hash_mptr]),
            // and store hash mod r as challenge in challenge_mptr,
            // and push back hash in 0x00 as the first input for next squeeze.
            // Return updated (challenge_mptr, hash_mptr).
            function squeeze_challenge(challenge_mptr, hash_mptr, r) -> ret0, ret1 {
                let hash := keccak256(0x00, hash_mptr)
                mstore(challenge_mptr, mod(hash, r))
                mstore(0x00, hash)
                ret0 := add(challenge_mptr, 0x20)
                ret1 := 0x20
            }

            // Squeeze challenge without absorbing new input from calldata,
            // by putting an extra 0x01 in memory[0x20] and squeeze by keccak256(memory[0..21]),
            // and store hash mod r as challenge in challenge_mptr,
            // and push back hash in 0x00 as the first input for next squeeze.
            // Return updated (challenge_mptr).
            function squeeze_challenge_cont(challenge_mptr, r) -> ret {
                mstore8(0x20, 0x01)
                let hash := keccak256(0x00, 0x21)
                mstore(challenge_mptr, mod(hash, r))
                mstore(0x00, hash)
                ret := add(challenge_mptr, 0x20)
            }

            // Batch invert values in memory[mptr_start..mptr_end] in place.
            // Return updated (success).
            function batch_invert(success, mptr_start, mptr_end) -> ret {
                let gp_mptr := mptr_end
                let gp := mload(mptr_start)
                let mptr := add(mptr_start, 0x20)
                for
                    {}
                    lt(mptr, sub(mptr_end, 0x20))
                    {}
                {
                    gp := mulmod(gp, mload(mptr), R)
                    mstore(gp_mptr, gp)
                    mptr := add(mptr, 0x20)
                    gp_mptr := add(gp_mptr, 0x20)
                }
                gp := mulmod(gp, mload(mptr), R)

                mstore(gp_mptr, 0x20)
                mstore(add(gp_mptr, 0x20), 0x20)
                mstore(add(gp_mptr, 0x40), 0x20)
                mstore(add(gp_mptr, 0x60), gp)
                mstore(add(gp_mptr, 0x80), sub(R, 2))
                mstore(add(gp_mptr, 0xa0), R)
                ret := and(success, staticcall(gas(), 0x05, gp_mptr, 0xc0, gp_mptr, 0x20))
                let all_inv := mload(gp_mptr)

                let first_mptr := mptr_start
                let second_mptr := add(first_mptr, 0x20)
                gp_mptr := sub(gp_mptr, 0x20)
                for
                    {}
                    lt(second_mptr, mptr)
                    {}
                {
                    let inv := mulmod(all_inv, mload(gp_mptr), R)
                    all_inv := mulmod(all_inv, mload(mptr), R)
                    mstore(mptr, inv)
                    mptr := sub(mptr, 0x20)
                    gp_mptr := sub(gp_mptr, 0x20)
                }
                let inv_first := mulmod(all_inv, mload(second_mptr), R)
                let inv_second := mulmod(all_inv, mload(first_mptr), R)
                mstore(first_mptr, inv_first)
                mstore(second_mptr, inv_second)
            }

            // Add (x, y) into point at (0x00, 0x20).
            // Return updated (success).
            function ec_add_acc(success, x, y) -> ret {
                mstore(0x40, x)
                mstore(0x60, y)
                ret := and(success, staticcall(gas(), 0x06, 0x00, 0x80, 0x00, 0x40))
            }

            // Scale point at (0x00, 0x20) by scalar.
            function ec_mul_acc(success, scalar) -> ret {
                mstore(0x40, scalar)
                ret := and(success, staticcall(gas(), 0x07, 0x00, 0x60, 0x00, 0x40))
            }

            // Add (x, y) into point at (0x80, 0xa0).
            // Return updated (success).
            function ec_add_tmp(success, x, y) -> ret {
                mstore(0xc0, x)
                mstore(0xe0, y)
                ret := and(success, staticcall(gas(), 0x06, 0x80, 0x80, 0x80, 0x40))
            }

            // Scale point at (0x80, 0xa0) by scalar.
            // Return updated (success).
            function ec_mul_tmp(success, scalar) -> ret {
                mstore(0xc0, scalar)
                ret := and(success, staticcall(gas(), 0x07, 0x80, 0x60, 0x80, 0x40))
            }

            // Perform pairing check.
            // Return updated (success).
            function ec_pairing(success, lhs_x, lhs_y, rhs_x, rhs_y) -> ret {
                mstore(0x00, lhs_x)
                mstore(0x20, lhs_y)
                mstore(0x40, mload(G2_X_1_MPTR))
                mstore(0x60, mload(G2_X_2_MPTR))
                mstore(0x80, mload(G2_Y_1_MPTR))
                mstore(0xa0, mload(G2_Y_2_MPTR))
                mstore(0xc0, rhs_x)
                mstore(0xe0, rhs_y)
                mstore(0x100, mload(NEG_S_G2_X_1_MPTR))
                mstore(0x120, mload(NEG_S_G2_X_2_MPTR))
                mstore(0x140, mload(NEG_S_G2_Y_1_MPTR))
                mstore(0x160, mload(NEG_S_G2_Y_2_MPTR))
                ret := and(success, staticcall(gas(), 0x08, 0x00, 0x180, 0x00, 0x20))
                ret := and(ret, mload(0x00))
            }

            // Modulus
            let q := 21888242871839275222246405745257275088696311157297823662689037894645226208583 // BN254 base field
            let r := 21888242871839275222246405745257275088548364400416034343698204186575808495617 // BN254 scalar field 

            // Initialize success as true
            let success := true

            {
                // Load vk_digest and num_instances of vk into memory
                mstore(0x0d60, 0x1ae50d31c5d1f0ea0501b4e154d02e600d0567b737428405a06e50af969fa8e9) // vk_digest
                mstore(0x0d80, 0x0000000000000000000000000000000000000000000000000000000000000051) // num_instances

                // Check valid length of proof
                success := and(success, eq(0x1800, proof.length))

                // Check valid length of instances
                let num_instances := mload(NUM_INSTANCES_MPTR)
                success := and(success, eq(num_instances, instances.length))

                // Absorb vk diegst
                mstore(0x00, mload(VK_DIGEST_MPTR))

                // Read instances and witness commitments and generate challenges
                let hash_mptr := 0x20
                let instance_cptr := instances.offset
                for
                    { let instance_cptr_end := add(instance_cptr, mul(0x20, num_instances)) }
                    lt(instance_cptr, instance_cptr_end)
                    {}
                {
                    let instance := calldataload(instance_cptr)
                    success := and(success, lt(instance, r))
                    mstore(hash_mptr, instance)
                    instance_cptr := add(instance_cptr, 0x20)
                    hash_mptr := add(hash_mptr, 0x20)
                }

                let proof_cptr := proof.offset
                let challenge_mptr := CHALLENGE_MPTR

                // Phase 1
                for
                    { let proof_cptr_end := add(proof_cptr, 0x03c0) }
                    lt(proof_cptr, proof_cptr_end)
                    {}
                {
                    success, proof_cptr, hash_mptr := read_ec_point(success, proof_cptr, hash_mptr, q)
                }

                challenge_mptr, hash_mptr := squeeze_challenge(challenge_mptr, hash_mptr, r)
                challenge_mptr := squeeze_challenge_cont(challenge_mptr, r)

                // Phase 2
                for
                    { let proof_cptr_end := add(proof_cptr, 0x0180) }
                    lt(proof_cptr, proof_cptr_end)
                    {}
                {
                    success, proof_cptr, hash_mptr := read_ec_point(success, proof_cptr, hash_mptr, q)
                }

                challenge_mptr, hash_mptr := squeeze_challenge(challenge_mptr, hash_mptr, r)

                // Phase 3
                for
                    { let proof_cptr_end := add(proof_cptr, 0x0100) }
                    lt(proof_cptr, proof_cptr_end)
                    {}
                {
                    success, proof_cptr, hash_mptr := read_ec_point(success, proof_cptr, hash_mptr, q)
                }

                challenge_mptr, hash_mptr := squeeze_challenge(challenge_mptr, hash_mptr, r)
                challenge_mptr := squeeze_challenge_cont(challenge_mptr, r)

                // Phase 4
                for
                    { let proof_cptr_end := add(proof_cptr, 0x02c0) }
                    lt(proof_cptr, proof_cptr_end)
                    {}
                {
                    success, proof_cptr, hash_mptr := read_ec_point(success, proof_cptr, hash_mptr, q)
                }

                challenge_mptr, hash_mptr := squeeze_challenge(challenge_mptr, hash_mptr, r)

                // Phase 5
                for
                    { let proof_cptr_end := add(proof_cptr, 0x0140) }
                    lt(proof_cptr, proof_cptr_end)
                    {}
                {
                    success, proof_cptr, hash_mptr := read_ec_point(success, proof_cptr, hash_mptr, q)
                }

                challenge_mptr, hash_mptr := squeeze_challenge(challenge_mptr, hash_mptr, r)

                // Read evaluations
                for
                    { let proof_cptr_end := add(proof_cptr, 0x0d40) }
                    lt(proof_cptr, proof_cptr_end)
                    {}
                {
                    let eval := calldataload(proof_cptr)
                    success := and(success, lt(eval, r))
                    mstore(hash_mptr, eval)
                    proof_cptr := add(proof_cptr, 0x20)
                    hash_mptr := add(hash_mptr, 0x20)
                }

                // Read batch opening proof and generate challenges
                challenge_mptr, hash_mptr := squeeze_challenge(challenge_mptr, hash_mptr, r)       // zeta
                challenge_mptr := squeeze_challenge_cont(challenge_mptr, r)                        // nu

                success, proof_cptr, hash_mptr := read_ec_point(success, proof_cptr, hash_mptr, q) // W

                challenge_mptr, hash_mptr := squeeze_challenge(challenge_mptr, hash_mptr, r)       // mu

                success, proof_cptr, hash_mptr := read_ec_point(success, proof_cptr, hash_mptr, q) // W'

                // Load full vk into memory
                mstore(0x0d60, 0x1ae50d31c5d1f0ea0501b4e154d02e600d0567b737428405a06e50af969fa8e9) // vk_digest
                mstore(0x0d80, 0x0000000000000000000000000000000000000000000000000000000000000051) // num_instances
                mstore(0x0da0, 0x0000000000000000000000000000000000000000000000000000000000000012) // k
                mstore(0x0dc0, 0x30644259cd94e7dd5045d7a27013b7fcd21c9e3b7fa75222e7bda49b729b0401) // n_inv
                mstore(0x0de0, 0x0f60c8fe0414cb9379b2d39267945f6bd60d06a05216231b26a9fcf88ddbfebe) // omega
                mstore(0x0e00, 0x0e1165d221ab96da2bb4efe1b8fbf541b58d00917384a41bc6ab624d6d3e2b76) // omega_inv
                mstore(0x0e20, 0x15a9c33a6d34b8fb8e5c3ff61814ca50c878ed14bc17d9442cd5c127bf33fd6d) // omega_inv_to_l
                mstore(0x0e40, 0x0000000000000000000000000000000000000000000000000000000000000000) // has_accumulator
                mstore(0x0e60, 0x0000000000000000000000000000000000000000000000000000000000000000) // acc_offset
                mstore(0x0e80, 0x0000000000000000000000000000000000000000000000000000000000000000) // num_acc_limbs
                mstore(0x0ea0, 0x0000000000000000000000000000000000000000000000000000000000000000) // num_acc_limb_bits
                mstore(0x0ec0, 0x0000000000000000000000000000000000000000000000000000000000000001) // g1_x
                mstore(0x0ee0, 0x0000000000000000000000000000000000000000000000000000000000000002) // g1_y
                mstore(0x0f00, 0x198e9393920d483a7260bfb731fb5d25f1aa493335a9e71297e485b7aef312c2) // g2_x_1
                mstore(0x0f20, 0x1800deef121f1e76426a00665e5c4479674322d4f75edadd46debd5cd992f6ed) // g2_x_2
                mstore(0x0f40, 0x090689d0585ff075ec9e99ad690c3395bc4b313370b38ef355acdadcd122975b) // g2_y_1
                mstore(0x0f60, 0x12c85ea5db8c6deb4aab71808dcb408fe3d1e7690c43d37b4ce6cc0166fa7daa) // g2_y_2
                mstore(0x0f80, 0x186282957db913abd99f91db59fe69922e95040603ef44c0bd7aa3adeef8f5ac) // neg_s_g2_x_1
                mstore(0x0fa0, 0x17944351223333f260ddc3b4af45191b856689eda9eab5cbcddbbe570ce860d2) // neg_s_g2_x_2
                mstore(0x0fc0, 0x06d971ff4a7467c3ec596ed6efc674572e32fd6f52b721f97e35b0b3d3546753) // neg_s_g2_y_1
                mstore(0x0fe0, 0x06ecdb9f9567f59ed2eee36e1e1d58797fd13cc97fafc2910f5e8a12f202fa9a) // neg_s_g2_y_2
                mstore(0x1000, 0x1799a85f79e3887a843ab03637e5a972e125beec051d10c2064f85e1994aa572) // fixed_comms[0].x
                mstore(0x1020, 0x0ff3c1043f4148ae101cce719c6962aea8fd67fc1a6f181831115320e23bb1c4) // fixed_comms[0].y
                mstore(0x1040, 0x01eafbac20518985005ba3508e621087eb87f8c697461ab1550823da88347098) // fixed_comms[1].x
                mstore(0x1060, 0x0b0d572c550b2ea33c16c505811fceafc5171f1583557a23b2b4eac913dc77e4) // fixed_comms[1].y
                mstore(0x1080, 0x257f5f1f655618bf30b5e9d8e05ed9347359df6c793697b4c991c2ffd2472297) // fixed_comms[2].x
                mstore(0x10a0, 0x0cc59c672171e16fd70722a0c283535eaae858f0a51d5f7d303d78e2291424de) // fixed_comms[2].y
                mstore(0x10c0, 0x23ef147eb8a2a5c95a9a6672ca42610240d36402e700ecda251b4e3c1367d7f0) // fixed_comms[3].x
                mstore(0x10e0, 0x12bf5874043880dad85025fbfc139cc39a701d3e726272ea101116a003e65a84) // fixed_comms[3].y
                mstore(0x1100, 0x2eb3c57f296350c100d3fd0584fce4eba776d552c77b453cea3f90ebb5a5ccc4) // fixed_comms[4].x
                mstore(0x1120, 0x03c539a4b7dce8c964185b52269f226c0cef95ef45338538553cf2ed6385fa10) // fixed_comms[4].y
                mstore(0x1140, 0x12b7a4770e0b584c5bfecdb7a5f637336119252801014cc80e7961a90a6c23d0) // fixed_comms[5].x
                mstore(0x1160, 0x132783617dac5fca2ebab2094031ec93387c2dc253615ee7d8176697036bc052) // fixed_comms[5].y
                mstore(0x1180, 0x21d99f3cd5e6686d23fd9b85b22ac8e560204a6a718c4de3a0b8133f24d04028) // fixed_comms[6].x
                mstore(0x11a0, 0x2d0ba65d5012ab200cac5cb27d172c4b89fcceb501aef1993616dda9ba18c0ec) // fixed_comms[6].y
                mstore(0x11c0, 0x11d68ca63ce7688cc416aa9c8f062337c8663b1405e22affcabb277f8c4edbc9) // fixed_comms[7].x
                mstore(0x11e0, 0x0abb65e9600c12b57a2f1846c27b2a3e6747a30f31ed5634c2d8071994b98103) // fixed_comms[7].y
                mstore(0x1200, 0x11d68ca63ce7688cc416aa9c8f062337c8663b1405e22affcabb277f8c4edbc9) // fixed_comms[8].x
                mstore(0x1220, 0x0abb65e9600c12b57a2f1846c27b2a3e6747a30f31ed5634c2d8071994b98103) // fixed_comms[8].y
                mstore(0x1240, 0x082ea55ad95431ca108c5620dd1dbae24a1728037641703cb6cae21383189346) // fixed_comms[9].x
                mstore(0x1260, 0x085a3216356f7bfab95b3ba99d654d9211d766e9ec86c423ada2e58a3f4f07b5) // fixed_comms[9].y
                mstore(0x1280, 0x082ea55ad95431ca108c5620dd1dbae24a1728037641703cb6cae21383189346) // fixed_comms[10].x
                mstore(0x12a0, 0x085a3216356f7bfab95b3ba99d654d9211d766e9ec86c423ada2e58a3f4f07b5) // fixed_comms[10].y
                mstore(0x12c0, 0x123db3d8dca3a703e9b58bdf2ca52f848aeec81b944017ad9c5a9b0864f23edd) // fixed_comms[11].x
                mstore(0x12e0, 0x2359901c6c8c2dc71ef165731992e5de7a00be81a4344b464455a4b3353341e8) // fixed_comms[11].y
                mstore(0x1300, 0x290984ae8eab6048c3cbe3c8493bdfa25c4cf530e7e91b3fae8010e8531bbf7a) // fixed_comms[12].x
                mstore(0x1320, 0x22a37b761b5ee385266ce944606c3b2170eb322335e67f80d8d31aee86a9278d) // fixed_comms[12].y
                mstore(0x1340, 0x003cc6f0a0383ce18743b93cd5dd272a8da9b0a491acc490c957710b4c99cc73) // fixed_comms[13].x
                mstore(0x1360, 0x1637d215279045bb61e12a7a1dc7dda6448eb3dd83e2dc9ef9755a25423db79c) // fixed_comms[13].y
                mstore(0x1380, 0x0f7c57aef6f255e905db504b8984131d3a97e9e6fdbf711a6430a75e6c20bfc1) // fixed_comms[14].x
                mstore(0x13a0, 0x25004a796643d841a1fd2e3b48c3f4b037bbb265fe3c7d92be5007e867115349) // fixed_comms[14].y
                mstore(0x13c0, 0x1857bd65cd665d6c2f72a517fde38edcf062dd0ead6f42672faa05eccd004ade) // fixed_comms[15].x
                mstore(0x13e0, 0x152678b2a36b7496acf4f7dcdaff72feba40c2a3d820c9025eade6a40a57c81c) // fixed_comms[15].y
                mstore(0x1400, 0x0000000000000000000000000000000000000000000000000000000000000000) // fixed_comms[16].x
                mstore(0x1420, 0x0000000000000000000000000000000000000000000000000000000000000000) // fixed_comms[16].y
                mstore(0x1440, 0x0000000000000000000000000000000000000000000000000000000000000000) // fixed_comms[17].x
                mstore(0x1460, 0x0000000000000000000000000000000000000000000000000000000000000000) // fixed_comms[17].y
                mstore(0x1480, 0x0000000000000000000000000000000000000000000000000000000000000000) // fixed_comms[18].x
                mstore(0x14a0, 0x0000000000000000000000000000000000000000000000000000000000000000) // fixed_comms[18].y
                mstore(0x14c0, 0x0b4f5846b5c16723e07300b00793fb3abf27ba3def60e8bca845ecd86843f07c) // fixed_comms[19].x
                mstore(0x14e0, 0x2e47d7f1ab0d603409407d940e8da4822048280fe365c4a61963e1dd39f0bd18) // fixed_comms[19].y
                mstore(0x1500, 0x0000000000000000000000000000000000000000000000000000000000000000) // fixed_comms[20].x
                mstore(0x1520, 0x0000000000000000000000000000000000000000000000000000000000000000) // fixed_comms[20].y
                mstore(0x1540, 0x118b7760293ffec1e66bdba2ec2eb7107454977b5ebb93e39e703267029014ef) // fixed_comms[21].x
                mstore(0x1560, 0x1436a9114bc23707ffa243ddf50c57ceb92b276ac534c07f7972f9ff28587650) // fixed_comms[21].y
                mstore(0x1580, 0x061468160a85877c044e7234ac76f90c34769870410150faf7357d77cbb050ab) // fixed_comms[22].x
                mstore(0x15a0, 0x09500e748de698f1a57cbba60783ad6d6526656fad42e9772b2584bf76e5758a) // fixed_comms[22].y
                mstore(0x15c0, 0x205c3404b65c66a52defe0fc3c815c226f9ba7869555006037cdd8f5304fef1a) // fixed_comms[23].x
                mstore(0x15e0, 0x12b2f5ecba15c1352494a4223d5bb02da63592ca6614318eac9bc2b71e37a7d4) // fixed_comms[23].y
                mstore(0x1600, 0x107a5818f0940c974c38f6f63448994d63161d6ba44d3c9d20d91a98b88799e6) // permutation_comms[0].x
                mstore(0x1620, 0x1b3b0b87bc85d4bc9340b48d2d5ffd0c864cf569dcf48e7794bcdc671a7342bd) // permutation_comms[0].y
                mstore(0x1640, 0x2d54a02db5d5033b35722e02f824b6ddee5ab59b567fd39ad5c557f1756af7ca) // permutation_comms[1].x
                mstore(0x1660, 0x2f963ebc9f8fc3501d1d527fb05f8fd960ee404cdb8f5695bd56a6cf6a056c48) // permutation_comms[1].y
                mstore(0x1680, 0x2eae6a3bc93dde39eac2b1b576b0f58bae76ceb1b1896a053ad6a3e5b8d70d61) // permutation_comms[2].x
                mstore(0x16a0, 0x0c3dd28cc7d7881b10335cd9b2045b809b846ab61f44dd09d7a918672f6d3853) // permutation_comms[2].y
                mstore(0x16c0, 0x2c61f4b8684ed581b8e6e4966bfa04e11f9917ce932bd43b0b70ddf932d5ed96) // permutation_comms[3].x
                mstore(0x16e0, 0x13c6c1db874233ca0da7970b29f3dbdcc2c8c64e11c8e206f6ea0d0749effd82) // permutation_comms[3].y
                mstore(0x1700, 0x09b6b30b07f16f77c8894995c3acfa6e39e1e83a829b9cbfd04131f2e98a08a8) // permutation_comms[4].x
                mstore(0x1720, 0x00ac40975db6258496385217852fb991f150229059963effaf1e4df9b460280d) // permutation_comms[4].y
                mstore(0x1740, 0x168367568575f57064d20d9db5d3d069fa46e32405938945de60cd0abd8c0476) // permutation_comms[5].x
                mstore(0x1760, 0x027c02e11cb1373cf35556adc934d41dd7abc13244884c764a3abacb0d0b2f8a) // permutation_comms[5].y
                mstore(0x1780, 0x2d6682e3f954c76eb68f7c2c638b93a004acb4aba03c72f482f9621a82b55f33) // permutation_comms[6].x
                mstore(0x17a0, 0x1395337d19d12051bf7add12ab783cdfc417961500797da5e37e05bb59a43fb1) // permutation_comms[6].y
                mstore(0x17c0, 0x02c7264e880ba94b1f66c5b618710fcb6a430feb979ace1d0d7fca855a3709a7) // permutation_comms[7].x
                mstore(0x17e0, 0x0b936a8c8a6469c97bd2d6774d189dc9828a28a70eaf4550c4882d2378067b6d) // permutation_comms[7].y
                mstore(0x1800, 0x1a0cb732682ad52cd4ecaca0e33a66446f42f7a03de95ddb044c21888f2857b2) // permutation_comms[8].x
                mstore(0x1820, 0x0c6c66be53764fb8f9f135a3ab95df6f8e55d03b66fc94b5731d6f2ae45d6ef9) // permutation_comms[8].y
                mstore(0x1840, 0x0e0127f2a80984410031efe8d3a97441e66c6cecdd0ece5dfabecb1909ed7644) // permutation_comms[9].x
                mstore(0x1860, 0x10cd8501260da6a954bf9f7053b1b70a25319e5634ebc266cc57b696332e2216) // permutation_comms[9].y
                mstore(0x1880, 0x2bb2e1220de67403a7cac165dd0a02b65daced3ea54a30d57f86bf7249a870bc) // permutation_comms[10].x
                mstore(0x18a0, 0x19543ffd545357fc787467ab3e745aefdab70f4056441549a126d8ca09d0a75b) // permutation_comms[10].y
                mstore(0x18c0, 0x2672fe2fb229e1428e2b5c03ba0745559c4d37dc4cd6f768961ac36fc94cc075) // permutation_comms[11].x
                mstore(0x18e0, 0x134a8d16b50dc91421b215c781422cda49ef84b287f0e2deaf8ded1cb621194c) // permutation_comms[11].y
                mstore(0x1900, 0x2cbd213fde53dc483dfe697f2f1ab9da9368fcb6f66fc021a83a97180786c9a2) // permutation_comms[12].x
                mstore(0x1920, 0x272387c0d022fc4552e8d5effb8c93f8ad28df3cc7f1d81978e7243f55a5b843) // permutation_comms[12].y
                mstore(0x1940, 0x0cf29426d843f06611675a1e7878894ce06d021efa2571d460d8257f5455729c) // permutation_comms[13].x
                mstore(0x1960, 0x263136af7990fe37ac50da116a9feaf8df2dc9818ffa503491ea2e1d99516571) // permutation_comms[13].y
                mstore(0x1980, 0x22e8fc6a727747341acc072240360206b3dd3abad75763b9e49ee7f727f7a8da) // permutation_comms[14].x
                mstore(0x19a0, 0x123d8ce039bf98bc3655306b41556d3de852805b4122faba82550d33c27adf58) // permutation_comms[14].y
                mstore(0x19c0, 0x2e56e6441492153c7f30177a2825000cd5597b8cb6940c771cf4f534b54ff731) // permutation_comms[15].x
                mstore(0x19e0, 0x0a12443998c00bdd0a1379b5673d710910aaed1dba0a0208d0d74d59d30f8b16) // permutation_comms[15].y
                mstore(0x1a00, 0x228b294d0ca4a86e1798e514b119aaa8beb29e411e60c42f394da91ecf09b4d5) // permutation_comms[16].x
                mstore(0x1a20, 0x2edca203b1cc39dee977e4e305abffaf165baf5af46ce9368bb376d6b1f6a904) // permutation_comms[16].y
                mstore(0x1a40, 0x0bc508d412968e7cfb9f147bd24743e81262b4ff062851219e9a1f2fca5d844d) // permutation_comms[17].x
                mstore(0x1a60, 0x2b5e0cfab1878a81732f1e6a9ae452958d5295a3cb8585a5ba768cebbad40e4c) // permutation_comms[17].y
                mstore(0x1a80, 0x0b1c1af287466eae6d52efdd83c18b4af08a90225afc8dfd54abfe5ce7f24b4e) // permutation_comms[18].x
                mstore(0x1aa0, 0x2ad41d1a9e359b81e833ee07fea52ced3abd3fefd76b3119a488f23197196793) // permutation_comms[18].y
                mstore(0x1ac0, 0x193904f05d09aa21c9ab153f81083fef71bb4275c4fac75c1e9b03bd5eaa446c) // permutation_comms[19].x
                mstore(0x1ae0, 0x2144928a65aafc59f0f02ba048813a9d08b4ab4d27bedd31b78b61195b3c0508) // permutation_comms[19].y
                mstore(0x1b00, 0x29572efc26229578feca0c110610f8c23ca1490d167a1597ed76a0f0d62ea79e) // permutation_comms[20].x
                mstore(0x1b20, 0x1313d0be6349baa501b8cf8d6d2724c599403dcef176953d1b85a09a2dd441ef) // permutation_comms[20].y
                mstore(0x1b40, 0x1ac55474b280a299c2b111af5d0ecd5300c6a07689e824f6b86d7d3063b04ed5) // permutation_comms[21].x
                mstore(0x1b60, 0x124a18d391a224ec8155b16c354b335636e530aa38c141cf48307d1688008773) // permutation_comms[21].y
                mstore(0x1b80, 0x229394857df9e23c5635cc3d372b99e957870f8eb580bdac3448fe0f47cde447) // permutation_comms[22].x
                mstore(0x1ba0, 0x201b292e2f035eea91cf476ea710885eb201119a96a20b4e73cfecff8fa6e1d5) // permutation_comms[22].y
                mstore(0x1bc0, 0x2b2217bf28a17142c80bc82501bbd297926fba0a204a325cebd436ca0ad93bb0) // permutation_comms[23].x
                mstore(0x1be0, 0x05a8ec789bf40b51fdf8ad06b2052d31742b57956c636d0ad8862b0eeeccb513) // permutation_comms[23].y

                // Read accumulator from instances
                if mload(HAS_ACCUMULATOR_MPTR) {
                    let num_limbs := mload(NUM_ACC_LIMBS_MPTR)
                    let num_limb_bits := mload(NUM_ACC_LIMB_BITS_MPTR)

                    let cptr := add(instances.offset, mul(mload(ACC_OFFSET_MPTR), 0x20))
                    let lhs_y_off := mul(num_limbs, 0x20)
                    let rhs_x_off := mul(lhs_y_off, 2)
                    let rhs_y_off := mul(lhs_y_off, 3)
                    let lhs_x := calldataload(cptr)
                    let lhs_y := calldataload(add(cptr, lhs_y_off))
                    let rhs_x := calldataload(add(cptr, rhs_x_off))
                    let rhs_y := calldataload(add(cptr, rhs_y_off))
                    for
                        {
                            let cptr_end := add(cptr, mul(0x20, num_limbs))
                            let shift := num_limb_bits
                        }
                        lt(cptr, cptr_end)
                        {}
                    {
                        cptr := add(cptr, 0x20)
                        lhs_x := add(lhs_x, shl(shift, calldataload(cptr)))
                        lhs_y := add(lhs_y, shl(shift, calldataload(add(cptr, lhs_y_off))))
                        rhs_x := add(rhs_x, shl(shift, calldataload(add(cptr, rhs_x_off))))
                        rhs_y := add(rhs_y, shl(shift, calldataload(add(cptr, rhs_y_off))))
                        shift := add(shift, num_limb_bits)
                    }

                    success := and(success, eq(mulmod(lhs_y, lhs_y, q), addmod(mulmod(lhs_x, mulmod(lhs_x, lhs_x, q), q), 3, q)))
                    success := and(success, eq(mulmod(rhs_y, rhs_y, q), addmod(mulmod(rhs_x, mulmod(rhs_x, rhs_x, q), q), 3, q)))

                    mstore(ACC_LHS_X_MPTR, lhs_x)
                    mstore(ACC_LHS_Y_MPTR, lhs_y)
                    mstore(ACC_RHS_X_MPTR, rhs_x)
                    mstore(ACC_RHS_Y_MPTR, rhs_y)
                }

                pop(q)
            }

            // Revert earlier if anything from calldata is invalid
            if iszero(success) {
                revert(0, 0)
            }

            // Compute lagrange evaluations and instance evaluation
            {
                let k := mload(K_MPTR)
                let x := mload(X_MPTR)
                let x_n := x
                for
                    { let idx := 0 }
                    lt(idx, k)
                    { idx := add(idx, 1) }
                {
                    x_n := mulmod(x_n, x_n, r)
                }

                let omega := mload(OMEGA_MPTR)

                let mptr := X_N_MPTR
                let mptr_end := add(mptr, mul(0x20, add(mload(NUM_INSTANCES_MPTR), 6)))
                if iszero(mload(NUM_INSTANCES_MPTR)) {
                    mptr_end := add(mptr_end, 0x20)
                }
                for
                    { let pow_of_omega := mload(OMEGA_INV_TO_L_MPTR) }
                    lt(mptr, mptr_end)
                    { mptr := add(mptr, 0x20) }
                {
                    mstore(mptr, addmod(x, sub(r, pow_of_omega), r))
                    pow_of_omega := mulmod(pow_of_omega, omega, r)
                }
                let x_n_minus_1 := addmod(x_n, sub(r, 1), r)
                mstore(mptr_end, x_n_minus_1)
                success := batch_invert(success, X_N_MPTR, add(mptr_end, 0x20))

                mptr := X_N_MPTR
                let l_i_common := mulmod(x_n_minus_1, mload(N_INV_MPTR), r)
                for
                    { let pow_of_omega := mload(OMEGA_INV_TO_L_MPTR) }
                    lt(mptr, mptr_end)
                    { mptr := add(mptr, 0x20) }
                {
                    mstore(mptr, mulmod(l_i_common, mulmod(mload(mptr), pow_of_omega, r), r))
                    pow_of_omega := mulmod(pow_of_omega, omega, r)
                }

                let l_blind := mload(add(X_N_MPTR, 0x20))
                let l_i_cptr := add(X_N_MPTR, 0x40)
                for
                    { let l_i_cptr_end := add(X_N_MPTR, 0xc0) }
                    lt(l_i_cptr, l_i_cptr_end)
                    { l_i_cptr := add(l_i_cptr, 0x20) }
                {
                    l_blind := addmod(l_blind, mload(l_i_cptr), r)
                }

                let instance_eval := 0
                for
                    {
                        let instance_cptr := instances.offset
                        let instance_cptr_end := add(instance_cptr, mul(0x20, mload(NUM_INSTANCES_MPTR)))
                    }
                    lt(instance_cptr, instance_cptr_end)
                    {
                        instance_cptr := add(instance_cptr, 0x20)
                        l_i_cptr := add(l_i_cptr, 0x20)
                    }
                {
                    instance_eval := addmod(instance_eval, mulmod(mload(l_i_cptr), calldataload(instance_cptr), r), r)
                }

                let x_n_minus_1_inv := mload(mptr_end)
                let l_last := mload(X_N_MPTR)
                let l_0 := mload(add(X_N_MPTR, 0xc0))

                mstore(X_N_MPTR, x_n)
                mstore(X_N_MINUS_1_INV_MPTR, x_n_minus_1_inv)
                mstore(L_LAST_MPTR, l_last)
                mstore(L_BLIND_MPTR, l_blind)
                mstore(L_0_MPTR, l_0)
                mstore(INSTANCE_EVAL_MPTR, instance_eval)
            }

            // Compute quotient evavluation
            {
                let quotient_eval_numer
                let y := mload(Y_MPTR)
                {
                    let f_11 := calldataload(0x0f84)
                    let a_6 := calldataload(0x0b64)
                    let f_1 := calldataload(0x0e84)
                    let var0 := addmod(a_6, f_1, R)
                    let var1 := mulmod(var0, var0, R)
                    let var2 := mulmod(var1, var1, R)
                    let var3 := mulmod(var2, var0, R)
                    let var4 := mulmod(var3, 0x66f6f85d6f68a85ec10345351a23a3aaf07f38af8c952a7bceca70bd2af7ad5, R)
                    let a_7 := calldataload(0x0b84)
                    let f_2 := calldataload(0x0ea4)
                    let var5 := addmod(a_7, f_2, R)
                    let var6 := mulmod(var5, var5, R)
                    let var7 := mulmod(var6, var6, R)
                    let var8 := mulmod(var7, var5, R)
                    let var9 := mulmod(var8, 0x2b9d4b4110c9ae997782e1509b1d0fdb20a7c02bbd8bea7305462b9f8125b1e8, R)
                    let var10 := addmod(var4, var9, R)
                    let a_6_next_1 := calldataload(0x0ba4)
                    let var11 := sub(R, a_6_next_1)
                    let var12 := addmod(var10, var11, R)
                    let var13 := mulmod(f_11, var12, R)
                    quotient_eval_numer := var13
                }
                {
                    let f_11 := calldataload(0x0f84)
                    let a_6 := calldataload(0x0b64)
                    let f_1 := calldataload(0x0e84)
                    let var0 := addmod(a_6, f_1, R)
                    let var1 := mulmod(var0, var0, R)
                    let var2 := mulmod(var1, var1, R)
                    let var3 := mulmod(var2, var0, R)
                    let var4 := mulmod(var3, 0xcc57cdbb08507d62bf67a4493cc262fb6c09d557013fff1f573f431221f8ff9, R)
                    let a_7 := calldataload(0x0b84)
                    let f_2 := calldataload(0x0ea4)
                    let var5 := addmod(a_7, f_2, R)
                    let var6 := mulmod(var5, var5, R)
                    let var7 := mulmod(var6, var6, R)
                    let var8 := mulmod(var7, var5, R)
                    let var9 := mulmod(var8, 0x1274e649a32ed355a31a6ed69724e1adade857e86eb5c3a121bcd147943203c8, R)
                    let var10 := addmod(var4, var9, R)
                    let a_7_next_1 := calldataload(0x0bc4)
                    let var11 := sub(R, a_7_next_1)
                    let var12 := addmod(var10, var11, R)
                    let var13 := mulmod(f_11, var12, R)
                    quotient_eval_numer := addmod(mulmod(quotient_eval_numer, y, r), var13, r)
                }
                {
                    let f_12 := calldataload(0x0fa4)
                    let a_6 := calldataload(0x0b64)
                    let f_1 := calldataload(0x0e84)
                    let var0 := addmod(a_6, f_1, R)
                    let var1 := mulmod(var0, var0, R)
                    let var2 := mulmod(var1, var1, R)
                    let var3 := mulmod(var2, var0, R)
                    let a_8 := calldataload(0x0be4)
                    let var4 := sub(R, a_8)
                    let var5 := addmod(var3, var4, R)
                    let var6 := mulmod(f_12, var5, R)
                    quotient_eval_numer := addmod(mulmod(quotient_eval_numer, y, r), var6, r)
                }
                {
                    let f_12 := calldataload(0x0fa4)
                    let a_8 := calldataload(0x0be4)
                    let var0 := mulmod(a_8, 0x66f6f85d6f68a85ec10345351a23a3aaf07f38af8c952a7bceca70bd2af7ad5, R)
                    let a_7 := calldataload(0x0b84)
                    let f_2 := calldataload(0x0ea4)
                    let var1 := addmod(a_7, f_2, R)
                    let var2 := mulmod(var1, 0x2b9d4b4110c9ae997782e1509b1d0fdb20a7c02bbd8bea7305462b9f8125b1e8, R)
                    let var3 := addmod(var0, var2, R)
                    let f_3 := calldataload(0x0e44)
                    let var4 := addmod(var3, f_3, R)
                    let var5 := mulmod(var4, var4, R)
                    let var6 := mulmod(var5, var5, R)
                    let var7 := mulmod(var6, var4, R)
                    let a_6_next_1 := calldataload(0x0ba4)
                    let var8 := mulmod(a_6_next_1, 0x13abec390ada7f4370819ab1c7846f210554569d9b29d1ea8dbebd0fa8c53e66, R)
                    let a_7_next_1 := calldataload(0x0bc4)
                    let var9 := mulmod(a_7_next_1, 0x1eb9e1dc19a33a624c9862a1d97d1510bd521ead5dfe0345aaf6185b1a1e60fe, R)
                    let var10 := addmod(var8, var9, R)
                    let var11 := sub(R, var10)
                    let var12 := addmod(var7, var11, R)
                    let var13 := mulmod(f_12, var12, R)
                    quotient_eval_numer := addmod(mulmod(quotient_eval_numer, y, r), var13, r)
                }
                {
                    let f_12 := calldataload(0x0fa4)
                    let a_8 := calldataload(0x0be4)
                    let var0 := mulmod(a_8, 0xcc57cdbb08507d62bf67a4493cc262fb6c09d557013fff1f573f431221f8ff9, R)
                    let a_7 := calldataload(0x0b84)
                    let f_2 := calldataload(0x0ea4)
                    let var1 := addmod(a_7, f_2, R)
                    let var2 := mulmod(var1, 0x1274e649a32ed355a31a6ed69724e1adade857e86eb5c3a121bcd147943203c8, R)
                    let var3 := addmod(var0, var2, R)
                    let f_4 := calldataload(0x0e64)
                    let var4 := addmod(var3, f_4, R)
                    let a_6_next_1 := calldataload(0x0ba4)
                    let var5 := mulmod(a_6_next_1, 0xfc1c9394db89bb2601abc49fdad4f038ce5169030a2ad69763f7875036bcb02, R)
                    let a_7_next_1 := calldataload(0x0bc4)
                    let var6 := mulmod(a_7_next_1, 0x16a9e98c493a902b9502054edc03e7b22b7eac34345961bc8abced6bd147c8be, R)
                    let var7 := addmod(var5, var6, R)
                    let var8 := sub(R, var7)
                    let var9 := addmod(var4, var8, R)
                    let var10 := mulmod(f_12, var9, R)
                    quotient_eval_numer := addmod(mulmod(quotient_eval_numer, y, r), var10, r)
                }
                {
                    let f_13 := calldataload(0x0fc4)
                    let var0 := 0x2
                    let var1 := sub(R, f_13)
                    let var2 := addmod(var0, var1, R)
                    let var3 := mulmod(f_13, var2, R)
                    let var4 := 0x3
                    let var5 := addmod(var4, var1, R)
                    let var6 := mulmod(var3, var5, R)
                    let a_6_prev_1 := calldataload(0x0c24)
                    let a_6 := calldataload(0x0b64)
                    let var7 := addmod(a_6_prev_1, a_6, R)
                    let a_6_next_1 := calldataload(0x0ba4)
                    let var8 := sub(R, a_6_next_1)
                    let var9 := addmod(var7, var8, R)
                    let var10 := mulmod(var6, var9, R)
                    quotient_eval_numer := addmod(mulmod(quotient_eval_numer, y, r), var10, r)
                }
                {
                    let f_13 := calldataload(0x0fc4)
                    let var0 := 0x2
                    let var1 := sub(R, f_13)
                    let var2 := addmod(var0, var1, R)
                    let var3 := mulmod(f_13, var2, R)
                    let var4 := 0x3
                    let var5 := addmod(var4, var1, R)
                    let var6 := mulmod(var3, var5, R)
                    let a_7_prev_1 := calldataload(0x0c04)
                    let a_7_next_1 := calldataload(0x0bc4)
                    let var7 := sub(R, a_7_next_1)
                    let var8 := addmod(a_7_prev_1, var7, R)
                    let var9 := mulmod(var6, var8, R)
                    quotient_eval_numer := addmod(mulmod(quotient_eval_numer, y, r), var9, r)
                }
                {
                    let f_14 := calldataload(0x0fe4)
                    let var0 := 0x2
                    let var1 := sub(R, f_14)
                    let var2 := addmod(var0, var1, R)
                    let var3 := mulmod(f_14, var2, R)
                    let var4 := 0x3
                    let var5 := addmod(var4, var1, R)
                    let var6 := mulmod(var3, var5, R)
                    let var7 := 0x4
                    let var8 := addmod(var7, var1, R)
                    let var9 := mulmod(var6, var8, R)
                    let a_4 := calldataload(0x0b24)
                    let a_0 := calldataload(0x0aa4)
                    let a_2 := calldataload(0x0ae4)
                    let var10 := addmod(a_0, a_2, R)
                    let var11 := sub(R, var10)
                    let var12 := addmod(a_4, var11, R)
                    let var13 := mulmod(var9, var12, R)
                    quotient_eval_numer := addmod(mulmod(quotient_eval_numer, y, r), var13, r)
                }
                {
                    let f_15 := calldataload(0x1004)
                    let var0 := 0x2
                    let var1 := sub(R, f_15)
                    let var2 := addmod(var0, var1, R)
                    let var3 := mulmod(f_15, var2, R)
                    let var4 := 0x3
                    let var5 := addmod(var4, var1, R)
                    let var6 := mulmod(var3, var5, R)
                    let var7 := 0x4
                    let var8 := addmod(var7, var1, R)
                    let var9 := mulmod(var6, var8, R)
                    let a_5 := calldataload(0x0b44)
                    let a_1 := calldataload(0x0ac4)
                    let a_3 := calldataload(0x0b04)
                    let var10 := addmod(a_1, a_3, R)
                    let var11 := sub(R, var10)
                    let var12 := addmod(a_5, var11, R)
                    let var13 := mulmod(var9, var12, R)
                    quotient_eval_numer := addmod(mulmod(quotient_eval_numer, y, r), var13, r)
                }
                {
                    let f_14 := calldataload(0x0fe4)
                    let var0 := 0x1
                    let var1 := sub(R, f_14)
                    let var2 := addmod(var0, var1, R)
                    let var3 := mulmod(f_14, var2, R)
                    let var4 := 0x2
                    let var5 := addmod(var4, var1, R)
                    let var6 := mulmod(var3, var5, R)
                    let var7 := 0x4
                    let var8 := addmod(var7, var1, R)
                    let var9 := mulmod(var6, var8, R)
                    let a_4 := calldataload(0x0b24)
                    let a_0 := calldataload(0x0aa4)
                    let a_2 := calldataload(0x0ae4)
                    let var10 := mulmod(a_0, a_2, R)
                    let var11 := sub(R, var10)
                    let var12 := addmod(a_4, var11, R)
                    let var13 := mulmod(var9, var12, R)
                    quotient_eval_numer := addmod(mulmod(quotient_eval_numer, y, r), var13, r)
                }
                {
                    let f_15 := calldataload(0x1004)
                    let var0 := 0x1
                    let var1 := sub(R, f_15)
                    let var2 := addmod(var0, var1, R)
                    let var3 := mulmod(f_15, var2, R)
                    let var4 := 0x2
                    let var5 := addmod(var4, var1, R)
                    let var6 := mulmod(var3, var5, R)
                    let var7 := 0x4
                    let var8 := addmod(var7, var1, R)
                    let var9 := mulmod(var6, var8, R)
                    let a_5 := calldataload(0x0b44)
                    let a_1 := calldataload(0x0ac4)
                    let a_3 := calldataload(0x0b04)
                    let var10 := mulmod(a_1, a_3, R)
                    let var11 := sub(R, var10)
                    let var12 := addmod(a_5, var11, R)
                    let var13 := mulmod(var9, var12, R)
                    quotient_eval_numer := addmod(mulmod(quotient_eval_numer, y, r), var13, r)
                }
                {
                    let f_14 := calldataload(0x0fe4)
                    let var0 := 0x1
                    let var1 := sub(R, f_14)
                    let var2 := addmod(var0, var1, R)
                    let var3 := mulmod(f_14, var2, R)
                    let var4 := 0x3
                    let var5 := addmod(var4, var1, R)
                    let var6 := mulmod(var3, var5, R)
                    let var7 := 0x4
                    let var8 := addmod(var7, var1, R)
                    let var9 := mulmod(var6, var8, R)
                    let a_4 := calldataload(0x0b24)
                    let a_0 := calldataload(0x0aa4)
                    let a_2 := calldataload(0x0ae4)
                    let var10 := sub(R, a_2)
                    let var11 := addmod(a_0, var10, R)
                    let var12 := sub(R, var11)
                    let var13 := addmod(a_4, var12, R)
                    let var14 := mulmod(var9, var13, R)
                    quotient_eval_numer := addmod(mulmod(quotient_eval_numer, y, r), var14, r)
                }
                {
                    let f_15 := calldataload(0x1004)
                    let var0 := 0x1
                    let var1 := sub(R, f_15)
                    let var2 := addmod(var0, var1, R)
                    let var3 := mulmod(f_15, var2, R)
                    let var4 := 0x3
                    let var5 := addmod(var4, var1, R)
                    let var6 := mulmod(var3, var5, R)
                    let var7 := 0x4
                    let var8 := addmod(var7, var1, R)
                    let var9 := mulmod(var6, var8, R)
                    let a_5 := calldataload(0x0b44)
                    let a_1 := calldataload(0x0ac4)
                    let a_3 := calldataload(0x0b04)
                    let var10 := sub(R, a_3)
                    let var11 := addmod(a_1, var10, R)
                    let var12 := sub(R, var11)
                    let var13 := addmod(a_5, var12, R)
                    let var14 := mulmod(var9, var13, R)
                    quotient_eval_numer := addmod(mulmod(quotient_eval_numer, y, r), var14, r)
                }
                {
                    let f_13 := calldataload(0x0fc4)
                    let var0 := 0x1
                    let var1 := sub(R, f_13)
                    let var2 := addmod(var0, var1, R)
                    let var3 := mulmod(f_13, var2, R)
                    let var4 := 0x3
                    let var5 := addmod(var4, var1, R)
                    let var6 := mulmod(var3, var5, R)
                    let a_4 := calldataload(0x0b24)
                    let a_4_prev_1 := calldataload(0x0c44)
                    let var7 := 0x0
                    let a_0 := calldataload(0x0aa4)
                    let a_2 := calldataload(0x0ae4)
                    let var8 := mulmod(a_0, a_2, R)
                    let var9 := addmod(var7, var8, R)
                    let a_1 := calldataload(0x0ac4)
                    let a_3 := calldataload(0x0b04)
                    let var10 := mulmod(a_1, a_3, R)
                    let var11 := addmod(var9, var10, R)
                    let var12 := addmod(a_4_prev_1, var11, R)
                    let var13 := sub(R, var12)
                    let var14 := addmod(a_4, var13, R)
                    let var15 := mulmod(var6, var14, R)
                    quotient_eval_numer := addmod(mulmod(quotient_eval_numer, y, r), var15, r)
                }
                {
                    let f_14 := calldataload(0x0fe4)
                    let var0 := 0x1
                    let var1 := sub(R, f_14)
                    let var2 := addmod(var0, var1, R)
                    let var3 := mulmod(f_14, var2, R)
                    let var4 := 0x2
                    let var5 := addmod(var4, var1, R)
                    let var6 := mulmod(var3, var5, R)
                    let var7 := 0x3
                    let var8 := addmod(var7, var1, R)
                    let var9 := mulmod(var6, var8, R)
                    let a_4 := calldataload(0x0b24)
                    let var10 := 0x0
                    let a_0 := calldataload(0x0aa4)
                    let a_2 := calldataload(0x0ae4)
                    let var11 := mulmod(a_0, a_2, R)
                    let var12 := addmod(var10, var11, R)
                    let a_1 := calldataload(0x0ac4)
                    let a_3 := calldataload(0x0b04)
                    let var13 := mulmod(a_1, a_3, R)
                    let var14 := addmod(var12, var13, R)
                    let var15 := sub(R, var14)
                    let var16 := addmod(a_4, var15, R)
                    let var17 := mulmod(var9, var16, R)
                    quotient_eval_numer := addmod(mulmod(quotient_eval_numer, y, r), var17, r)
                }
                {
                    let f_15 := calldataload(0x1004)
                    let var0 := 0x1
                    let var1 := sub(R, f_15)
                    let var2 := addmod(var0, var1, R)
                    let var3 := mulmod(f_15, var2, R)
                    let var4 := 0x2
                    let var5 := addmod(var4, var1, R)
                    let var6 := mulmod(var3, var5, R)
                    let var7 := 0x3
                    let var8 := addmod(var7, var1, R)
                    let var9 := mulmod(var6, var8, R)
                    let a_4 := calldataload(0x0b24)
                    let a_2 := calldataload(0x0ae4)
                    let var10 := mulmod(var0, a_2, R)
                    let a_3 := calldataload(0x0b04)
                    let var11 := mulmod(var10, a_3, R)
                    let var12 := sub(R, var11)
                    let var13 := addmod(a_4, var12, R)
                    let var14 := mulmod(var9, var13, R)
                    quotient_eval_numer := addmod(mulmod(quotient_eval_numer, y, r), var14, r)
                }
                {
                    let f_13 := calldataload(0x0fc4)
                    let var0 := 0x1
                    let var1 := sub(R, f_13)
                    let var2 := addmod(var0, var1, R)
                    let var3 := mulmod(f_13, var2, R)
                    let var4 := 0x2
                    let var5 := addmod(var4, var1, R)
                    let var6 := mulmod(var3, var5, R)
                    let a_4 := calldataload(0x0b24)
                    let a_4_prev_1 := calldataload(0x0c44)
                    let a_2 := calldataload(0x0ae4)
                    let var7 := mulmod(var0, a_2, R)
                    let a_3 := calldataload(0x0b04)
                    let var8 := mulmod(var7, a_3, R)
                    let var9 := mulmod(a_4_prev_1, var8, R)
                    let var10 := sub(R, var9)
                    let var11 := addmod(a_4, var10, R)
                    let var12 := mulmod(var6, var11, R)
                    quotient_eval_numer := addmod(mulmod(quotient_eval_numer, y, r), var12, r)
                }
                {
                    let f_16 := calldataload(0x1024)
                    let var0 := 0x1
                    let var1 := sub(R, f_16)
                    let var2 := addmod(var0, var1, R)
                    let var3 := mulmod(f_16, var2, R)
                    let var4 := 0x3
                    let var5 := addmod(var4, var1, R)
                    let var6 := mulmod(var3, var5, R)
                    let var7 := 0x4
                    let var8 := addmod(var7, var1, R)
                    let var9 := mulmod(var6, var8, R)
                    let a_4 := calldataload(0x0b24)
                    let var10 := 0x0
                    let a_2 := calldataload(0x0ae4)
                    let var11 := addmod(var10, a_2, R)
                    let a_3 := calldataload(0x0b04)
                    let var12 := addmod(var11, a_3, R)
                    let var13 := sub(R, var12)
                    let var14 := addmod(a_4, var13, R)
                    let var15 := mulmod(var9, var14, R)
                    quotient_eval_numer := addmod(mulmod(quotient_eval_numer, y, r), var15, r)
                }
                {
                    let f_16 := calldataload(0x1024)
                    let var0 := 0x2
                    let var1 := sub(R, f_16)
                    let var2 := addmod(var0, var1, R)
                    let var3 := mulmod(f_16, var2, R)
                    let var4 := 0x3
                    let var5 := addmod(var4, var1, R)
                    let var6 := mulmod(var3, var5, R)
                    let var7 := 0x4
                    let var8 := addmod(var7, var1, R)
                    let var9 := mulmod(var6, var8, R)
                    let a_4 := calldataload(0x0b24)
                    let a_4_prev_1 := calldataload(0x0c44)
                    let var10 := 0x0
                    let a_2 := calldataload(0x0ae4)
                    let var11 := addmod(var10, a_2, R)
                    let a_3 := calldataload(0x0b04)
                    let var12 := addmod(var11, a_3, R)
                    let var13 := addmod(a_4_prev_1, var12, R)
                    let var14 := sub(R, var13)
                    let var15 := addmod(a_4, var14, R)
                    let var16 := mulmod(var9, var15, R)
                    quotient_eval_numer := addmod(mulmod(quotient_eval_numer, y, r), var16, r)
                }
                {
                    let f_7 := calldataload(0x0f04)
                    let var0 := 0x0
                    let var1 := mulmod(f_7, var0, R)
                    quotient_eval_numer := addmod(mulmod(quotient_eval_numer, y, r), var1, r)
                }
                {
                    let f_8 := calldataload(0x0f24)
                    let var0 := 0x0
                    let var1 := mulmod(f_8, var0, R)
                    quotient_eval_numer := addmod(mulmod(quotient_eval_numer, y, r), var1, r)
                }
                {
                    let f_9 := calldataload(0x0f44)
                    let var0 := 0x0
                    let var1 := mulmod(f_9, var0, R)
                    quotient_eval_numer := addmod(mulmod(quotient_eval_numer, y, r), var1, r)
                }
                {
                    let f_10 := calldataload(0x0f64)
                    let var0 := 0x0
                    let var1 := mulmod(f_10, var0, R)
                    quotient_eval_numer := addmod(mulmod(quotient_eval_numer, y, r), var1, r)
                }
                {
                    let f_17 := calldataload(0x1044)
                    let var0 := 0x1
                    let var1 := sub(R, f_17)
                    let var2 := addmod(var0, var1, R)
                    let var3 := mulmod(f_17, var2, R)
                    let var4 := 0x3
                    let var5 := addmod(var4, var1, R)
                    let var6 := mulmod(var3, var5, R)
                    let var7 := 0x4
                    let var8 := addmod(var7, var1, R)
                    let var9 := mulmod(var6, var8, R)
                    let a_17 := calldataload(0x0d64)
                    let a_17_prev_1 := calldataload(0x0de4)
                    let var10 := 0x0
                    let a_11 := calldataload(0x0ca4)
                    let a_9 := calldataload(0x0c64)
                    let var11 := mulmod(a_11, a_9, R)
                    let var12 := addmod(var10, var11, R)
                    let a_12 := calldataload(0x0cc4)
                    let a_10 := calldataload(0x0c84)
                    let var13 := mulmod(a_12, a_10, R)
                    let var14 := addmod(var12, var13, R)
                    let var15 := addmod(a_17_prev_1, var14, R)
                    let var16 := sub(R, var15)
                    let var17 := addmod(a_17, var16, R)
                    let var18 := mulmod(var9, var17, R)
                    quotient_eval_numer := addmod(mulmod(quotient_eval_numer, y, r), var18, r)
                }
                {
                    let f_18 := calldataload(0x1064)
                    let var0 := 0x1
                    let var1 := sub(R, f_18)
                    let var2 := addmod(var0, var1, R)
                    let var3 := mulmod(f_18, var2, R)
                    let var4 := 0x3
                    let var5 := addmod(var4, var1, R)
                    let var6 := mulmod(var3, var5, R)
                    let var7 := 0x4
                    let var8 := addmod(var7, var1, R)
                    let var9 := mulmod(var6, var8, R)
                    let a_19 := calldataload(0x0da4)
                    let a_19_prev_1 := calldataload(0x0e04)
                    let var10 := 0x0
                    let a_13 := calldataload(0x0ce4)
                    let a_9 := calldataload(0x0c64)
                    let var11 := mulmod(a_13, a_9, R)
                    let var12 := addmod(var10, var11, R)
                    let a_14 := calldataload(0x0d04)
                    let a_10 := calldataload(0x0c84)
                    let var13 := mulmod(a_14, a_10, R)
                    let var14 := addmod(var12, var13, R)
                    let var15 := addmod(a_19_prev_1, var14, R)
                    let var16 := sub(R, var15)
                    let var17 := addmod(a_19, var16, R)
                    let var18 := mulmod(var9, var17, R)
                    quotient_eval_numer := addmod(mulmod(quotient_eval_numer, y, r), var18, r)
                }
                {
                    let f_19 := calldataload(0x1084)
                    let var0 := 0x1
                    let var1 := sub(R, f_19)
                    let var2 := addmod(var0, var1, R)
                    let var3 := mulmod(f_19, var2, R)
                    let var4 := 0x3
                    let var5 := addmod(var4, var1, R)
                    let var6 := mulmod(var3, var5, R)
                    let var7 := 0x4
                    let var8 := addmod(var7, var1, R)
                    let var9 := mulmod(var6, var8, R)
                    let a_19 := calldataload(0x0da4)
                    let a_19_prev_1 := calldataload(0x0e04)
                    let var10 := 0x0
                    let a_15 := calldataload(0x0d24)
                    let a_13 := calldataload(0x0ce4)
                    let var11 := mulmod(a_15, a_13, R)
                    let var12 := addmod(var10, var11, R)
                    let a_16 := calldataload(0x0d44)
                    let a_14 := calldataload(0x0d04)
                    let var13 := mulmod(a_16, a_14, R)
                    let var14 := addmod(var12, var13, R)
                    let var15 := addmod(a_19_prev_1, var14, R)
                    let var16 := sub(R, var15)
                    let var17 := addmod(a_19, var16, R)
                    let var18 := mulmod(var9, var17, R)
                    quotient_eval_numer := addmod(mulmod(quotient_eval_numer, y, r), var18, r)
                }
                {
                    let f_17 := calldataload(0x1044)
                    let var0 := 0x2
                    let var1 := sub(R, f_17)
                    let var2 := addmod(var0, var1, R)
                    let var3 := mulmod(f_17, var2, R)
                    let var4 := 0x3
                    let var5 := addmod(var4, var1, R)
                    let var6 := mulmod(var3, var5, R)
                    let var7 := 0x4
                    let var8 := addmod(var7, var1, R)
                    let var9 := mulmod(var6, var8, R)
                    let a_17 := calldataload(0x0d64)
                    let var10 := 0x0
                    let a_11 := calldataload(0x0ca4)
                    let a_9 := calldataload(0x0c64)
                    let var11 := mulmod(a_11, a_9, R)
                    let var12 := addmod(var10, var11, R)
                    let a_12 := calldataload(0x0cc4)
                    let a_10 := calldataload(0x0c84)
                    let var13 := mulmod(a_12, a_10, R)
                    let var14 := addmod(var12, var13, R)
                    let var15 := sub(R, var14)
                    let var16 := addmod(a_17, var15, R)
                    let var17 := mulmod(var9, var16, R)
                    quotient_eval_numer := addmod(mulmod(quotient_eval_numer, y, r), var17, r)
                }
                {
                    let f_18 := calldataload(0x1064)
                    let var0 := 0x2
                    let var1 := sub(R, f_18)
                    let var2 := addmod(var0, var1, R)
                    let var3 := mulmod(f_18, var2, R)
                    let var4 := 0x3
                    let var5 := addmod(var4, var1, R)
                    let var6 := mulmod(var3, var5, R)
                    let var7 := 0x4
                    let var8 := addmod(var7, var1, R)
                    let var9 := mulmod(var6, var8, R)
                    let a_19 := calldataload(0x0da4)
                    let var10 := 0x0
                    let a_13 := calldataload(0x0ce4)
                    let a_9 := calldataload(0x0c64)
                    let var11 := mulmod(a_13, a_9, R)
                    let var12 := addmod(var10, var11, R)
                    let a_14 := calldataload(0x0d04)
                    let a_10 := calldataload(0x0c84)
                    let var13 := mulmod(a_14, a_10, R)
                    let var14 := addmod(var12, var13, R)
                    let var15 := sub(R, var14)
                    let var16 := addmod(a_19, var15, R)
                    let var17 := mulmod(var9, var16, R)
                    quotient_eval_numer := addmod(mulmod(quotient_eval_numer, y, r), var17, r)
                }
                {
                    let f_19 := calldataload(0x1084)
                    let var0 := 0x2
                    let var1 := sub(R, f_19)
                    let var2 := addmod(var0, var1, R)
                    let var3 := mulmod(f_19, var2, R)
                    let var4 := 0x3
                    let var5 := addmod(var4, var1, R)
                    let var6 := mulmod(var3, var5, R)
                    let var7 := 0x4
                    let var8 := addmod(var7, var1, R)
                    let var9 := mulmod(var6, var8, R)
                    let a_19 := calldataload(0x0da4)
                    let var10 := 0x0
                    let a_15 := calldataload(0x0d24)
                    let a_13 := calldataload(0x0ce4)
                    let var11 := mulmod(a_15, a_13, R)
                    let var12 := addmod(var10, var11, R)
                    let a_16 := calldataload(0x0d44)
                    let a_14 := calldataload(0x0d04)
                    let var13 := mulmod(a_16, a_14, R)
                    let var14 := addmod(var12, var13, R)
                    let var15 := sub(R, var14)
                    let var16 := addmod(a_19, var15, R)
                    let var17 := mulmod(var9, var16, R)
                    quotient_eval_numer := addmod(mulmod(quotient_eval_numer, y, r), var17, r)
                }
                {
                    let f_20 := calldataload(0x10a4)
                    let var0 := 0x2
                    let var1 := sub(R, f_20)
                    let var2 := addmod(var0, var1, R)
                    let var3 := mulmod(f_20, var2, R)
                    let var4 := 0x3
                    let var5 := addmod(var4, var1, R)
                    let var6 := mulmod(var3, var5, R)
                    let a_17 := calldataload(0x0d64)
                    let var7 := 0x1
                    let a_9 := calldataload(0x0c64)
                    let var8 := mulmod(var7, a_9, R)
                    let a_10 := calldataload(0x0c84)
                    let var9 := mulmod(var8, a_10, R)
                    let var10 := sub(R, var9)
                    let var11 := addmod(a_17, var10, R)
                    let var12 := mulmod(var6, var11, R)
                    quotient_eval_numer := addmod(mulmod(quotient_eval_numer, y, r), var12, r)
                }
                {
                    let f_21 := calldataload(0x10c4)
                    let var0 := 0x1
                    let var1 := sub(R, f_21)
                    let var2 := addmod(var0, var1, R)
                    let var3 := mulmod(f_21, var2, R)
                    let var4 := 0x3
                    let var5 := addmod(var4, var1, R)
                    let var6 := mulmod(var3, var5, R)
                    let a_19 := calldataload(0x0da4)
                    let a_13 := calldataload(0x0ce4)
                    let var7 := mulmod(var0, a_13, R)
                    let a_14 := calldataload(0x0d04)
                    let var8 := mulmod(var7, a_14, R)
                    let var9 := sub(R, var8)
                    let var10 := addmod(a_19, var9, R)
                    let var11 := mulmod(var6, var10, R)
                    quotient_eval_numer := addmod(mulmod(quotient_eval_numer, y, r), var11, r)
                }
                {
                    let f_20 := calldataload(0x10a4)
                    let var0 := 0x1
                    let var1 := sub(R, f_20)
                    let var2 := addmod(var0, var1, R)
                    let var3 := mulmod(f_20, var2, R)
                    let var4 := 0x3
                    let var5 := addmod(var4, var1, R)
                    let var6 := mulmod(var3, var5, R)
                    let a_17 := calldataload(0x0d64)
                    let a_17_prev_1 := calldataload(0x0de4)
                    let a_9 := calldataload(0x0c64)
                    let var7 := mulmod(var0, a_9, R)
                    let a_10 := calldataload(0x0c84)
                    let var8 := mulmod(var7, a_10, R)
                    let var9 := mulmod(a_17_prev_1, var8, R)
                    let var10 := sub(R, var9)
                    let var11 := addmod(a_17, var10, R)
                    let var12 := mulmod(var6, var11, R)
                    quotient_eval_numer := addmod(mulmod(quotient_eval_numer, y, r), var12, r)
                }
                {
                    let f_21 := calldataload(0x10c4)
                    let var0 := 0x1
                    let var1 := sub(R, f_21)
                    let var2 := addmod(var0, var1, R)
                    let var3 := mulmod(f_21, var2, R)
                    let var4 := 0x2
                    let var5 := addmod(var4, var1, R)
                    let var6 := mulmod(var3, var5, R)
                    let a_19 := calldataload(0x0da4)
                    let a_19_prev_1 := calldataload(0x0e04)
                    let a_13 := calldataload(0x0ce4)
                    let var7 := mulmod(var0, a_13, R)
                    let a_14 := calldataload(0x0d04)
                    let var8 := mulmod(var7, a_14, R)
                    let var9 := mulmod(a_19_prev_1, var8, R)
                    let var10 := sub(R, var9)
                    let var11 := addmod(a_19, var10, R)
                    let var12 := mulmod(var6, var11, R)
                    quotient_eval_numer := addmod(mulmod(quotient_eval_numer, y, r), var12, r)
                }
                {
                    let f_16 := calldataload(0x1024)
                    let var0 := 0x1
                    let var1 := sub(R, f_16)
                    let var2 := addmod(var0, var1, R)
                    let var3 := mulmod(f_16, var2, R)
                    let var4 := 0x2
                    let var5 := addmod(var4, var1, R)
                    let var6 := mulmod(var3, var5, R)
                    let var7 := 0x4
                    let var8 := addmod(var7, var1, R)
                    let var9 := mulmod(var6, var8, R)
                    let a_17 := calldataload(0x0d64)
                    let a_9 := calldataload(0x0c64)
                    let a_11 := calldataload(0x0ca4)
                    let var10 := mulmod(a_9, a_11, R)
                    let var11 := sub(R, var10)
                    let var12 := addmod(a_17, var11, R)
                    let var13 := mulmod(var9, var12, R)
                    quotient_eval_numer := addmod(mulmod(quotient_eval_numer, y, r), var13, r)
                }
                {
                    let f_16 := calldataload(0x1024)
                    let var0 := 0x1
                    let var1 := sub(R, f_16)
                    let var2 := addmod(var0, var1, R)
                    let var3 := mulmod(f_16, var2, R)
                    let var4 := 0x2
                    let var5 := addmod(var4, var1, R)
                    let var6 := mulmod(var3, var5, R)
                    let var7 := 0x3
                    let var8 := addmod(var7, var1, R)
                    let var9 := mulmod(var6, var8, R)
                    let a_18 := calldataload(0x0d84)
                    let a_10 := calldataload(0x0c84)
                    let a_12 := calldataload(0x0cc4)
                    let var10 := mulmod(a_10, a_12, R)
                    let var11 := sub(R, var10)
                    let var12 := addmod(a_18, var11, R)
                    let var13 := mulmod(var9, var12, R)
                    quotient_eval_numer := addmod(mulmod(quotient_eval_numer, y, r), var13, r)
                }
                {
                    let f_17 := calldataload(0x1044)
                    let var0 := 0x1
                    let var1 := sub(R, f_17)
                    let var2 := addmod(var0, var1, R)
                    let var3 := mulmod(f_17, var2, R)
                    let var4 := 0x2
                    let var5 := addmod(var4, var1, R)
                    let var6 := mulmod(var3, var5, R)
                    let var7 := 0x4
                    let var8 := addmod(var7, var1, R)
                    let var9 := mulmod(var6, var8, R)
                    let a_19 := calldataload(0x0da4)
                    let a_9 := calldataload(0x0c64)
                    let a_13 := calldataload(0x0ce4)
                    let var10 := mulmod(a_9, a_13, R)
                    let var11 := sub(R, var10)
                    let var12 := addmod(a_19, var11, R)
                    let var13 := mulmod(var9, var12, R)
                    quotient_eval_numer := addmod(mulmod(quotient_eval_numer, y, r), var13, r)
                }
                {
                    let f_17 := calldataload(0x1044)
                    let var0 := 0x1
                    let var1 := sub(R, f_17)
                    let var2 := addmod(var0, var1, R)
                    let var3 := mulmod(f_17, var2, R)
                    let var4 := 0x2
                    let var5 := addmod(var4, var1, R)
                    let var6 := mulmod(var3, var5, R)
                    let var7 := 0x3
                    let var8 := addmod(var7, var1, R)
                    let var9 := mulmod(var6, var8, R)
                    let a_20 := calldataload(0x0dc4)
                    let a_10 := calldataload(0x0c84)
                    let a_14 := calldataload(0x0d04)
                    let var10 := mulmod(a_10, a_14, R)
                    let var11 := sub(R, var10)
                    let var12 := addmod(a_20, var11, R)
                    let var13 := mulmod(var9, var12, R)
                    quotient_eval_numer := addmod(mulmod(quotient_eval_numer, y, r), var13, r)
                }
                {
                    let f_18 := calldataload(0x1064)
                    let var0 := 0x1
                    let var1 := sub(R, f_18)
                    let var2 := addmod(var0, var1, R)
                    let var3 := mulmod(f_18, var2, R)
                    let var4 := 0x2
                    let var5 := addmod(var4, var1, R)
                    let var6 := mulmod(var3, var5, R)
                    let var7 := 0x4
                    let var8 := addmod(var7, var1, R)
                    let var9 := mulmod(var6, var8, R)
                    let a_19 := calldataload(0x0da4)
                    let a_13 := calldataload(0x0ce4)
                    let a_15 := calldataload(0x0d24)
                    let var10 := mulmod(a_13, a_15, R)
                    let var11 := sub(R, var10)
                    let var12 := addmod(a_19, var11, R)
                    let var13 := mulmod(var9, var12, R)
                    quotient_eval_numer := addmod(mulmod(quotient_eval_numer, y, r), var13, r)
                }
                {
                    let f_18 := calldataload(0x1064)
                    let var0 := 0x1
                    let var1 := sub(R, f_18)
                    let var2 := addmod(var0, var1, R)
                    let var3 := mulmod(f_18, var2, R)
                    let var4 := 0x2
                    let var5 := addmod(var4, var1, R)
                    let var6 := mulmod(var3, var5, R)
                    let var7 := 0x3
                    let var8 := addmod(var7, var1, R)
                    let var9 := mulmod(var6, var8, R)
                    let a_20 := calldataload(0x0dc4)
                    let a_14 := calldataload(0x0d04)
                    let a_16 := calldataload(0x0d44)
                    let var10 := mulmod(a_14, a_16, R)
                    let var11 := sub(R, var10)
                    let var12 := addmod(a_20, var11, R)
                    let var13 := mulmod(var9, var12, R)
                    quotient_eval_numer := addmod(mulmod(quotient_eval_numer, y, r), var13, r)
                }
                {
                    let f_19 := calldataload(0x1084)
                    let var0 := 0x1
                    let var1 := sub(R, f_19)
                    let var2 := addmod(var0, var1, R)
                    let var3 := mulmod(f_19, var2, R)
                    let var4 := 0x2
                    let var5 := addmod(var4, var1, R)
                    let var6 := mulmod(var3, var5, R)
                    let var7 := 0x4
                    let var8 := addmod(var7, var1, R)
                    let var9 := mulmod(var6, var8, R)
                    let a_17 := calldataload(0x0d64)
                    let var10 := 0x0
                    let a_9 := calldataload(0x0c64)
                    let var11 := addmod(var10, a_9, R)
                    let a_10 := calldataload(0x0c84)
                    let var12 := addmod(var11, a_10, R)
                    let var13 := sub(R, var12)
                    let var14 := addmod(a_17, var13, R)
                    let var15 := mulmod(var9, var14, R)
                    quotient_eval_numer := addmod(mulmod(quotient_eval_numer, y, r), var15, r)
                }
                {
                    let f_20 := calldataload(0x10a4)
                    let var0 := 0x1
                    let var1 := sub(R, f_20)
                    let var2 := addmod(var0, var1, R)
                    let var3 := mulmod(f_20, var2, R)
                    let var4 := 0x2
                    let var5 := addmod(var4, var1, R)
                    let var6 := mulmod(var3, var5, R)
                    let a_19 := calldataload(0x0da4)
                    let var7 := 0x0
                    let a_13 := calldataload(0x0ce4)
                    let var8 := addmod(var7, a_13, R)
                    let a_14 := calldataload(0x0d04)
                    let var9 := addmod(var8, a_14, R)
                    let var10 := sub(R, var9)
                    let var11 := addmod(a_19, var10, R)
                    let var12 := mulmod(var6, var11, R)
                    quotient_eval_numer := addmod(mulmod(quotient_eval_numer, y, r), var12, r)
                }
                {
                    let f_19 := calldataload(0x1084)
                    let var0 := 0x1
                    let var1 := sub(R, f_19)
                    let var2 := addmod(var0, var1, R)
                    let var3 := mulmod(f_19, var2, R)
                    let var4 := 0x2
                    let var5 := addmod(var4, var1, R)
                    let var6 := mulmod(var3, var5, R)
                    let var7 := 0x3
                    let var8 := addmod(var7, var1, R)
                    let var9 := mulmod(var6, var8, R)
                    let a_17 := calldataload(0x0d64)
                    let a_17_prev_1 := calldataload(0x0de4)
                    let var10 := 0x0
                    let a_9 := calldataload(0x0c64)
                    let var11 := addmod(var10, a_9, R)
                    let a_10 := calldataload(0x0c84)
                    let var12 := addmod(var11, a_10, R)
                    let var13 := addmod(a_17_prev_1, var12, R)
                    let var14 := sub(R, var13)
                    let var15 := addmod(a_17, var14, R)
                    let var16 := mulmod(var9, var15, R)
                    quotient_eval_numer := addmod(mulmod(quotient_eval_numer, y, r), var16, r)
                }
                {
                    let f_21 := calldataload(0x10c4)
                    let var0 := 0x2
                    let var1 := sub(R, f_21)
                    let var2 := addmod(var0, var1, R)
                    let var3 := mulmod(f_21, var2, R)
                    let var4 := 0x3
                    let var5 := addmod(var4, var1, R)
                    let var6 := mulmod(var3, var5, R)
                    let a_19 := calldataload(0x0da4)
                    let a_19_prev_1 := calldataload(0x0e04)
                    let var7 := 0x0
                    let a_13 := calldataload(0x0ce4)
                    let var8 := addmod(var7, a_13, R)
                    let a_14 := calldataload(0x0d04)
                    let var9 := addmod(var8, a_14, R)
                    let var10 := addmod(a_19_prev_1, var9, R)
                    let var11 := sub(R, var10)
                    let var12 := addmod(a_19, var11, R)
                    let var13 := mulmod(var6, var12, R)
                    quotient_eval_numer := addmod(mulmod(quotient_eval_numer, y, r), var13, r)
                }
                {
                    let f_22 := calldataload(0x10e4)
                    let var0 := 0x2
                    let var1 := sub(R, f_22)
                    let var2 := addmod(var0, var1, R)
                    let var3 := mulmod(f_22, var2, R)
                    let var4 := 0x3
                    let var5 := addmod(var4, var1, R)
                    let var6 := mulmod(var3, var5, R)
                    let var7 := 0x4
                    let var8 := addmod(var7, var1, R)
                    let var9 := mulmod(var6, var8, R)
                    let var10 := 0x5
                    let var11 := addmod(var10, var1, R)
                    let var12 := mulmod(var9, var11, R)
                    let a_19 := calldataload(0x0da4)
                    let var13 := 0x0
                    let var14 := 0x1
                    let c_0 := mload(0x1c00)
                    let var15 := mulmod(var14, c_0, R)
                    let var16 := mulmod(var15, c_0, R)
                    let a_9 := calldataload(0x0c64)
                    let var17 := mulmod(var16, a_9, R)
                    let var18 := addmod(var13, var17, R)
                    let a_10 := calldataload(0x0c84)
                    let var19 := mulmod(var15, a_10, R)
                    let var20 := addmod(var18, var19, R)
                    let var21 := addmod(var13, var20, R)
                    let var22 := sub(R, var21)
                    let var23 := addmod(a_19, var22, R)
                    let var24 := mulmod(var12, var23, R)
                    quotient_eval_numer := addmod(mulmod(quotient_eval_numer, y, r), var24, r)
                }
                {
                    let f_22 := calldataload(0x10e4)
                    let var0 := 0x1
                    let var1 := sub(R, f_22)
                    let var2 := addmod(var0, var1, R)
                    let var3 := mulmod(f_22, var2, R)
                    let var4 := 0x3
                    let var5 := addmod(var4, var1, R)
                    let var6 := mulmod(var3, var5, R)
                    let var7 := 0x4
                    let var8 := addmod(var7, var1, R)
                    let var9 := mulmod(var6, var8, R)
                    let var10 := 0x5
                    let var11 := addmod(var10, var1, R)
                    let var12 := mulmod(var9, var11, R)
                    let a_19 := calldataload(0x0da4)
                    let a_19_prev_1 := calldataload(0x0e04)
                    let c_0 := mload(0x1c00)
                    let var13 := mulmod(var0, c_0, R)
                    let var14 := mulmod(var13, c_0, R)
                    let var15 := mulmod(a_19_prev_1, var14, R)
                    let var16 := 0x0
                    let a_9 := calldataload(0x0c64)
                    let var17 := mulmod(var14, a_9, R)
                    let var18 := addmod(var16, var17, R)
                    let a_10 := calldataload(0x0c84)
                    let var19 := mulmod(var13, a_10, R)
                    let var20 := addmod(var18, var19, R)
                    let var21 := addmod(var15, var20, R)
                    let var22 := sub(R, var21)
                    let var23 := addmod(a_19, var22, R)
                    let var24 := mulmod(var12, var23, R)
                    quotient_eval_numer := addmod(mulmod(quotient_eval_numer, y, r), var24, r)
                }
                {
                    let f_22 := calldataload(0x10e4)
                    let var0 := 0x1
                    let var1 := sub(R, f_22)
                    let var2 := addmod(var0, var1, R)
                    let var3 := mulmod(f_22, var2, R)
                    let var4 := 0x2
                    let var5 := addmod(var4, var1, R)
                    let var6 := mulmod(var3, var5, R)
                    let var7 := 0x4
                    let var8 := addmod(var7, var1, R)
                    let var9 := mulmod(var6, var8, R)
                    let var10 := 0x5
                    let var11 := addmod(var10, var1, R)
                    let var12 := mulmod(var9, var11, R)
                    let a_19 := calldataload(0x0da4)
                    let var13 := 0x0
                    let c_0 := mload(0x1c00)
                    let var14 := mulmod(var0, c_0, R)
                    let var15 := mulmod(var14, c_0, R)
                    let a_13 := calldataload(0x0ce4)
                    let var16 := mulmod(var15, a_13, R)
                    let var17 := addmod(var13, var16, R)
                    let a_14 := calldataload(0x0d04)
                    let var18 := mulmod(var14, a_14, R)
                    let var19 := addmod(var17, var18, R)
                    let var20 := addmod(var13, var19, R)
                    let var21 := sub(R, var20)
                    let var22 := addmod(a_19, var21, R)
                    let var23 := mulmod(var12, var22, R)
                    quotient_eval_numer := addmod(mulmod(quotient_eval_numer, y, r), var23, r)
                }
                {
                    let f_22 := calldataload(0x10e4)
                    let var0 := 0x1
                    let var1 := sub(R, f_22)
                    let var2 := addmod(var0, var1, R)
                    let var3 := mulmod(f_22, var2, R)
                    let var4 := 0x2
                    let var5 := addmod(var4, var1, R)
                    let var6 := mulmod(var3, var5, R)
                    let var7 := 0x3
                    let var8 := addmod(var7, var1, R)
                    let var9 := mulmod(var6, var8, R)
                    let var10 := 0x5
                    let var11 := addmod(var10, var1, R)
                    let var12 := mulmod(var9, var11, R)
                    let a_19 := calldataload(0x0da4)
                    let a_19_prev_1 := calldataload(0x0e04)
                    let c_0 := mload(0x1c00)
                    let var13 := mulmod(var0, c_0, R)
                    let var14 := mulmod(var13, c_0, R)
                    let var15 := mulmod(a_19_prev_1, var14, R)
                    let var16 := 0x0
                    let a_13 := calldataload(0x0ce4)
                    let var17 := mulmod(var14, a_13, R)
                    let var18 := addmod(var16, var17, R)
                    let a_14 := calldataload(0x0d04)
                    let var19 := mulmod(var13, a_14, R)
                    let var20 := addmod(var18, var19, R)
                    let var21 := addmod(var15, var20, R)
                    let var22 := sub(R, var21)
                    let var23 := addmod(a_19, var22, R)
                    let var24 := mulmod(var12, var23, R)
                    quotient_eval_numer := addmod(mulmod(quotient_eval_numer, y, r), var24, r)
                }
                {
                    let f_22 := calldataload(0x10e4)
                    let var0 := 0x1
                    let var1 := sub(R, f_22)
                    let var2 := addmod(var0, var1, R)
                    let var3 := mulmod(f_22, var2, R)
                    let var4 := 0x2
                    let var5 := addmod(var4, var1, R)
                    let var6 := mulmod(var3, var5, R)
                    let var7 := 0x3
                    let var8 := addmod(var7, var1, R)
                    let var9 := mulmod(var6, var8, R)
                    let var10 := 0x4
                    let var11 := addmod(var10, var1, R)
                    let var12 := mulmod(var9, var11, R)
                    let a_19 := calldataload(0x0da4)
                    let var13 := 0x0
                    let c_1 := mload(0x1c20)
                    let var14 := mulmod(var0, c_1, R)
                    let var15 := mulmod(var14, c_1, R)
                    let a_9 := calldataload(0x0c64)
                    let var16 := mulmod(var15, a_9, R)
                    let var17 := addmod(var13, var16, R)
                    let a_10 := calldataload(0x0c84)
                    let var18 := mulmod(var14, a_10, R)
                    let var19 := addmod(var17, var18, R)
                    let var20 := addmod(var13, var19, R)
                    let var21 := sub(R, var20)
                    let var22 := addmod(a_19, var21, R)
                    let var23 := mulmod(var12, var22, R)
                    quotient_eval_numer := addmod(mulmod(quotient_eval_numer, y, r), var23, r)
                }
                {
                    let f_23 := calldataload(0x1104)
                    let var0 := 0x2
                    let var1 := sub(R, f_23)
                    let var2 := addmod(var0, var1, R)
                    let var3 := mulmod(f_23, var2, R)
                    let var4 := 0x3
                    let var5 := addmod(var4, var1, R)
                    let var6 := mulmod(var3, var5, R)
                    let a_19 := calldataload(0x0da4)
                    let a_19_prev_1 := calldataload(0x0e04)
                    let var7 := 0x1
                    let c_1 := mload(0x1c20)
                    let var8 := mulmod(var7, c_1, R)
                    let var9 := mulmod(var8, c_1, R)
                    let var10 := mulmod(a_19_prev_1, var9, R)
                    let var11 := 0x0
                    let a_9 := calldataload(0x0c64)
                    let var12 := mulmod(var9, a_9, R)
                    let var13 := addmod(var11, var12, R)
                    let a_10 := calldataload(0x0c84)
                    let var14 := mulmod(var8, a_10, R)
                    let var15 := addmod(var13, var14, R)
                    let var16 := addmod(var10, var15, R)
                    let var17 := sub(R, var16)
                    let var18 := addmod(a_19, var17, R)
                    let var19 := mulmod(var6, var18, R)
                    quotient_eval_numer := addmod(mulmod(quotient_eval_numer, y, r), var19, r)
                }
                {
                    let f_23 := calldataload(0x1104)
                    let var0 := 0x1
                    let var1 := sub(R, f_23)
                    let var2 := addmod(var0, var1, R)
                    let var3 := mulmod(f_23, var2, R)
                    let var4 := 0x3
                    let var5 := addmod(var4, var1, R)
                    let var6 := mulmod(var3, var5, R)
                    let a_19 := calldataload(0x0da4)
                    let var7 := 0x0
                    let c_1 := mload(0x1c20)
                    let var8 := mulmod(var0, c_1, R)
                    let var9 := mulmod(var8, c_1, R)
                    let a_13 := calldataload(0x0ce4)
                    let var10 := mulmod(var9, a_13, R)
                    let var11 := addmod(var7, var10, R)
                    let a_14 := calldataload(0x0d04)
                    let var12 := mulmod(var8, a_14, R)
                    let var13 := addmod(var11, var12, R)
                    let var14 := addmod(var7, var13, R)
                    let var15 := sub(R, var14)
                    let var16 := addmod(a_19, var15, R)
                    let var17 := mulmod(var6, var16, R)
                    quotient_eval_numer := addmod(mulmod(quotient_eval_numer, y, r), var17, r)
                }
                {
                    let f_23 := calldataload(0x1104)
                    let var0 := 0x1
                    let var1 := sub(R, f_23)
                    let var2 := addmod(var0, var1, R)
                    let var3 := mulmod(f_23, var2, R)
                    let var4 := 0x2
                    let var5 := addmod(var4, var1, R)
                    let var6 := mulmod(var3, var5, R)
                    let a_19 := calldataload(0x0da4)
                    let a_19_prev_1 := calldataload(0x0e04)
                    let c_1 := mload(0x1c20)
                    let var7 := mulmod(var0, c_1, R)
                    let var8 := mulmod(var7, c_1, R)
                    let var9 := mulmod(a_19_prev_1, var8, R)
                    let var10 := 0x0
                    let a_13 := calldataload(0x0ce4)
                    let var11 := mulmod(var8, a_13, R)
                    let var12 := addmod(var10, var11, R)
                    let a_14 := calldataload(0x0d04)
                    let var13 := mulmod(var7, a_14, R)
                    let var14 := addmod(var12, var13, R)
                    let var15 := addmod(var9, var14, R)
                    let var16 := sub(R, var15)
                    let var17 := addmod(a_19, var16, R)
                    let var18 := mulmod(var6, var17, R)
                    quotient_eval_numer := addmod(mulmod(quotient_eval_numer, y, r), var18, r)
                }
                {
                    let l_0 := mload(L_0_MPTR)
                    let eval := addmod(l_0, sub(R, mulmod(l_0, calldataload(0x1444), R)), R)
                    quotient_eval_numer := addmod(mulmod(quotient_eval_numer, y, r), eval, r)
                }
                {
                    let perm_z_last := calldataload(0x1624)
                    let eval := mulmod(mload(L_LAST_MPTR), addmod(mulmod(perm_z_last, perm_z_last, R), sub(R, perm_z_last), R), R)
                    quotient_eval_numer := addmod(mulmod(quotient_eval_numer, y, r), eval, r)
                }
                {
                    let eval := mulmod(mload(L_0_MPTR), addmod(calldataload(0x14a4), sub(R, calldataload(0x1484)), R), R)
                    quotient_eval_numer := addmod(mulmod(quotient_eval_numer, y, r), eval, r)
                }
                {
                    let eval := mulmod(mload(L_0_MPTR), addmod(calldataload(0x1504), sub(R, calldataload(0x14e4)), R), R)
                    quotient_eval_numer := addmod(mulmod(quotient_eval_numer, y, r), eval, r)
                }
                {
                    let eval := mulmod(mload(L_0_MPTR), addmod(calldataload(0x1564), sub(R, calldataload(0x1544)), R), R)
                    quotient_eval_numer := addmod(mulmod(quotient_eval_numer, y, r), eval, r)
                }
                {
                    let eval := mulmod(mload(L_0_MPTR), addmod(calldataload(0x15c4), sub(R, calldataload(0x15a4)), R), R)
                    quotient_eval_numer := addmod(mulmod(quotient_eval_numer, y, r), eval, r)
                }
                {
                    let eval := mulmod(mload(L_0_MPTR), addmod(calldataload(0x1624), sub(R, calldataload(0x1604)), R), R)
                    quotient_eval_numer := addmod(mulmod(quotient_eval_numer, y, r), eval, r)
                }
                {
                    let gamma := mload(GAMMA_MPTR)
                    let beta := mload(BETA_MPTR)
                    let lhs := calldataload(0x1464)
                    let rhs := calldataload(0x1444)
                    lhs := mulmod(lhs, addmod(addmod(calldataload(0x0aa4), mulmod(beta, calldataload(0x1144), R), R), gamma, R), R)
                    lhs := mulmod(lhs, addmod(addmod(calldataload(0x0ac4), mulmod(beta, calldataload(0x1164), R), R), gamma, R), R)
                    lhs := mulmod(lhs, addmod(addmod(calldataload(0x0ae4), mulmod(beta, calldataload(0x1184), R), R), gamma, R), R)
                    lhs := mulmod(lhs, addmod(addmod(calldataload(0x0b04), mulmod(beta, calldataload(0x11a4), R), R), gamma, R), R)
                    mstore(0x00, mulmod(beta, mload(X_MPTR), R))
                    rhs := mulmod(rhs, addmod(addmod(calldataload(0x0aa4), mload(0x00), R), gamma, R), R)
                    mstore(0x00, mulmod(mload(0x00), DELTA, R))
                    rhs := mulmod(rhs, addmod(addmod(calldataload(0x0ac4), mload(0x00), R), gamma, R), R)
                    mstore(0x00, mulmod(mload(0x00), DELTA, R))
                    rhs := mulmod(rhs, addmod(addmod(calldataload(0x0ae4), mload(0x00), R), gamma, R), R)
                    mstore(0x00, mulmod(mload(0x00), DELTA, R))
                    rhs := mulmod(rhs, addmod(addmod(calldataload(0x0b04), mload(0x00), R), gamma, R), R)
                    mstore(0x00, mulmod(mload(0x00), DELTA, R))
                    let left_sub_right := addmod(lhs, sub(R, rhs), R)
                    let eval := addmod(left_sub_right, sub(R, mulmod(left_sub_right, addmod(mload(L_LAST_MPTR), mload(L_BLIND_MPTR), R), R)), R)
                    quotient_eval_numer := addmod(mulmod(quotient_eval_numer, y, r), eval, r)
                }
                {
                    let gamma := mload(GAMMA_MPTR)
                    let beta := mload(BETA_MPTR)
                    let lhs := calldataload(0x14c4)
                    let rhs := calldataload(0x14a4)
                    lhs := mulmod(lhs, addmod(addmod(calldataload(0x0b24), mulmod(beta, calldataload(0x11c4), R), R), gamma, R), R)
                    lhs := mulmod(lhs, addmod(addmod(calldataload(0x0b44), mulmod(beta, calldataload(0x11e4), R), R), gamma, R), R)
                    lhs := mulmod(lhs, addmod(addmod(calldataload(0x0e24), mulmod(beta, calldataload(0x1204), R), R), gamma, R), R)
                    lhs := mulmod(lhs, addmod(addmod(calldataload(0x0b64), mulmod(beta, calldataload(0x1224), R), R), gamma, R), R)
                    rhs := mulmod(rhs, addmod(addmod(calldataload(0x0b24), mload(0x00), R), gamma, R), R)
                    mstore(0x00, mulmod(mload(0x00), DELTA, R))
                    rhs := mulmod(rhs, addmod(addmod(calldataload(0x0b44), mload(0x00), R), gamma, R), R)
                    mstore(0x00, mulmod(mload(0x00), DELTA, R))
                    rhs := mulmod(rhs, addmod(addmod(calldataload(0x0e24), mload(0x00), R), gamma, R), R)
                    mstore(0x00, mulmod(mload(0x00), DELTA, R))
                    rhs := mulmod(rhs, addmod(addmod(calldataload(0x0b64), mload(0x00), R), gamma, R), R)
                    mstore(0x00, mulmod(mload(0x00), DELTA, R))
                    let left_sub_right := addmod(lhs, sub(R, rhs), R)
                    let eval := addmod(left_sub_right, sub(R, mulmod(left_sub_right, addmod(mload(L_LAST_MPTR), mload(L_BLIND_MPTR), R), R)), R)
                    quotient_eval_numer := addmod(mulmod(quotient_eval_numer, y, r), eval, r)
                }
                {
                    let gamma := mload(GAMMA_MPTR)
                    let beta := mload(BETA_MPTR)
                    let lhs := calldataload(0x1524)
                    let rhs := calldataload(0x1504)
                    lhs := mulmod(lhs, addmod(addmod(calldataload(0x0b84), mulmod(beta, calldataload(0x1244), R), R), gamma, R), R)
                    lhs := mulmod(lhs, addmod(addmod(calldataload(0x0e44), mulmod(beta, calldataload(0x1264), R), R), gamma, R), R)
                    lhs := mulmod(lhs, addmod(addmod(mload(INSTANCE_EVAL_MPTR), mulmod(beta, calldataload(0x1284), R), R), gamma, R), R)
                    lhs := mulmod(lhs, addmod(addmod(calldataload(0x0e64), mulmod(beta, calldataload(0x12a4), R), R), gamma, R), R)
                    rhs := mulmod(rhs, addmod(addmod(calldataload(0x0b84), mload(0x00), R), gamma, R), R)
                    mstore(0x00, mulmod(mload(0x00), DELTA, R))
                    rhs := mulmod(rhs, addmod(addmod(calldataload(0x0e44), mload(0x00), R), gamma, R), R)
                    mstore(0x00, mulmod(mload(0x00), DELTA, R))
                    rhs := mulmod(rhs, addmod(addmod(mload(INSTANCE_EVAL_MPTR), mload(0x00), R), gamma, R), R)
                    mstore(0x00, mulmod(mload(0x00), DELTA, R))
                    rhs := mulmod(rhs, addmod(addmod(calldataload(0x0e64), mload(0x00), R), gamma, R), R)
                    mstore(0x00, mulmod(mload(0x00), DELTA, R))
                    let left_sub_right := addmod(lhs, sub(R, rhs), R)
                    let eval := addmod(left_sub_right, sub(R, mulmod(left_sub_right, addmod(mload(L_LAST_MPTR), mload(L_BLIND_MPTR), R), R)), R)
                    quotient_eval_numer := addmod(mulmod(quotient_eval_numer, y, r), eval, r)
                }
                {
                    let gamma := mload(GAMMA_MPTR)
                    let beta := mload(BETA_MPTR)
                    let lhs := calldataload(0x1584)
                    let rhs := calldataload(0x1564)
                    lhs := mulmod(lhs, addmod(addmod(calldataload(0x0c64), mulmod(beta, calldataload(0x12c4), R), R), gamma, R), R)
                    lhs := mulmod(lhs, addmod(addmod(calldataload(0x0c84), mulmod(beta, calldataload(0x12e4), R), R), gamma, R), R)
                    lhs := mulmod(lhs, addmod(addmod(calldataload(0x0ca4), mulmod(beta, calldataload(0x1304), R), R), gamma, R), R)
                    lhs := mulmod(lhs, addmod(addmod(calldataload(0x0cc4), mulmod(beta, calldataload(0x1324), R), R), gamma, R), R)
                    rhs := mulmod(rhs, addmod(addmod(calldataload(0x0c64), mload(0x00), R), gamma, R), R)
                    mstore(0x00, mulmod(mload(0x00), DELTA, R))
                    rhs := mulmod(rhs, addmod(addmod(calldataload(0x0c84), mload(0x00), R), gamma, R), R)
                    mstore(0x00, mulmod(mload(0x00), DELTA, R))
                    rhs := mulmod(rhs, addmod(addmod(calldataload(0x0ca4), mload(0x00), R), gamma, R), R)
                    mstore(0x00, mulmod(mload(0x00), DELTA, R))
                    rhs := mulmod(rhs, addmod(addmod(calldataload(0x0cc4), mload(0x00), R), gamma, R), R)
                    mstore(0x00, mulmod(mload(0x00), DELTA, R))
                    let left_sub_right := addmod(lhs, sub(R, rhs), R)
                    let eval := addmod(left_sub_right, sub(R, mulmod(left_sub_right, addmod(mload(L_LAST_MPTR), mload(L_BLIND_MPTR), R), R)), R)
                    quotient_eval_numer := addmod(mulmod(quotient_eval_numer, y, r), eval, r)
                }
                {
                    let gamma := mload(GAMMA_MPTR)
                    let beta := mload(BETA_MPTR)
                    let lhs := calldataload(0x15e4)
                    let rhs := calldataload(0x15c4)
                    lhs := mulmod(lhs, addmod(addmod(calldataload(0x0ce4), mulmod(beta, calldataload(0x1344), R), R), gamma, R), R)
                    lhs := mulmod(lhs, addmod(addmod(calldataload(0x0d04), mulmod(beta, calldataload(0x1364), R), R), gamma, R), R)
                    lhs := mulmod(lhs, addmod(addmod(calldataload(0x0d24), mulmod(beta, calldataload(0x1384), R), R), gamma, R), R)
                    lhs := mulmod(lhs, addmod(addmod(calldataload(0x0d44), mulmod(beta, calldataload(0x13a4), R), R), gamma, R), R)
                    rhs := mulmod(rhs, addmod(addmod(calldataload(0x0ce4), mload(0x00), R), gamma, R), R)
                    mstore(0x00, mulmod(mload(0x00), DELTA, R))
                    rhs := mulmod(rhs, addmod(addmod(calldataload(0x0d04), mload(0x00), R), gamma, R), R)
                    mstore(0x00, mulmod(mload(0x00), DELTA, R))
                    rhs := mulmod(rhs, addmod(addmod(calldataload(0x0d24), mload(0x00), R), gamma, R), R)
                    mstore(0x00, mulmod(mload(0x00), DELTA, R))
                    rhs := mulmod(rhs, addmod(addmod(calldataload(0x0d44), mload(0x00), R), gamma, R), R)
                    mstore(0x00, mulmod(mload(0x00), DELTA, R))
                    let left_sub_right := addmod(lhs, sub(R, rhs), R)
                    let eval := addmod(left_sub_right, sub(R, mulmod(left_sub_right, addmod(mload(L_LAST_MPTR), mload(L_BLIND_MPTR), R), R)), R)
                    quotient_eval_numer := addmod(mulmod(quotient_eval_numer, y, r), eval, r)
                }
                {
                    let gamma := mload(GAMMA_MPTR)
                    let beta := mload(BETA_MPTR)
                    let lhs := calldataload(0x1644)
                    let rhs := calldataload(0x1624)
                    lhs := mulmod(lhs, addmod(addmod(calldataload(0x0d64), mulmod(beta, calldataload(0x13c4), R), R), gamma, R), R)
                    lhs := mulmod(lhs, addmod(addmod(calldataload(0x0d84), mulmod(beta, calldataload(0x13e4), R), R), gamma, R), R)
                    lhs := mulmod(lhs, addmod(addmod(calldataload(0x0da4), mulmod(beta, calldataload(0x1404), R), R), gamma, R), R)
                    lhs := mulmod(lhs, addmod(addmod(calldataload(0x0dc4), mulmod(beta, calldataload(0x1424), R), R), gamma, R), R)
                    rhs := mulmod(rhs, addmod(addmod(calldataload(0x0d64), mload(0x00), R), gamma, R), R)
                    mstore(0x00, mulmod(mload(0x00), DELTA, R))
                    rhs := mulmod(rhs, addmod(addmod(calldataload(0x0d84), mload(0x00), R), gamma, R), R)
                    mstore(0x00, mulmod(mload(0x00), DELTA, R))
                    rhs := mulmod(rhs, addmod(addmod(calldataload(0x0da4), mload(0x00), R), gamma, R), R)
                    mstore(0x00, mulmod(mload(0x00), DELTA, R))
                    rhs := mulmod(rhs, addmod(addmod(calldataload(0x0dc4), mload(0x00), R), gamma, R), R)
                    let left_sub_right := addmod(lhs, sub(R, rhs), R)
                    let eval := addmod(left_sub_right, sub(R, mulmod(left_sub_right, addmod(mload(L_LAST_MPTR), mload(L_BLIND_MPTR), R), R)), R)
                    quotient_eval_numer := addmod(mulmod(quotient_eval_numer, y, r), eval, r)
                }
                {
                    let l_0 := mload(L_0_MPTR)
                    let eval := mulmod(l_0, calldataload(0x1664), R)
                    quotient_eval_numer := addmod(mulmod(quotient_eval_numer, y, r), eval, r)
                }
                {
                    let l_last := mload(L_LAST_MPTR)
                    let eval := mulmod(l_last, calldataload(0x1664), R)
                    quotient_eval_numer := addmod(mulmod(quotient_eval_numer, y, r), eval, r)
                }
                {
                    let theta := mload(THETA_MPTR)
                    let beta := mload(BETA_MPTR)
                    let table
                    {
                        let f_5 := calldataload(0x0ec4)
                        table := f_5
                        table := addmod(table, beta, R)
                    }
                    let input_0
                    {
                        let f_7 := calldataload(0x0f04)
                        let var0 := 0x1
                        let var1 := mulmod(f_7, var0, R)
                        let a_0 := calldataload(0x0aa4)
                        let var2 := mulmod(var1, a_0, R)
                        let var3 := sub(R, var1)
                        let var4 := addmod(var0, var3, R)
                        let var5 := 0x0
                        let var6 := mulmod(var4, var5, R)
                        let var7 := addmod(var2, var6, R)
                        input_0 := var7
                        input_0 := addmod(input_0, beta, R)
                    }
                    let lhs
                    let rhs
                    rhs := table
                    {
                        let tmp := input_0
                        rhs := addmod(rhs, sub(R, mulmod(calldataload(0x16a4), tmp, R)), R)
                        lhs := mulmod(mulmod(table, tmp, R), addmod(calldataload(0x1684), sub(R, calldataload(0x1664)), R), R)
                    }
                    let eval := mulmod(addmod(1, sub(R, addmod(mload(L_BLIND_MPTR), mload(L_LAST_MPTR), R)), R), addmod(lhs, sub(R, rhs), R), R)
                    quotient_eval_numer := addmod(mulmod(quotient_eval_numer, y, r), eval, r)
                }
                {
                    let l_0 := mload(L_0_MPTR)
                    let eval := mulmod(l_0, calldataload(0x16c4), R)
                    quotient_eval_numer := addmod(mulmod(quotient_eval_numer, y, r), eval, r)
                }
                {
                    let l_last := mload(L_LAST_MPTR)
                    let eval := mulmod(l_last, calldataload(0x16c4), R)
                    quotient_eval_numer := addmod(mulmod(quotient_eval_numer, y, r), eval, r)
                }
                {
                    let theta := mload(THETA_MPTR)
                    let beta := mload(BETA_MPTR)
                    let table
                    {
                        let f_5 := calldataload(0x0ec4)
                        table := f_5
                        table := addmod(table, beta, R)
                    }
                    let input_0
                    {
                        let f_8 := calldataload(0x0f24)
                        let var0 := 0x1
                        let var1 := mulmod(f_8, var0, R)
                        let a_1 := calldataload(0x0ac4)
                        let var2 := mulmod(var1, a_1, R)
                        let var3 := sub(R, var1)
                        let var4 := addmod(var0, var3, R)
                        let var5 := 0x0
                        let var6 := mulmod(var4, var5, R)
                        let var7 := addmod(var2, var6, R)
                        input_0 := var7
                        input_0 := addmod(input_0, beta, R)
                    }
                    let lhs
                    let rhs
                    rhs := table
                    {
                        let tmp := input_0
                        rhs := addmod(rhs, sub(R, mulmod(calldataload(0x1704), tmp, R)), R)
                        lhs := mulmod(mulmod(table, tmp, R), addmod(calldataload(0x16e4), sub(R, calldataload(0x16c4)), R), R)
                    }
                    let eval := mulmod(addmod(1, sub(R, addmod(mload(L_BLIND_MPTR), mload(L_LAST_MPTR), R)), R), addmod(lhs, sub(R, rhs), R), R)
                    quotient_eval_numer := addmod(mulmod(quotient_eval_numer, y, r), eval, r)
                }
                {
                    let l_0 := mload(L_0_MPTR)
                    let eval := mulmod(l_0, calldataload(0x1724), R)
                    quotient_eval_numer := addmod(mulmod(quotient_eval_numer, y, r), eval, r)
                }
                {
                    let l_last := mload(L_LAST_MPTR)
                    let eval := mulmod(l_last, calldataload(0x1724), R)
                    quotient_eval_numer := addmod(mulmod(quotient_eval_numer, y, r), eval, r)
                }
                {
                    let theta := mload(THETA_MPTR)
                    let beta := mload(BETA_MPTR)
                    let table
                    {
                        let f_6 := calldataload(0x0ee4)
                        table := f_6
                        table := addmod(table, beta, R)
                    }
                    let input_0
                    {
                        let f_9 := calldataload(0x0f44)
                        let var0 := 0x1
                        let var1 := mulmod(f_9, var0, R)
                        let a_0 := calldataload(0x0aa4)
                        let var2 := mulmod(var1, a_0, R)
                        let var3 := sub(R, var1)
                        let var4 := addmod(var0, var3, R)
                        let var5 := 0x30644e72e131a029b85045b68181585d2833e84879b9709143e1f593f0000000
                        let var6 := mulmod(var4, var5, R)
                        let var7 := addmod(var2, var6, R)
                        input_0 := var7
                        input_0 := addmod(input_0, beta, R)
                    }
                    let lhs
                    let rhs
                    rhs := table
                    {
                        let tmp := input_0
                        rhs := addmod(rhs, sub(R, mulmod(calldataload(0x1764), tmp, R)), R)
                        lhs := mulmod(mulmod(table, tmp, R), addmod(calldataload(0x1744), sub(R, calldataload(0x1724)), R), R)
                    }
                    let eval := mulmod(addmod(1, sub(R, addmod(mload(L_BLIND_MPTR), mload(L_LAST_MPTR), R)), R), addmod(lhs, sub(R, rhs), R), R)
                    quotient_eval_numer := addmod(mulmod(quotient_eval_numer, y, r), eval, r)
                }
                {
                    let l_0 := mload(L_0_MPTR)
                    let eval := mulmod(l_0, calldataload(0x1784), R)
                    quotient_eval_numer := addmod(mulmod(quotient_eval_numer, y, r), eval, r)
                }
                {
                    let l_last := mload(L_LAST_MPTR)
                    let eval := mulmod(l_last, calldataload(0x1784), R)
                    quotient_eval_numer := addmod(mulmod(quotient_eval_numer, y, r), eval, r)
                }
                {
                    let theta := mload(THETA_MPTR)
                    let beta := mload(BETA_MPTR)
                    let table
                    {
                        let f_6 := calldataload(0x0ee4)
                        table := f_6
                        table := addmod(table, beta, R)
                    }
                    let input_0
                    {
                        let f_10 := calldataload(0x0f64)
                        let var0 := 0x1
                        let var1 := mulmod(f_10, var0, R)
                        let a_1 := calldataload(0x0ac4)
                        let var2 := mulmod(var1, a_1, R)
                        let var3 := sub(R, var1)
                        let var4 := addmod(var0, var3, R)
                        let var5 := 0x30644e72e131a029b85045b68181585d2833e84879b9709143e1f593f0000000
                        let var6 := mulmod(var4, var5, R)
                        let var7 := addmod(var2, var6, R)
                        input_0 := var7
                        input_0 := addmod(input_0, beta, R)
                    }
                    let lhs
                    let rhs
                    rhs := table
                    {
                        let tmp := input_0
                        rhs := addmod(rhs, sub(R, mulmod(calldataload(0x17c4), tmp, R)), R)
                        lhs := mulmod(mulmod(table, tmp, R), addmod(calldataload(0x17a4), sub(R, calldataload(0x1784)), R), R)
                    }
                    let eval := mulmod(addmod(1, sub(R, addmod(mload(L_BLIND_MPTR), mload(L_LAST_MPTR), R)), R), addmod(lhs, sub(R, rhs), R), R)
                    quotient_eval_numer := addmod(mulmod(quotient_eval_numer, y, r), eval, r)
                }

                pop(y)

                let quotient_eval := mulmod(quotient_eval_numer, mload(X_N_MINUS_1_INV_MPTR), r)
                mstore(QUOTIENT_EVAL_MPTR, quotient_eval)
            }

            // Compute quotient commitment
            {
                mstore(0x00, calldataload(LAST_QUOTIENT_X_CPTR))
                mstore(0x20, calldataload(add(LAST_QUOTIENT_X_CPTR, 0x20)))
                let x_n := mload(X_N_MPTR)
                for
                    {
                        let cptr := sub(LAST_QUOTIENT_X_CPTR, 0x40)
                        let cptr_end := sub(FIRST_QUOTIENT_X_CPTR, 0x40)
                    }
                    lt(cptr_end, cptr)
                    {}
                {
                    success := ec_mul_acc(success, x_n)
                    success := ec_add_acc(success, calldataload(cptr), calldataload(add(cptr, 0x20)))
                    cptr := sub(cptr, 0x40)
                }
                mstore(QUOTIENT_X_MPTR, mload(0x00))
                mstore(QUOTIENT_Y_MPTR, mload(0x20))
            }

            // Compute pairing lhs and rhs
            {
                {
                    let x := mload(X_MPTR)
                    let omega := mload(OMEGA_MPTR)
                    let omega_inv := mload(OMEGA_INV_MPTR)
                    let x_pow_of_omega := mulmod(x, omega, R)
                    mstore(0x0420, x_pow_of_omega)
                    mstore(0x0400, x)
                    x_pow_of_omega := mulmod(x, omega_inv, R)
                    mstore(0x03e0, x_pow_of_omega)
                    x_pow_of_omega := mulmod(x_pow_of_omega, omega_inv, R)
                    x_pow_of_omega := mulmod(x_pow_of_omega, omega_inv, R)
                    x_pow_of_omega := mulmod(x_pow_of_omega, omega_inv, R)
                    x_pow_of_omega := mulmod(x_pow_of_omega, omega_inv, R)
                    x_pow_of_omega := mulmod(x_pow_of_omega, omega_inv, R)
                    mstore(0x03c0, x_pow_of_omega)
                }
                {
                    let mu := mload(MU_MPTR)
                    for
                        {
                            let mptr := 0x0440
                            let mptr_end := 0x04c0
                            let point_mptr := 0x03c0
                        }
                        lt(mptr, mptr_end)
                        {
                            mptr := add(mptr, 0x20)
                            point_mptr := add(point_mptr, 0x20)
                        }
                    {
                        mstore(mptr, addmod(mu, sub(R, mload(point_mptr)), R))
                    }
                    let s
                    s := mload(0x0480)
                    mstore(0x04c0, s)
                    let diff
                    diff := mload(0x0440)
                    diff := mulmod(diff, mload(0x0460), R)
                    diff := mulmod(diff, mload(0x04a0), R)
                    mstore(0x04e0, diff)
                    mstore(0x00, diff)
                    diff := mload(0x0440)
                    diff := mulmod(diff, mload(0x04a0), R)
                    mstore(0x0500, diff)
                    diff := mload(0x0440)
                    mstore(0x0520, diff)
                    diff := mload(0x0460)
                    mstore(0x0540, diff)
                    diff := mload(0x0440)
                    diff := mulmod(diff, mload(0x0460), R)
                    mstore(0x0560, diff)
                }
                {
                    let point_2 := mload(0x0400)
                    let coeff
                    coeff := 1
                    coeff := mulmod(coeff, mload(0x0480), R)
                    mstore(0x20, coeff)
                }
                {
                    let point_1 := mload(0x03e0)
                    let point_2 := mload(0x0400)
                    let coeff
                    coeff := addmod(point_1, sub(R, point_2), R)
                    coeff := mulmod(coeff, mload(0x0460), R)
                    mstore(0x40, coeff)
                    coeff := addmod(point_2, sub(R, point_1), R)
                    coeff := mulmod(coeff, mload(0x0480), R)
                    mstore(0x60, coeff)
                }
                {
                    let point_1 := mload(0x03e0)
                    let point_2 := mload(0x0400)
                    let point_3 := mload(0x0420)
                    let coeff
                    coeff := addmod(point_1, sub(R, point_2), R)
                    coeff := mulmod(coeff, addmod(point_1, sub(R, point_3), R), R)
                    coeff := mulmod(coeff, mload(0x0460), R)
                    mstore(0x80, coeff)
                    coeff := addmod(point_2, sub(R, point_1), R)
                    coeff := mulmod(coeff, addmod(point_2, sub(R, point_3), R), R)
                    coeff := mulmod(coeff, mload(0x0480), R)
                    mstore(0xa0, coeff)
                    coeff := addmod(point_3, sub(R, point_1), R)
                    coeff := mulmod(coeff, addmod(point_3, sub(R, point_2), R), R)
                    coeff := mulmod(coeff, mload(0x04a0), R)
                    mstore(0xc0, coeff)
                }
                {
                    let point_0 := mload(0x03c0)
                    let point_2 := mload(0x0400)
                    let point_3 := mload(0x0420)
                    let coeff
                    coeff := addmod(point_0, sub(R, point_2), R)
                    coeff := mulmod(coeff, addmod(point_0, sub(R, point_3), R), R)
                    coeff := mulmod(coeff, mload(0x0440), R)
                    mstore(0xe0, coeff)
                    coeff := addmod(point_2, sub(R, point_0), R)
                    coeff := mulmod(coeff, addmod(point_2, sub(R, point_3), R), R)
                    coeff := mulmod(coeff, mload(0x0480), R)
                    mstore(0x0100, coeff)
                    coeff := addmod(point_3, sub(R, point_0), R)
                    coeff := mulmod(coeff, addmod(point_3, sub(R, point_2), R), R)
                    coeff := mulmod(coeff, mload(0x04a0), R)
                    mstore(0x0120, coeff)
                }
                {
                    let point_2 := mload(0x0400)
                    let point_3 := mload(0x0420)
                    let coeff
                    coeff := addmod(point_2, sub(R, point_3), R)
                    coeff := mulmod(coeff, mload(0x0480), R)
                    mstore(0x0140, coeff)
                    coeff := addmod(point_3, sub(R, point_2), R)
                    coeff := mulmod(coeff, mload(0x04a0), R)
                    mstore(0x0160, coeff)
                }
                {
                    success := batch_invert(success, 0, 0x0180)
                    let diff_0_inv := mload(0x00)
                    mstore(0x04e0, diff_0_inv)
                    for
                        {
                            let mptr := 0x0500
                            let mptr_end := 0x0580
                        }
                        lt(mptr, mptr_end)
                        { mptr := add(mptr, 0x20) }
                    {
                        mstore(mptr, mulmod(mload(mptr), diff_0_inv, R))
                    }
                }
                {
                    let coeff := mload(0x20)
                    let zeta := mload(ZETA_MPTR)
                    let r_eval := 0
                    r_eval := addmod(r_eval, mulmod(coeff, calldataload(0x1124), R), R)
                    r_eval := mulmod(r_eval, zeta, R)
                    r_eval := addmod(r_eval, mulmod(coeff, mload(QUOTIENT_EVAL_MPTR), R), R)
                    for
                        {
                            let mptr := 0x1424
                            let mptr_end := 0x1124
                        }
                        lt(mptr_end, mptr)
                        { mptr := sub(mptr, 0x20) }
                    {
                        r_eval := addmod(mulmod(r_eval, zeta, R), mulmod(coeff, calldataload(mptr), R), R)
                    }
                    for
                        {
                            let mptr := 0x1104
                            let mptr_end := 0x0e04
                        }
                        lt(mptr_end, mptr)
                        { mptr := sub(mptr, 0x20) }
                    {
                        r_eval := addmod(mulmod(r_eval, zeta, R), mulmod(coeff, calldataload(mptr), R), R)
                    }
                    r_eval := mulmod(r_eval, zeta, R)
                    r_eval := addmod(r_eval, mulmod(coeff, calldataload(0x17c4), R), R)
                    r_eval := mulmod(r_eval, zeta, R)
                    r_eval := addmod(r_eval, mulmod(coeff, calldataload(0x1764), R), R)
                    r_eval := mulmod(r_eval, zeta, R)
                    r_eval := addmod(r_eval, mulmod(coeff, calldataload(0x1704), R), R)
                    r_eval := mulmod(r_eval, zeta, R)
                    r_eval := addmod(r_eval, mulmod(coeff, calldataload(0x16a4), R), R)
                    r_eval := mulmod(r_eval, zeta, R)
                    r_eval := addmod(r_eval, mulmod(coeff, calldataload(0x0dc4), R), R)
                    r_eval := mulmod(r_eval, zeta, R)
                    r_eval := addmod(r_eval, mulmod(coeff, calldataload(0x0d84), R), R)
                    for
                        {
                            let mptr := 0x0d44
                            let mptr_end := 0x0c44
                        }
                        lt(mptr_end, mptr)
                        { mptr := sub(mptr, 0x20) }
                    {
                        r_eval := addmod(mulmod(r_eval, zeta, R), mulmod(coeff, calldataload(mptr), R), R)
                    }
                    r_eval := mulmod(r_eval, zeta, R)
                    r_eval := addmod(r_eval, mulmod(coeff, calldataload(0x0be4), R), R)
                    r_eval := mulmod(r_eval, zeta, R)
                    r_eval := addmod(r_eval, mulmod(coeff, calldataload(0x0b44), R), R)
                    for
                        {
                            let mptr := 0x0b04
                            let mptr_end := 0x0a84
                        }
                        lt(mptr_end, mptr)
                        { mptr := sub(mptr, 0x20) }
                    {
                        r_eval := addmod(mulmod(r_eval, zeta, R), mulmod(coeff, calldataload(mptr), R), R)
                    }
                    mstore(0x0580, r_eval)
                }
                {
                    let zeta := mload(ZETA_MPTR)
                    let r_eval := 0
                    r_eval := addmod(r_eval, mulmod(mload(0x40), calldataload(0x0e04), R), R)
                    r_eval := addmod(r_eval, mulmod(mload(0x60), calldataload(0x0da4), R), R)
                    r_eval := mulmod(r_eval, zeta, R)
                    r_eval := addmod(r_eval, mulmod(mload(0x40), calldataload(0x0de4), R), R)
                    r_eval := addmod(r_eval, mulmod(mload(0x60), calldataload(0x0d64), R), R)
                    r_eval := mulmod(r_eval, zeta, R)
                    r_eval := addmod(r_eval, mulmod(mload(0x40), calldataload(0x0c44), R), R)
                    r_eval := addmod(r_eval, mulmod(mload(0x60), calldataload(0x0b24), R), R)
                    r_eval := mulmod(r_eval, mload(0x0500), R)
                    mstore(0x05a0, r_eval)
                }
                {
                    let zeta := mload(ZETA_MPTR)
                    let r_eval := 0
                    r_eval := addmod(r_eval, mulmod(mload(0x80), calldataload(0x0c04), R), R)
                    r_eval := addmod(r_eval, mulmod(mload(0xa0), calldataload(0x0b84), R), R)
                    r_eval := addmod(r_eval, mulmod(mload(0xc0), calldataload(0x0bc4), R), R)
                    r_eval := mulmod(r_eval, zeta, R)
                    r_eval := addmod(r_eval, mulmod(mload(0x80), calldataload(0x0c24), R), R)
                    r_eval := addmod(r_eval, mulmod(mload(0xa0), calldataload(0x0b64), R), R)
                    r_eval := addmod(r_eval, mulmod(mload(0xc0), calldataload(0x0ba4), R), R)
                    r_eval := mulmod(r_eval, mload(0x0520), R)
                    mstore(0x05c0, r_eval)
                }
                {
                    let zeta := mload(ZETA_MPTR)
                    let r_eval := 0
                    r_eval := addmod(r_eval, mulmod(mload(0xe0), calldataload(0x1604), R), R)
                    r_eval := addmod(r_eval, mulmod(mload(0x0100), calldataload(0x15c4), R), R)
                    r_eval := addmod(r_eval, mulmod(mload(0x0120), calldataload(0x15e4), R), R)
                    r_eval := mulmod(r_eval, zeta, R)
                    r_eval := addmod(r_eval, mulmod(mload(0xe0), calldataload(0x15a4), R), R)
                    r_eval := addmod(r_eval, mulmod(mload(0x0100), calldataload(0x1564), R), R)
                    r_eval := addmod(r_eval, mulmod(mload(0x0120), calldataload(0x1584), R), R)
                    r_eval := mulmod(r_eval, zeta, R)
                    r_eval := addmod(r_eval, mulmod(mload(0xe0), calldataload(0x1544), R), R)
                    r_eval := addmod(r_eval, mulmod(mload(0x0100), calldataload(0x1504), R), R)
                    r_eval := addmod(r_eval, mulmod(mload(0x0120), calldataload(0x1524), R), R)
                    r_eval := mulmod(r_eval, zeta, R)
                    r_eval := addmod(r_eval, mulmod(mload(0xe0), calldataload(0x14e4), R), R)
                    r_eval := addmod(r_eval, mulmod(mload(0x0100), calldataload(0x14a4), R), R)
                    r_eval := addmod(r_eval, mulmod(mload(0x0120), calldataload(0x14c4), R), R)
                    r_eval := mulmod(r_eval, zeta, R)
                    r_eval := addmod(r_eval, mulmod(mload(0xe0), calldataload(0x1484), R), R)
                    r_eval := addmod(r_eval, mulmod(mload(0x0100), calldataload(0x1444), R), R)
                    r_eval := addmod(r_eval, mulmod(mload(0x0120), calldataload(0x1464), R), R)
                    r_eval := mulmod(r_eval, mload(0x0540), R)
                    mstore(0x05e0, r_eval)
                }
                {
                    let zeta := mload(ZETA_MPTR)
                    let r_eval := 0
                    r_eval := addmod(r_eval, mulmod(mload(0x0140), calldataload(0x1784), R), R)
                    r_eval := addmod(r_eval, mulmod(mload(0x0160), calldataload(0x17a4), R), R)
                    r_eval := mulmod(r_eval, zeta, R)
                    r_eval := addmod(r_eval, mulmod(mload(0x0140), calldataload(0x1724), R), R)
                    r_eval := addmod(r_eval, mulmod(mload(0x0160), calldataload(0x1744), R), R)
                    r_eval := mulmod(r_eval, zeta, R)
                    r_eval := addmod(r_eval, mulmod(mload(0x0140), calldataload(0x16c4), R), R)
                    r_eval := addmod(r_eval, mulmod(mload(0x0160), calldataload(0x16e4), R), R)
                    r_eval := mulmod(r_eval, zeta, R)
                    r_eval := addmod(r_eval, mulmod(mload(0x0140), calldataload(0x1664), R), R)
                    r_eval := addmod(r_eval, mulmod(mload(0x0160), calldataload(0x1684), R), R)
                    r_eval := mulmod(r_eval, zeta, R)
                    r_eval := addmod(r_eval, mulmod(mload(0x0140), calldataload(0x1624), R), R)
                    r_eval := addmod(r_eval, mulmod(mload(0x0160), calldataload(0x1644), R), R)
                    r_eval := mulmod(r_eval, mload(0x0560), R)
                    mstore(0x0600, r_eval)
                }
                {
                    let sum := mload(0x20)
                    mstore(0x0620, sum)
                }
                {
                    let sum := mload(0x40)
                    sum := addmod(sum, mload(0x60), R)
                    mstore(0x0640, sum)
                }
                {
                    let sum := mload(0x80)
                    sum := addmod(sum, mload(0xa0), R)
                    sum := addmod(sum, mload(0xc0), R)
                    mstore(0x0660, sum)
                }
                {
                    let sum := mload(0xe0)
                    sum := addmod(sum, mload(0x0100), R)
                    sum := addmod(sum, mload(0x0120), R)
                    mstore(0x0680, sum)
                }
                {
                    let sum := mload(0x0140)
                    sum := addmod(sum, mload(0x0160), R)
                    mstore(0x06a0, sum)
                }
                {
                    for
                        {
                            let mptr := 0x00
                            let mptr_end := 0xa0
                            let sum_mptr := 0x0620
                        }
                        lt(mptr, mptr_end)
                        {
                            mptr := add(mptr, 0x20)
                            sum_mptr := add(sum_mptr, 0x20)
                        }
                    {
                        mstore(mptr, mload(sum_mptr))
                    }
                    success := batch_invert(success, 0, 0xa0)
                    let r_eval := mulmod(mload(0x80), mload(0x0600), R)
                    for
                        {
                            let sum_inv_mptr := 0x60
                            let sum_inv_mptr_end := 0xa0
                            let r_eval_mptr := 0x05e0
                        }
                        lt(sum_inv_mptr, sum_inv_mptr_end)
                        {
                            sum_inv_mptr := sub(sum_inv_mptr, 0x20)
                            r_eval_mptr := sub(r_eval_mptr, 0x20)
                        }
                    {
                        r_eval := mulmod(r_eval, mload(NU_MPTR), R)
                        r_eval := addmod(r_eval, mulmod(mload(sum_inv_mptr), mload(r_eval_mptr), R), R)
                    }
                    mstore(R_EVAL_MPTR, r_eval)
                }
                {
                    let nu := mload(NU_MPTR)
                    mstore(0x00, calldataload(0x0924))
                    mstore(0x20, calldataload(0x0944))
                    success := ec_mul_acc(success, mload(ZETA_MPTR))
                    success := ec_add_acc(success, mload(QUOTIENT_X_MPTR), mload(QUOTIENT_Y_MPTR))
                    for
                        {
                            let mptr := 0x1bc0
                            let mptr_end := 0x1100
                        }
                        lt(mptr_end, mptr)
                        { mptr := sub(mptr, 0x40) }
                    {
                        success := ec_mul_acc(success, mload(ZETA_MPTR))
                        success := ec_add_acc(success, mload(mptr), mload(add(mptr, 0x20)))
                    }
                    success := ec_mul_acc(success, mload(ZETA_MPTR))
                    success := ec_add_acc(success, mload(0x1080), mload(0x10a0))
                    success := ec_mul_acc(success, mload(ZETA_MPTR))
                    success := ec_add_acc(success, mload(0x1040), mload(0x1060))
                    success := ec_mul_acc(success, mload(ZETA_MPTR))
                    success := ec_add_acc(success, mload(0x1100), mload(0x1120))
                    success := ec_mul_acc(success, mload(ZETA_MPTR))
                    success := ec_add_acc(success, mload(0x10c0), mload(0x10e0))
                    success := ec_mul_acc(success, mload(ZETA_MPTR))
                    success := ec_add_acc(success, mload(0x1000), mload(0x1020))
                    for
                        {
                            let mptr := 0x0664
                            let mptr_end := 0x0524
                        }
                        lt(mptr_end, mptr)
                        { mptr := sub(mptr, 0x40) }
                    {
                        success := ec_mul_acc(success, mload(ZETA_MPTR))
                        success := ec_add_acc(success, calldataload(mptr), calldataload(add(mptr, 0x20)))
                    }
                    success := ec_mul_acc(success, mload(ZETA_MPTR))
                    success := ec_add_acc(success, calldataload(0x03e4), calldataload(0x0404))
                    for
                        {
                            let mptr := 0x04e4
                            let mptr_end := 0x03e4
                        }
                        lt(mptr_end, mptr)
                        { mptr := sub(mptr, 0x40) }
                    {
                        success := ec_mul_acc(success, mload(ZETA_MPTR))
                        success := ec_add_acc(success, calldataload(mptr), calldataload(add(mptr, 0x20)))
                    }
                    for
                        {
                            let mptr := 0x0364
                            let mptr_end := 0x0224
                        }
                        lt(mptr_end, mptr)
                        { mptr := sub(mptr, 0x40) }
                    {
                        success := ec_mul_acc(success, mload(ZETA_MPTR))
                        success := ec_add_acc(success, calldataload(mptr), calldataload(add(mptr, 0x20)))
                    }
                    success := ec_mul_acc(success, mload(ZETA_MPTR))
                    success := ec_add_acc(success, calldataload(0x01a4), calldataload(0x01c4))
                    for
                        {
                            let mptr := 0x0124
                            let mptr_end := 0x24
                        }
                        lt(mptr_end, mptr)
                        { mptr := sub(mptr, 0x40) }
                    {
                        success := ec_mul_acc(success, mload(ZETA_MPTR))
                        success := ec_add_acc(success, calldataload(mptr), calldataload(add(mptr, 0x20)))
                    }
                    mstore(0x80, calldataload(0x0524))
                    mstore(0xa0, calldataload(0x0544))
                    success := ec_mul_tmp(success, mload(ZETA_MPTR))
                    success := ec_add_tmp(success, calldataload(0x03a4), calldataload(0x03c4))
                    success := ec_mul_tmp(success, mload(ZETA_MPTR))
                    success := ec_add_tmp(success, calldataload(0x0164), calldataload(0x0184))
                    success := ec_mul_tmp(success, mulmod(nu, mload(0x0500), R))
                    success := ec_add_acc(success, mload(0x80), mload(0xa0))
                    nu := mulmod(nu, mload(NU_MPTR), R)
                    mstore(0x80, calldataload(0x0224))
                    mstore(0xa0, calldataload(0x0244))
                    success := ec_mul_tmp(success, mload(ZETA_MPTR))
                    success := ec_add_tmp(success, calldataload(0x01e4), calldataload(0x0204))
                    success := ec_mul_tmp(success, mulmod(nu, mload(0x0520), R))
                    success := ec_add_acc(success, mload(0x80), mload(0xa0))
                    nu := mulmod(nu, mload(NU_MPTR), R)
                    mstore(0x80, calldataload(0x07a4))
                    mstore(0xa0, calldataload(0x07c4))
                    for
                        {
                            let mptr := 0x0764
                            let mptr_end := 0x0664
                        }
                        lt(mptr_end, mptr)
                        { mptr := sub(mptr, 0x40) }
                    {
                        success := ec_mul_tmp(success, mload(ZETA_MPTR))
                        success := ec_add_tmp(success, calldataload(mptr), calldataload(add(mptr, 0x20)))
                    }
                    success := ec_mul_tmp(success, mulmod(nu, mload(0x0540), R))
                    success := ec_add_acc(success, mload(0x80), mload(0xa0))
                    nu := mulmod(nu, mload(NU_MPTR), R)
                    mstore(0x80, calldataload(0x08e4))
                    mstore(0xa0, calldataload(0x0904))
                    for
                        {
                            let mptr := 0x08a4
                            let mptr_end := 0x07a4
                        }
                        lt(mptr_end, mptr)
                        { mptr := sub(mptr, 0x40) }
                    {
                        success := ec_mul_tmp(success, mload(ZETA_MPTR))
                        success := ec_add_tmp(success, calldataload(mptr), calldataload(add(mptr, 0x20)))
                    }
                    success := ec_mul_tmp(success, mulmod(nu, mload(0x0560), R))
                    success := ec_add_acc(success, mload(0x80), mload(0xa0))
                    mstore(0x80, mload(G1_X_MPTR))
                    mstore(0xa0, mload(G1_Y_MPTR))
                    success := ec_mul_tmp(success, sub(R, mload(R_EVAL_MPTR)))
                    success := ec_add_acc(success, mload(0x80), mload(0xa0))
                    mstore(0x80, calldataload(0x17e4))
                    mstore(0xa0, calldataload(0x1804))
                    success := ec_mul_tmp(success, sub(R, mload(0x04c0)))
                    success := ec_add_acc(success, mload(0x80), mload(0xa0))
                    mstore(0x80, calldataload(0x1824))
                    mstore(0xa0, calldataload(0x1844))
                    success := ec_mul_tmp(success, mload(MU_MPTR))
                    success := ec_add_acc(success, mload(0x80), mload(0xa0))
                    mstore(PAIRING_LHS_X_MPTR, mload(0x00))
                    mstore(PAIRING_LHS_Y_MPTR, mload(0x20))
                    mstore(PAIRING_RHS_X_MPTR, calldataload(0x1824))
                    mstore(PAIRING_RHS_Y_MPTR, calldataload(0x1844))
                }
            }

            // Random linear combine with accumulator
            if mload(HAS_ACCUMULATOR_MPTR) {
                mstore(0x00, mload(ACC_LHS_X_MPTR))
                mstore(0x20, mload(ACC_LHS_Y_MPTR))
                mstore(0x40, mload(ACC_RHS_X_MPTR))
                mstore(0x60, mload(ACC_RHS_Y_MPTR))
                mstore(0x80, mload(PAIRING_LHS_X_MPTR))
                mstore(0xa0, mload(PAIRING_LHS_Y_MPTR))
                mstore(0xc0, mload(PAIRING_RHS_X_MPTR))
                mstore(0xe0, mload(PAIRING_RHS_Y_MPTR))
                let challenge := mod(keccak256(0x00, 0x100), r)

                // [pairing_lhs] += challenge * [acc_lhs]
                success := ec_mul_acc(success, challenge)
                success := ec_add_acc(success, mload(PAIRING_LHS_X_MPTR), mload(PAIRING_LHS_Y_MPTR))
                mstore(PAIRING_LHS_X_MPTR, mload(0x00))
                mstore(PAIRING_LHS_Y_MPTR, mload(0x20))

                // [pairing_rhs] += challenge * [acc_rhs]
                mstore(0x00, mload(ACC_RHS_X_MPTR))
                mstore(0x20, mload(ACC_RHS_Y_MPTR))
                success := ec_mul_acc(success, challenge)
                success := ec_add_acc(success, mload(PAIRING_RHS_X_MPTR), mload(PAIRING_RHS_Y_MPTR))
                mstore(PAIRING_RHS_X_MPTR, mload(0x00))
                mstore(PAIRING_RHS_Y_MPTR, mload(0x20))
            }

            // Perform pairing
            success := ec_pairing(
                success,
                mload(PAIRING_LHS_X_MPTR),
                mload(PAIRING_LHS_Y_MPTR),
                mload(PAIRING_RHS_X_MPTR),
                mload(PAIRING_RHS_Y_MPTR)
            )

            // Revert if anything fails
            if iszero(success) {
                revert(0x00, 0x00)
            }

            // Return 1 as result if everything succeeds
            mstore(0x00, 1)
            return(0x00, 0x20)
        }
    }
}