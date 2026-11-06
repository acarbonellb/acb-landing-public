#!/usr/bin/env bash
# Cloud Monitoring alerts on the agent's alert events: one email
# notification channel and one log-based alert policy per alert event
# (docs/logs-and-alerts.md). Run by the owner, by hand; never in CI.
#
#   setup [--dry-run] <project-id> <email>
#       Creates the channel and the policies, or updates them in place when
#       they exist (matched by display name), so re-running it after a change
#       or a rebuilt project converges on the same set. --dry-run runs no gcloud
#       command: it prints every command the setup would run, and the channel
#       and policy files it would pass.
#   test [--dry-run] <project-id> [event]
#       Writes one synthetic log entry for `event` (default store_unavailable)
#       as if the agent had logged it, so its policy fires and emails the
#       channel (within a few minutes). The entry carries "test": true.
#
# The email address is only ever an argument: it goes to gcloud in a temporary
# file (mode 600, deleted on exit), never on a command line, and this script
# never prints it. The channel and policies hold no address beyond the
# channel's own label. Needs gcloud's beta component (notification channels
# have no GA command): gcloud components install beta.
set -euo pipefail

usage() {
  echo "usage: monitoring-alerts.sh setup [--dry-run] <project-id> <email>" >&2
  echo "       monitoring-alerts.sh test [--dry-run] <project-id> [event]" >&2
  exit 2
}

service=agent # the Cloud Run service whose logs the policies match
region=europe-southwest1 # only used for the test entry's resource labels
channel_name="Agent alerts (email)"
docs_url="https://github.com/acarbonellb/acb-landing-public/blob/main/docs/logs-and-alerts.md#alert-events"
rate_limit=300s # at most one email per policy per 5 minutes (the API's minimum)
auto_close=1800s # an incident closes itself after 30 minutes without a match

# One row per alert event: event|severity|policy summary|labels (key=jsonPayload field)|what to do.
# ${log.extracted_label.KEY} is Cloud Monitoring's documentation variable, not bash's.
# shellcheck disable=SC2016
alerts=(
  'spend_threshold|WARNING|The month'"'"'s model spend crossed ${log.extracted_label.threshold_percent}% of the spend cap|threshold_percent=thresholdPercent month=month spent_usd=spentUsd cap_usd=capUsd|Spend so far: USD ${log.extracted_label.spent_usd} of ${log.extracted_label.cap_usd} (${log.extracted_label.month}). Check the usage stats for unusual traffic; raise MONTHLY_SPEND_CAP_USD only on purpose.'
  'spend_cap_reached|ERROR|The spend cap refused a chat request: chat is closed until next month|month=month spent_usd=spentUsd cap_usd=capUsd resets_at=resetsAt|Spent USD ${log.extracted_label.spent_usd} of ${log.extracted_label.cap_usd} in ${log.extracted_label.month}; chat reopens at ${log.extracted_label.resets_at}. Check the usage stats for unusual traffic; raise MONTHLY_SPEND_CAP_USD only on purpose.'
  'provider_limit|ERROR|The model provider refused a call on its own spend or credit limit|month=month|Chat fails until the provider account has credit or a higher limit. provider_limit_cleared is logged on the next successful model call.'
  'chat_error_rate|ERROR|Chat error rate above ${log.extracted_label.threshold} over the last hour|error_rate=errorRate errors=errors streamed=streamed threshold=threshold week=week|${log.extracted_label.errors} of ${log.extracted_label.streamed} streamed chat requests in the last hour ended in an error. Look at chat_failed and chat_request lines (outcome error:*) in Cloud Logging. chat_error_rate_recovered is logged once it is back under the threshold.'
  'store_unavailable|ERROR|The agent'"'"'s shared store is failing (${log.extracted_label.collection})|collection=collection|Firestore updates fail: rate limits and the spend cap fail open or closed per route (docs/guardrails.md). Look at store_error lines in Cloud Logging. store_recovered is logged on the next successful update.'
)

dry_run=false
command="${1:-}"
[[ "$command" == setup || "$command" == test ]] || usage
shift
if [[ "${1:-}" == --dry-run ]]; then dry_run=true; shift; fi
project="${1:-}"
[[ "$project" =~ ^[a-z][a-z0-9-]{4,28}[a-z0-9]$ ]] || usage

# show ARG...: a command as it can be pasted into a shell.
show() {
  local out=() arg
  for arg in "$@"; do
    if [[ "$arg" =~ ^[A-Za-z0-9_./:=,@%+-]+$ ]]; then out+=("$arg")
    else out+=("'${arg//\'/\'\\\'\'}'"); fi
  done
  echo "${out[*]}"
}

# run ARG...: runs a gcloud command that changes something (printed first), or
# only prints it with --dry-run.
run() {
  if $dry_run; then echo "  $(show "$@")"; else echo "+ $(show "$@")" >&2; "$@"; fi
}

# json STRING: STRING as a JSON string literal.
json() {
  local s="${1//\\/\\\\}"
  s="${s//\"/\\\"}"
  s="${s//$'\n'/\\n}"
  printf '"%s"' "$s"
}

# filter EVENT: the Logging filter for the agent's lines with that event.
filter() {
  echo "resource.type=\"cloud_run_revision\" AND resource.labels.service_name=\"$service\" AND jsonPayload.event=\"$1\""
}

# lookup KIND DISPLAY-NAME: the resource names with that display name.
lookup() {
  local group=(monitoring policies)
  [[ "$1" == channel ]] && group=(beta monitoring channels)
  local cmd=(gcloud "${group[@]}" list --project "$project" "--filter=displayName=\"$2\"" --format=value\(name\))
  if $dry_run; then
    echo "  $(show "${cmd[@]}")"
    return
  fi
  "${cmd[@]}"
}

# upsert KIND DISPLAY-NAME FILE: creates the resource from FILE, or replaces
# the one with that display name; prints its resource name (not with --dry-run).
upsert() {
  local kind=$1 display=$2 file=$3 group=(monitoring policies) flag=--policy-from-file existing
  if [[ "$kind" == channel ]]; then group=(beta monitoring channels); flag=--channel-content-from-file; fi
  if $dry_run; then
    echo "# $kind \"$display\": look it up,"
    lookup "$kind" "$display"
    echo "# and if that prints nothing, create it:"
    echo "  $(show gcloud "${group[@]}" create --project "$project" "$flag=<$kind file>" --format=value\(name\))"
    echo "# else replace it with the same file:"
    echo "  $(show gcloud "${group[@]}" update "<existing $kind>" --project "$project" "$flag=<$kind file>" --format=value\(name\))"
    return
  fi
  existing=$(lookup "$kind" "$display")
  if [[ -z "$existing" ]]; then
    run gcloud "${group[@]}" create --project "$project" "$flag=$file" --format=value\(name\)
  elif [[ "$existing" == *$'\n'* ]]; then
    echo "more than one $kind is named \"$display\": delete the extras, then re-run" >&2
    exit 1
  else
    run gcloud "${group[@]}" update "$existing" --project "$project" "$flag=$file" --format=value\(name\) >/dev/null
    echo "$existing"
  fi
}

# policy ROW CHANNEL: the alert policy file for one row of `alerts`.
policy() {
  local event severity summary labels todo
  IFS='|' read -r event severity summary labels todo <<<"$1"
  local extractors=() pair
  for pair in $labels; do
    extractors+=("$(json "${pair%%=*}"): $(json "EXTRACT(jsonPayload.${pair#*=})")")
  done
  local content="**${summary}**

${todo}

Alert event \`${event}\` from the Cloud Run service \`${service}\`; it fires once per crossing. Fields and meaning: ${docs_url}"
  local joined
  joined=$(IFS=,; echo "${extractors[*]}")
  cat <<JSON
{
  "displayName": $(json "Agent: $event"),
  "severity": $(json "$severity"),
  "combiner": "OR",
  "enabled": true,
  "userLabels": {"managed-by": "monitoring-alerts-sh", "alert-event": $(json "${event//_/-}")},
  "documentation": {"mimeType": "text/markdown", "subject": $(json "[agent] $summary"), "content": $(json "$content")},
  "conditions": [{
    "displayName": $(json "Log line with event $event"),
    "conditionMatchedLog": {"filter": $(json "$(filter "$event")"), "labelExtractors": {${joined}}}
  }],
  "alertStrategy": {"notificationRateLimit": {"period": "$rate_limit"}, "autoClose": "$auto_close"},
  "notificationChannels": [$(json "$2")]
}
JSON
}

work=$(umask 077 && mktemp -d)
trap 'rm -rf -- "${work:?}"' EXIT

if [[ "$command" == test ]]; then
  [[ $# -le 2 ]] || usage
  event="${2:-store_unavailable}"
  row=""
  for candidate in "${alerts[@]}"; do [[ "${candidate%%|*}" == "$event" ]] && row=$candidate; done
  [[ -n "$row" ]] || { echo "not an alert event: $event" >&2; exit 2; }
  IFS='|' read -r _ severity _ labels _ <<<"$row"
  payload="{\"event\": $(json "$event"), \"message\": \"Test alert (scripts/monitoring-alerts.sh test)\", \"test\": true"
  for pair in $labels; do payload+=", $(json "${pair#*=}"): \"test\""; done
  payload+="}"
  $dry_run && echo "# write one $event entry as the agent's Cloud Run service; its policy emails within minutes:"
  run gcloud logging write agent-alert-test "$payload" --project "$project" --payload-type=json \
    --severity="$severity" --monitored-resource-type=cloud_run_revision \
    --monitored-resource-labels="service_name=$service,location=$region,project_id=$project"
  exit 0
fi

email="${2:-}"
[[ "$email" =~ ^[^@[:space:]]+@[^@[:space:]]+\.[A-Za-z]{2,}$ ]] || { echo "the second argument must be the notification email" >&2; usage; }
[[ $# -eq 2 ]] || usage

$dry_run && echo "# Dry run for project $project: nothing below has run."
$dry_run && echo "# 1. The Monitoring API (a no-op when it is already enabled):"
run gcloud services enable monitoring.googleapis.com --project "$project"

channel_file="$work/channel.json"
printf '{"type": "email", "displayName": %s, "description": %s, "labels": {"email_address": %s}, "enabled": true}\n' \
  "$(json "$channel_name")" "$(json "Alert events of the agent ($docs_url)")" "$(json "$email")" >"$channel_file"
if $dry_run; then
  echo "# 2. The email channel. <channel file>:"
  sed 's/"email_address": "[^"]*"/"email_address": "<email>"/' "$channel_file" | sed 's/^/  /'
fi
if $dry_run; then
  upsert channel "$channel_name" "$channel_file"
  channel="<channel>"
else
  channel=$(upsert channel "$channel_name" "$channel_file")
fi

$dry_run && echo "# 3. One alert policy per alert event, notifying the channel:"
for row in "${alerts[@]}"; do
  event="${row%%|*}"
  file="$work/$event.json"
  policy "$row" "$channel" >"$file"
  if $dry_run; then
    echo "# <policy file> for $event:"
    sed 's/^/  /' "$file"
    upsert policy "Agent: $event" "$file"
  else
    upsert policy "Agent: $event" "$file" >/dev/null
  fi
done

if $dry_run; then
  echo "# Done (dry run). Run without --dry-run to apply it, then: monitoring-alerts.sh test $project"
else
  echo "Set up: channel \"$channel_name\" and ${#alerts[@]} alert policies in $project." >&2
  echo "Next: wait about 10 minutes (a new policy takes a few to start matching), then scripts/monitoring-alerts.sh test $project, and check the inbox." >&2
fi
