#!/usr/bin/env bash
#
# Production-host evidence status — what does the evidence directory on this
# host actually prove, for the commit this checkout is at?
#
#   scripts/production-evidence-status.sh [--evidence-dir DIR] [--env-file .env]
#   make production-evidence-status ARGS="--evidence-dir /srv/jumptotech/evidence"
#
# It reads the files the first-host procedure writes
# (docs/development/production-host-readiness.md §15) and says, item by item,
# whether each exists, what it concluded, and whether it was produced at this
# commit. It runs nothing, starts nothing and writes nothing.
#
#   PASS                   the evidence file exists, concluded PASS, and (where
#                          it records one) names this commit
#   FAIL                   the evidence concluded FAIL, is for another commit,
#                          cannot be matched to a commit, or is NOT RUN (absent)
#   MANUAL CHECK REQUIRED  evidence only a person can give; what the filled
#                          template records is quoted, never counted as PASS
#   INFO                   recorded, not judged
#
# Missing evidence is never a PASS, and no result is inferred from another.
# Exit: 0 every automated item PASS · 1 at least one FAIL · 2 usage error.
set -Eeuo pipefail
set +x

repo=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)
evidence_dir=/srv/jumptotech/evidence
env_file=$repo/.env

usage() {
  sed -n '3,8p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
}

while [ $# -gt 0 ]; do
  case $1 in
    --evidence-dir) [ $# -ge 2 ] || { usage >&2; exit 2; }; evidence_dir=$2; shift 2 ;;
    --env-file) [ $# -ge 2 ] || { usage >&2; exit 2; }; env_file=$2; shift 2 ;;
    -h | --help) usage; exit 0 ;;
    *) echo "production-evidence-status: unknown argument: $1" >&2; usage >&2; exit 2 ;;
  esac
done

# shellcheck source=scripts/production-host-lib.sh
. "$repo/scripts/production-host-lib.sh"

# The newest file matching a name pattern, anywhere under the evidence directory
# (names carry a UTC timestamp, so the lexically last is the newest).
newest() { # pattern
  find "$evidence_dir" -maxdepth 3 -type f -name "$1" 2>/dev/null | awk -F/ '{print $NF "\t" $0}' | sort | tail -1 | cut -f2-
}

# A JSON field, read with node (the operator tooling already needs it). Empty when absent.
json_field() { # file field
  node -e '
    try {
      const v = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"))[process.argv[2]];
      if (v !== undefined && v !== null) console.log(typeof v === "object" ? JSON.stringify(v) : String(v));
    } catch { process.exit(3); }' "$1" "$2"
}

printf 'JumpToTech Labs production evidence status — %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
printf 'checkout: %s\nevidence: %s\n' "$repo" "$evidence_dir"

section 'release'
head=
if have git && head=$(git -C "$repo" rev-parse HEAD 2>/dev/null); then
  info release.commit "$head"
  if [ -n "$(git -C "$repo" status --porcelain --untracked-files=no 2>/dev/null)" ]; then
    fail release.clean 'tracked files are modified: no evidence can be tied to this checkout'
  else
    pass release.clean 'no tracked file is modified'
  fi
  commit=$(jtt_env_value "$env_file" JTT_COMMIT || true)
  if [ -n "$commit" ] && [ "${head:0:${#commit}}" = "$commit" ]; then
    pass release.jtt-commit 'JTT_COMMIT in .env matches HEAD'
  else
    fail release.jtt-commit "JTT_COMMIT in .env ${commit:+does not match HEAD}${commit:-is unset}: the running stack would report another commit"
  fi
else
  fail release.commit 'the checkout is not a git repository: nothing can be tied to a commit'
fi
if ! [ -d "$evidence_dir" ]; then
  fail evidence.dir "NOT RUN — $evidence_dir does not exist (readiness doc §15 step 4)"
fi

matches_head() { [ -n "$head" ] && [ -n "$1" ] && [ "${head:0:${#1}}" = "$1" ]; }

section 'automated evidence'

# Preflight: the report's own RESULT line and the git.head it recorded.
file=$(newest 'preflight-*.txt')
if [ -z "$file" ]; then
  fail evidence.preflight 'NOT RUN — no preflight-*.txt (make production-preflight ARGS="--report …", §14)'
else
  ran_at=$(awk '$2 == "git.head" {print $3; exit}' "$file")
  if ! grep -q '^RESULT: PASS' "$file"; then
    fail evidence.preflight "$(basename "$file") did not conclude PASS"
  elif ! matches_head "$ran_at"; then
    fail evidence.preflight "$(basename "$file") ran at ${ran_at:-an unrecorded commit}, not HEAD: re-run it"
  else
    pass evidence.preflight "$(basename "$file"): RESULT: PASS at HEAD"
  fi
fi

# NetworkPolicy enforcement probe.
file=$(newest 'network-probe*.json')
if [ -z "$file" ]; then
  fail evidence.network-probe 'NOT RUN — no network-probe.json (§15 step 12)'
else
  verdict=$(json_field "$file" verdict || true)
  finished=$(json_field "$file" finishedAt || true)
  if [ "$verdict" = PASS ]; then
    pass evidence.network-probe "$(basename "$file"): VERDICT PASS, finished ${finished:-at an unrecorded time} (the preflight checks the live attestation's age and digest)"
  else
    fail evidence.network-probe "$(basename "$file"): VERDICT ${verdict:-unreadable}"
  fi
fi

# The five-student gate on this host (§13.1).
file=$(newest 'five-student-*.json')
if [ -z "$file" ]; then
  fail evidence.beta-validate 'NOT RUN — no five-student-*.json (make beta-validate ARGS="--report-dir …", §13.1)'
else
  passed=$(json_field "$file" passed || true)
  validated=$(json_field "$file" commit || true)
  if [ "$passed" != true ]; then
    fail evidence.beta-validate "$(basename "$file") did not pass"
  elif [ -z "$validated" ]; then
    fail evidence.beta-validate "$(basename "$file") passed but does not record its commit: it cannot be matched to this deployment. Re-run it at HEAD"
  elif ! matches_head "$validated"; then
    fail evidence.beta-validate "$(basename "$file") passed at $validated, not HEAD"
  else
    pass evidence.beta-validate "$(basename "$file"): passed at HEAD"
  fi
fi

# Capacity samples: counted from the files, first and last timestamp from their rows.
for kind in synthetic rehearsal; do
  csv=$(find "$evidence_dir" -maxdepth 3 -type f -path "*capacity-$kind*/host.csv" 2>/dev/null | sort | tail -1)
  if [ -z "$csv" ]; then
    fail "evidence.capacity-$kind" "NOT RUN — no capacity-$kind*/host.csv (host-capacity-sample.sh, §13)"
    continue
  fi
  rows=$(($(wc -l <"$csv") - 1))
  if [ "$rows" -lt 2 ]; then
    fail "evidence.capacity-$kind" "$csv has $rows sample(s): not a measurement"
  else
    pass "evidence.capacity-$kind" "$rows samples, $(awk -F, 'NR==2 {print $1}' "$csv") to $(tail -1 "$csv" | cut -d, -f1) ($csv)"
  fi
done
manual capacity.acceptance 'the samples are judged against the capacity thresholds decision D8 sets; no script judges them'

# The smoke against the running stack.
file=$(newest 'private-beta-smoke-*.txt')
if [ -z "$file" ]; then
  fail evidence.smoke 'NOT RUN — no private-beta-smoke-*.txt (make private-beta-smoke ARGS="--report-dir …", §16)'
else
  ran_at=$(awk '$1 == "#" && $2 == "commit" {print $3; exit}' "$file")
  offhost=$(grep -E '^(PASS|FAIL|WARN) +backup\.offhost ' "$file" | awk '{print $1}' | head -1)
  if ! matches_head "$ran_at"; then
    fail evidence.smoke "$(basename "$file") ran at ${ran_at:-an unrecorded commit}, not HEAD"
  elif grep -q '^RESULT: PASS' "$file"; then
    pass evidence.smoke "$(basename "$file"): RESULT: PASS at HEAD (backup.offhost ${offhost:-not recorded})"
  else
    fail evidence.smoke "$(basename "$file") did not conclude PASS ($(grep -c '^FAIL' "$file" || true) FAIL line(s); backup.offhost ${offhost:-not recorded})"
  fi
fi

section 'evidence only a person can give'
template=$(newest 'production-host-evidence*.md')
if [ -z "$template" ]; then
  fail evidence.template 'NOT RUN — no filled copy of docs/releases/production-host-evidence-template.md in the evidence directory (§15 step 26)'
  for item in 'Non-beta account is refused' 'Alert delivery drill' 'Off-host backup copy' 'Docker daemon restart' 'Host reboot'; do
    manual "person.$(printf '%s' "$item" | tr 'A-Z ' 'a-z-')" 'no filled template: nothing recorded'
  done
else
  # The Result cell of a template row, found by the row's own words.
  result_of() { # words
    awk -F'|' -v words="$1" 'index($2, words) {gsub(/^ +| +$/, "", $3); print $3; exit}' "$template"
  }
  open_rows=$(awk -F'|' '
    /^## [235]\./ {on=1; next} /^## / {on=0}
    on && NF >= 4 && $2 !~ /^ *(Step|Drill|-+) *$/ && $2 !~ /---/ {
      r=$3; gsub(/^ +| +$/, "", r)
      if (r == "" || r ~ /^(NOT DONE|BLOCKED|FAIL)/) n++
    } END {print n+0}' "$template")
  info evidence.template "$(basename "$template"): $open_rows row(s) in §2, §3 and §5 are blank, NOT DONE, BLOCKED or FAIL"
  for item in 'Non-beta account is refused' 'Alert delivery drill' 'Off-host backup copy' 'Docker daemon restart' 'Host reboot'; do
    recorded=$(result_of "$item")
    manual "person.$(printf '%s' "$item" | tr 'A-Z ' 'a-z-')" "the template records: ${recorded:-nothing}"
  done
  invited=$(awk -F'|' 'index($2, "Students may be invited") {gsub(/^ +| +$/, "", $3); print $3; exit}' "$template")
  info evidence.sign-off "Students may be invited: ${invited:-not recorded} (the operator's sign-off, not this script's)"
fi

printf '\n%s\n' "$(jtt_summary_line)"
if [ "$jtt_fail_count" -gt 0 ]; then
  printf 'RESULT: INCOMPLETE — %d item(s) missing, failing or not at this commit; students must not be invited\n' "$jtt_fail_count"
else
  printf 'RESULT: AUTOMATED EVIDENCE COMPLETE AT THIS COMMIT — every MANUAL CHECK REQUIRED line still needs its person, and the sign-off is the operator'"'"'s\n'
fi
[ "$jtt_fail_count" -eq 0 ]
