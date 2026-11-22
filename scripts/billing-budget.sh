#!/usr/bin/env bash
# The project's monthly GCP billing budget and its alert thresholds
# (docs/deploy.md#billing-budget). Run by the owner, by hand; never in CI:
# it needs a login with a billing role on the project's billing account.
#
#   billing-budget.sh [--dry-run] <project-id>
#       Finds the one budget on the project's billing account that is scoped
#       to this project and reconciles it with the values below, or creates it
#       when there is none. A budget already made by hand is adopted, never
#       duplicated; re-running it once it matches changes nothing. Two budgets
#       scoped to the project stop it. --dry-run only reads: it prints what
#       differs and the gcloud command it would run.
#
# The billing account id is looked up from the project, never an argument,
# and this script never prints it (output shows <billing account>), so its
# output can be pasted into a pull request.
set -euo pipefail

usage() {
  echo "usage: billing-budget.sh [--dry-run] <project-id>" >&2
  exit 2
}

# The budget. Its currency must be the billing account's.
units=5
currency=EUR
period=MONTH
credits=INCLUDE_ALL_CREDITS
# basis:fraction of the amount, in the order the API returns them.
thresholds=(CURRENT_SPEND:0.5 CURRENT_SPEND:0.9 CURRENT_SPEND:1.0 FORECASTED_SPEND:1.0)

dry_run=false
if [[ "${1:-}" == --dry-run ]]; then dry_run=true; shift; fi
[[ $# -eq 1 ]] || usage
project=$1
[[ "$project" =~ ^[a-z][a-z0-9-]{4,28}[a-z0-9]$ ]] || usage

account=$(gcloud billing projects describe "$project" --format='value(billingAccountName)')
account=${account#billingAccounts/}
[[ -n "$account" ]] || { echo "$project has no billing account: enable billing on it first" >&2; exit 1; }
number=$(gcloud projects describe "$project" --format='value(projectNumber)')

# show ARG...: a command as it can be pasted into a shell, the account masked.
show() {
  local out=() arg
  for arg in "$@"; do
    arg=${arg//$account/<billing account>}
    if [[ "$arg" =~ ^[A-Za-z0-9_./:=,@%+-]+$ ]]; then out+=("$arg")
    else out+=("'${arg//\'/\'\\\'\'}'"); fi
  done
  echo "${out[*]}"
}

# run ARG...: runs a command that changes something (printed first), or only
# prints it with --dry-run.
run() {
  if $dry_run; then echo "  $(show "$@")"; else echo "+ $(show "$@")" >&2; "$@" >/dev/null; fi
}

# The threshold flags for gcloud: FLAG=percent=P,basis=B per threshold.
threshold_flags() {
  local flag=$1 t basis
  for t in "${thresholds[@]}"; do
    basis=${t%%:*}
    basis=${basis,,}
    echo "$flag=percent=${t#*:},basis=${basis//_/-}"
  done
}
# done_msg MESSAGE: the closing line, MESSAGE when it ran for real.
done_msg() {
  if $dry_run; then echo "# Done (dry run). Run without --dry-run to apply it."; else echo "$1" >&2; fi
}

settings=(--budget-amount="$units$currency" --calendar-period="${period,,}" --credit-types-treatment="${credits,,}")
settings=("${settings[@]//_/-}")

$dry_run && echo "# Dry run for project $project: nothing below has run."
echo "# Budgets on the project's billing account (<billing account>) scoped to projects/$number:"
mapfile -t found < <(gcloud billing budgets list --billing-account="$account" \
  --filter="budgetFilter.projects:\"projects/$number\"" --format='value(name)')

if [[ ${#found[@]} -gt 1 ]]; then
  echo "more than one budget covers $project: delete the extras in the console, then re-run" >&2
  exit 1
fi

if [[ ${#found[@]} -eq 0 ]]; then
  echo "#   no budget covers this project: create one"
  mapfile -t rules < <(threshold_flags --threshold-rule)
  run gcloud billing budgets create --billing-account="$account" --display-name="$project monthly budget" \
    --filter-projects="projects/$number" "${settings[@]}" "${rules[@]}"
  done_msg "Created the budget for $project."
  exit 0
fi

id=${found[0]##*/}
echo "#   budgets/$id: adopt it"
# Tabs to |: read would merge the tabs around an empty field.
IFS='|' read -r have_units have_currency have_nanos have_period have_credits have_disabled have_thresholds < <(
  gcloud billing budgets describe "$id" --billing-account="$account" --format='value(amount.specifiedAmount.units,amount.specifiedAmount.currencyCode,amount.specifiedAmount.nanos,budgetFilter.calendarPeriod,budgetFilter.creditTypesTreatment,notificationsRule.disableDefaultIamRecipients,thresholdRules[].map().format("{0}:{1}",spendBasis,thresholdPercent).list(separator=" "))' | tr '\t' '|'
)

if [[ "${have_disabled,,}" == true ]]; then
  echo "budgets/$id has its default recipients (the billing account's admins and users) turned off: turn them back on in the console, then re-run" >&2
  exit 1
fi

diffs=()
have_amount="$have_units${have_nanos:+.$have_nanos} $have_currency"
[[ "$have_amount" == "$units $currency" ]] || diffs+=("amount: $have_amount -> $units $currency")
[[ "$have_period" == "$period" ]] || diffs+=("period: $have_period -> $period")
[[ "$have_credits" == "$credits" ]] || diffs+=("credits: $have_credits -> $credits")
[[ "$have_thresholds" == "${thresholds[*]}" ]] || diffs+=("thresholds: $have_thresholds -> ${thresholds[*]}")

if [[ ${#diffs[@]} -eq 0 ]]; then
  echo "#   it matches ($units $currency a month, thresholds ${thresholds[*]}): nothing to change"
  exit 0
fi

printf '#   %s\n' "${diffs[@]}"
mapfile -t rules < <(threshold_flags --add-threshold-rule)
run gcloud billing budgets update "$id" --billing-account="$account" "${settings[@]}" --clear-threshold-rules "${rules[@]}"
done_msg "Updated budgets/$id."
