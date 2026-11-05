#!/usr/bin/env bash
# Prints one sha256 over every file under the given paths (hidden files
# included): each file's path, as given relative to the current directory, and
# its bytes. CI hashes the build it tested and the copy each deploy job ships;
# equal hashes mean the deploy is byte-identical to the tested artifact.
# Usage: scripts/artifact-hash.sh <file-or-directory>...
set -euo pipefail

(( $# )) || { echo "usage: artifact-hash.sh <file-or-directory>..." >&2; exit 2; }

manifest=$(
  for path in "$@"; do
    [[ -e "$path" ]] || { echo "artifact-hash: $path doesn't exist" >&2; exit 1; }
    found=$(find "$path" -type f | wc -l)
    (( found )) || { echo "artifact-hash: $path holds no files" >&2; exit 1; }
    find "$path" -type f -print0
  done | LC_ALL=C sort -z | xargs -0 sha256sum --
)

sha256sum <<<"$manifest" | cut -d' ' -f1
