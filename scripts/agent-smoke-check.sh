#!/usr/bin/env bash
# Post-deploy smoke check for the agent service. Never calls the model: the
# chat checks stop at CORS and request validation, so a deploy costs nothing.
# Usage: scripts/agent-smoke-check.sh <agent-url> <site-origin>
set -uo pipefail

agent="${1:?usage: agent-smoke-check.sh <agent-url> <site-origin>}"
agent="${agent%/}"
origin="${2:?usage: agent-smoke-check.sh <agent-url> <site-origin>}"
tools=(get_profile get_experience get_projects get_stack get_contact)
failures=0

# retry CMD...: runs CMD up to 5 times, 10 s apart (covers a cold start).
retry() {
  local attempt
  for attempt in 1 2 3 4 5; do
    "$@" && return 0
    [[ $attempt -lt 5 ]] && sleep "${SMOKE_RETRY_DELAY:-10}"
  done
  return 1
}

check_health() {
  local body
  body=$(curl -fsS --max-time 20 "$agent/health") || { echo "  /health is down"; return 1; }
  [[ "$body" == '{"status":"ok"}' ]] || { echo "  /health answered $body"; return 1; }
}

check_mcp_tools() {
  local body tool
  body=$(curl -fsS --max-time 20 "$agent/mcp" \
    -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' \
    -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}') || { echo "  /mcp tools/list failed"; return 1; }
  for tool in "${tools[@]}"; do
    grep -q "\"name\":\"$tool\"" <<<"$body" || { echo "  /mcp doesn't list $tool"; return 1; }
  done
}

check_chat_cors() {
  local allowed
  allowed=$(curl -sS --max-time 20 -o /dev/null -D - -X OPTIONS "$agent/chat" \
    -H "origin: $origin" -H 'access-control-request-method: POST' \
    -H 'access-control-request-headers: content-type' |
    tr -d '\r' | awk -F': ' 'tolower($1) == "access-control-allow-origin" { print $2 }')
  [[ "$allowed" == "$origin" ]] || { echo "  /chat doesn't allow $origin (got '$allowed')"; return 1; }
}

check_chat_validation() {
  local status
  status=$(curl -sS --max-time 20 -o /dev/null -w '%{http_code}' "$agent/chat" \
    -H 'content-type: application/json' -d '{"messages":[]}')
  [[ "$status" == 400 ]] || { echo "  /chat answered $status to an invalid request, expected 400"; return 1; }
}

for check in check_health check_mcp_tools check_chat_cors check_chat_validation; do
  if retry "$check"; then echo "ok    $check"; else echo "FAIL  $check"; failures=$((failures + 1)); fi
done

if (( failures )); then
  echo "::error::agent smoke check failed ($failures check(s))"
  exit 1
fi
