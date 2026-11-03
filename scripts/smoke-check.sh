#!/usr/bin/env bash
# Post-deploy smoke check: the site answers 200 with the real page, and every
# redirect host answers 301 (over http and https) and ends on the site.
# Usage: scripts/smoke-check.sh <site-url> [redirect-host...]
set -uo pipefail

site="${1:?usage: smoke-check.sh <site-url> [redirect-host...]}"
site="${site%/}"
shift
failures=0

# retry CMD...: runs CMD up to 5 times, 10 s apart, until it succeeds.
retry() {
  local attempt
  for attempt in 1 2 3 4 5; do
    "$@" && return 0
    [[ $attempt -lt 5 ]] && sleep "${SMOKE_RETRY_DELAY:-10}"
  done
  return 1
}

check_site() {
  local page
  page=$(curl -fsS --max-time 20 "$site/") || { echo "  $site/ is down"; return 1; }
  grep -q "Alberto Carbonell" <<<"$page" || { echo "  $site/ doesn't contain the expected content"; return 1; }
}

check_redirect() {
  local from="$1" first final
  first=$(curl -s -o /dev/null --max-time 20 -w '%{http_code}' "$from") || first=000
  final=$(curl -s -o /dev/null -L --max-time 30 -w '%{http_code} %{url_effective}' "$from") || final="000 $from"
  if [[ "$first" != 301 ]]; then
    echo "  $from answered $first, expected 301"; return 1
  fi
  if [[ "$final" != "200 $site/" ]]; then
    echo "  $from ended at '$final', expected '200 $site/'"; return 1
  fi
}

if retry check_site; then echo "ok    $site/"; else echo "FAIL  $site/"; failures=$((failures + 1)); fi

for host in "$@"; do
  for scheme in http https; do
    if retry check_redirect "$scheme://$host/"; then
      echo "ok    $scheme://$host/ -> $site/"
    else
      echo "FAIL  $scheme://$host/"; failures=$((failures + 1))
    fi
  done
done

if (( failures )); then
  echo "::error::smoke check failed ($failures check(s))"
  exit 1
fi
