#!/usr/bin/env bash
# Regenerate the event topic0 constants in src/chain.js.
#
# These are load-bearing and fail SILENTLY when wrong — a bad topic matches no
# logs, so the indexer runs clean and the board just looks empty. Never hand-type
# them. Run this after any change to an event signature and paste the output.
set -euo pipefail
cd "$(dirname "$0")/../.."

echo "Event signatures in the compiled ABI:"
jq -r '.abi[] | select(.type=="event") | .name + "(" + ([.inputs[].type] | join(",")) + ")"' \
    out/Plaintext.sol/Plaintext.json

echo
echo "topic0 for the ones the indexer watches:"
for sig in "Entered(address,string,bool)" \
           "Posted(address,uint256,uint256,string)" \
           "Tipped(address,address,uint256,uint256)"; do
    printf '  %-46s %s\n' "$sig" "$(cast keccak "$sig")"
done
