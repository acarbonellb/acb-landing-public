#!/usr/bin/env bash
# Post-deploy smoke check for the agent service. Never calls the model: the
# chat checks stop at CORS and request validation, so a deploy costs nothing.
# MCP is checked both on the agent's URL and on the site's domain, through the
# Firebase Hosting `/mcp` rewrite, unless `--agent-only`: a revision deployed
# with no traffic (its tag URL) isn't what the rewrite reaches yet.
# Usage: scripts/agent-smoke-check.sh [--agent-only] <agent-url> <site-origin>
set -uo pipefail

site_mcp=true
if [[ "${1:-}" == --agent-only ]]; then site_mcp=false; shift; fi
agent="${1:?usage: agent-smoke-check.sh [--agent-only] <agent-url> <site-origin>}"
agent="${agent%/}"
origin="${2:?usage: agent-smoke-check.sh [--agent-only] <agent-url> <site-origin>}"
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

# mcp_lists_tools URL: URL answers MCP tools/list with the five tools.
mcp_lists_tools() {
  local body tool
  body=$(curl -fsS --max-time 20 "$1" \
    -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' \
    -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}') || { echo "  $1 tools/list failed"; return 1; }
  for tool in "${tools[@]}"; do
    grep -q "\"name\":\"$tool\"" <<<"$body" || { echo "  $1 doesn't list $tool"; return 1; }
  done
}

check_mcp_tools() { mcp_lists_tools "$agent/mcp"; }

check_site_mcp_tools() { mcp_lists_tools "${origin%/}/mcp"; }

# get_contact gives out the address from the CONTACT_EMAIL secret. Checks it's
# there and address-shaped, and never prints it: Actions logs are public.
check_contact_email() {
  local body
  body=$(curl -fsS --max-time 20 "$agent/mcp" \
    -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' \
    -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"get_contact","arguments":{}}}') ||
    { echo "  get_contact call failed"; return 1; }
  grep -qE '"structuredContent":\{[^}]*"email":"[^"@[:space:]]+@[^"@[:space:]]+\.[^"@[:space:]]+"' <<<"$body" ||
    { echo "  get_contact returns no email (is the CONTACT_EMAIL secret set?)"; return 1; }
}

check_chat_cors() {
  local allowed
  allowed=$(curl -sS --max-time 20 -o /dev/null -D - -X OPTIONS "$agent/chat" \
    -H "origin: $origin" -H 'access-control-request-method: POST' \
    -H 'access-control-request-headers: content-type' |
    tr -d '\r' | awk -F': ' 'tolower($1) == "access-control-allow-origin" { print $2 }')
  [[ "$allowed" == "$origin" ]] || { echo "  /chat doesn't allow $origin (got '$allowed')"; return 1; }
}

# /stats: the weekly usage JSON, readable from any origin (only reads Firestore).
check_stats() {
  local response allowed body
  response=$(curl -fsS --max-time 20 -D - -H "origin: $origin" "$agent/stats" | tr -d '\r') ||
    { echo "  /stats failed"; return 1; }
  allowed=$(awk -F': ' 'tolower($1) == "access-control-allow-origin" { print $2 }' <<<"$response")
  [[ "$allowed" == "*" ]] || { echo "  /stats doesn't allow any origin (got '$allowed')"; return 1; }
  body=$(tail -n 1 <<<"$response")
  grep -q '"current":{"week":"' <<<"$body" && grep -q '"previous":{"week":"' <<<"$body" ||
    { echo "  /stats answered $body"; return 1; }
}

check_chat_validation() {
  local status
  status=$(curl -sS --max-time 20 -o /dev/null -w '%{http_code}' "$agent/chat" \
    -H 'content-type: application/json' -d '{"messages":[]}')
  [[ "$status" == 400 ]] || { echo "  /chat answered $status to an invalid request, expected 400"; return 1; }
}

checks=(check_health check_mcp_tools check_contact_email check_stats check_chat_cors check_chat_validation)
$site_mcp && checks+=(check_site_mcp_tools)

for check in "${checks[@]}"; do
  if retry "$check"; then echo "ok    $check"; else echo "FAIL  $check"; failures=$((failures + 1)); fi
done

if (( failures )); then
  echo "::error::agent smoke check failed ($failures check(s))"
  exit 1
fi
