#!/usr/bin/env bash
# Prints the artifact hash (scripts/artifact-hash.sh) of the agent bundle
# inside a built image, comparable with `scripts/artifact-hash.sh
# agent/dist/main.js`: equal hashes mean the image runs the tested bundle.
# Usage: scripts/image-bundle-hash.sh <image>
set -euo pipefail

image="${1:?usage: image-bundle-hash.sh <image>}"
hash_script="$(cd "$(dirname "$0")" && pwd)/artifact-hash.sh"
work=$(mktemp -d)
container=$(docker create "$image")
trap 'docker rm -f "$container" >/dev/null; rm -rf "$work"' EXIT

mkdir -p "$work/agent/dist"
docker cp -q "$container:/app/main.js" "$work/agent/dist/main.js"
(cd "$work" && "$hash_script" agent/dist/main.js)
