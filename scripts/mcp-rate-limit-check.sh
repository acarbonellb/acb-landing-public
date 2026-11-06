#!/usr/bin/env bash
# Production check for the per-IP /mcp rate limit through the Firebase Hosting
# rewrite, which only a live deploy shows. Run by hand, once after a deploy
# that touches the limit or the client-IP rule; never in CI, as it uses up the caller's own one-minute window.
#   1. through the site: MCP calls to <site-url>/mcp until one is refused;
#   2. direct to the agent: one call to <agent-url>/mcp, which must be refused
#      too (same visitor, same key);
#   3. forged X-Forwarded-For: calls to both URLs with made-up addresses, which
#      must all be refused (forging the header doesn't buy a fresh window).
# Prints allowed/refused counts and status codes per phase, never a URL or an
# address, so the output can be pasted into an issue. Exits 1 if a phase fails.
# Usage: scripts/mcp-rate-limit-check.sh <site-url> <agent-url> [per-ip-limit]
# The limit defaults to RATE_LIMIT_MCP_PER_MINUTE, else the code default.
set -uo pipefail

usage="usage: mcp-rate-limit-check.sh <site-url> <agent-url> [per-ip-limit]"
site="${1:?$usage}"
site="${site%/}"
agent="${2:?$usage}"
agent="${agent%/}"
config="$(dirname "$0")/../agent/src/config.ts"
default_limit=$(sed -n 's/.*RATE_LIMIT_MCP_PER_MINUTE: intFromEnv.default(\([0-9]*\)).*/\1/p' "$config" 2>/dev/null)
limit="${3:-${RATE_LIMIT_MCP_PER_MINUTE:-$default_limit}}"
[[ "$limit" =~ ^[1-9][0-9]*$ ]] || { echo "can't tell the /mcp limit: pass it as the third argument"; exit 2; }
forged_calls=5 # per URL
min_window_left=10 # seconds phases 2 and 3 need once phase 1 is refused
failures=0

# call URL [FORWARDED_FOR]: one MCP tools/list; prints "<status> <retry-after>".
call() {
  local forged=()
  [[ -n "${2:-}" ]] && forged=(-H "x-forwarded-for: $2")
  curl -sS --max-time 20 -o /dev/null -w '%{http_code} %header{retry-after}' "$1/mcp" \
    -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' \
    "${forged[@]}" -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' 2>/dev/null
}

# A made-up client address: IPv4, an IPv6 in a new /64, or a two-entry chain.
forged_address() {
  local v4="$((RANDOM % 223 + 1)).$((RANDOM % 256)).$((RANDOM % 256)).$((RANDOM % 254 + 1))"
  case $(($1 % 3)) in
    0) echo "$v4" ;;
    1) printf '2%03x:%x:%x:%x::%x\n' $((RANDOM % 4096)) $RANDOM $RANDOM $RANDOM $((RANDOM % 255 + 1)) ;;
    2) echo "$v4, $((RANDOM % 223 + 1)).$((RANDOM % 256)).$((RANDOM % 256)).$((RANDOM % 254 + 1))" ;;
  esac
}

# report OK PHASE STATUS...: one line with the phase's counts.
report() {
  local ok=$1 phase=$2 allowed=0 refused=0 status codes
  shift 2
  for status in "$@"; do
    [[ $status == 200 ]] && allowed=$((allowed + 1))
    [[ $status == 429 ]] && refused=$((refused + 1))
  done
  codes=$(printf '%s\n' "$@" | sort | uniq -c | awk '{ printf "%s%s×%s", (NR > 1 ? " " : ""), $2, $1 }')
  if ((ok)); then printf 'ok    '; else printf 'FAIL  '; failures=$((failures + 1)); fi
  echo "$phase: $allowed allowed, $refused refused ($codes)"
}

# /health isn't rate limited: wakes a scaled-to-zero service first.
curl -fsS --max-time 30 -o /dev/null "$agent/health" 2>/dev/null || { echo "the agent's /health is down"; exit 2; }

# Phase 1: until refused. A window can open mid-burst, so allow for two.
for attempt in 1 2 3; do
  statuses=()
  retry_after=""
  for ((i = 0; i < 2 * limit + 5; i++)); do
    read -r status retry_after <<<"$(call "$site")"
    statuses+=("$status")
    [[ $status == 429 ]] && break
  done
  [[ $status != 429 || ${retry_after:-0} -ge $min_window_left || $attempt == 3 ]] && break
  echo "      the window ends in ${retry_after}s: waiting for the next one and starting again"
  sleep "$((retry_after + 1))"
done
refused_through_site=0
[[ $status == 429 ]] && refused_through_site=1
report "$refused_through_site" "through the site" "${statuses[@]}"
((refused_through_site)) || { echo "      never refused in $((2 * limit + 5)) calls (limit $limit)"; exit 1; }

# Phase 2: the same visitor, straight to the agent's URL.
read -r status _ <<<"$(call "$agent")"
report "$([[ $status == 429 ]] && echo 1 || echo 0)" "direct to the agent" "$status"

# Phase 3: forged headers, through the site and direct.
statuses=()
for ((i = 0; i < forged_calls; i++)); do
  for url in "$site" "$agent"; do
    read -r status _ <<<"$(call "$url" "$(forged_address "$i")")"
    statuses+=("$status")
  done
done
all_refused=1
for status in "${statuses[@]}"; do [[ $status == 429 ]] || all_refused=0; done
report "$all_refused" "forged X-Forwarded-For" "${statuses[@]}"

echo "      per-IP /mcp limit: $limit a minute"
if ((failures)); then
  echo "the /mcp rate limit check failed ($failures phase(s))"
  exit 1
fi
