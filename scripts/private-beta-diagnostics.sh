#!/usr/bin/env bash
#
# Private-beta diagnostics — one command after an incident, one sanitized file
# for whoever diagnoses it.
#
#   scripts/private-beta-diagnostics.sh [--out-dir DIR] [--since 30m] [--max-lines 300]
#                                       [--stack production|development] [--no-logs]
#   make private-beta-diagnostics ARGS="--since 2h"
#
# Run on the host, from the checkout the stack was started from, as the account
# that runs `docker`. It writes DIR/jtt-diagnostics-<UTC time>/ and a .tar.gz
# of it (default DIR: ~/jtt-diagnostics; never inside the checkout), 0700 and
# 0600, and prints the archive's path and sha256.
#
# ## What it collects
#
#   10-deployment.txt   commit, branch, count of uncommitted files, Docker,
#                       Compose, kind and kubectl versions
#   20-host.txt         kernel, CPUs, load, memory, disk for / and Docker's data
#                       root, `docker system df`
#   30-services.txt     every service's state, health, restarts, OOM kills and
#                       exit code; api /health; api/terminal/sandboxd /readyz
#   40-sessions.txt     the operator socket: capacity, can a new lab start, and
#                       sessions live and recently finished — WITHOUT owner ids
#   50-runtime.txt      platform-managed sandbox containers and networks by
#                       status; kind nodes; lab namespaces and their pod phases
#                       as counts
#   60-alerts.txt       (production) alerts firing, and the capacity, backup,
#                       TLS and host gauges
#   logs/<service>.log  the last --since of api, terminal, sandboxd, postgres
#                       and web, through services/observability/src/support-bundle.ts:
#                       warnings, errors and lifecycle only; allow-listed fields;
#                       redacted; no query strings; no SQL; no user ids
#
# ## What it never collects
#
# .env or any environment value (it reads .env only to know which values to
# search for, and never writes one), `docker inspect` output, `docker compose
# config` (which renders secrets), any credential, cookie, token or key,
# terminal input or output, workspace files, student command history, pod or
# container names a student chose, email addresses, or internal user ids.
#
# Before packaging, every file is searched for this deployment's configured
# secret values and for credential shapes (scripts/diagnostics-sanitize-logs.ts
# --scan-dir). A hit deletes the bundle and exits 1.
#
# ## It is read-only
#
# docker/compose verbs used: version, info, system df, ps, logs, inspect -f,
# network ls, exec (node reading /health, /readyz and the operator socket's
# read-only views). kubectl: get. It starts, stops, restarts, deletes and ends
# nothing. Every docker/kubectl/kind call is bounded (scripts/production-host-lib.sh).
#
# Exit: 0 bundle written · 1 a secret was found and nothing was kept · 2 usage.
set -Eeuo pipefail
set +x
umask 077

repo=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)
# shellcheck source=scripts/production-host-lib.sh
. "$repo/scripts/production-host-lib.sh"
jtt_repo=$repo
# The `bash -c` pipelines below run in subshells; give them the bounded wrappers too.
export -f jtt_bounded docker kubectl kind

out_dir=${HOME:-/tmp}/jtt-diagnostics
since=30m
max_lines=300
stack=production
collect_logs=1
env_file=$repo/.env

usage() {
  sed -n '3,13p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
}

while [ $# -gt 0 ]; do
  case $1 in
    --out-dir) [ $# -ge 2 ] || { usage >&2; exit 2; }; out_dir=$2; shift 2 ;;
    --since) [ $# -ge 2 ] || { usage >&2; exit 2; }; since=$2; shift 2 ;;
    --max-lines) [ $# -ge 2 ] || { usage >&2; exit 2; }; max_lines=$2; shift 2 ;;
    --stack) [ $# -ge 2 ] || { usage >&2; exit 2; }; stack=$2; shift 2 ;;
    --no-logs) collect_logs=0; shift ;;
    -h | --help) usage; exit 0 ;;
    *) echo "private-beta-diagnostics: unknown argument: $1" >&2; usage >&2; exit 2 ;;
  esac
done
if ! [[ $since =~ ^[0-9]{1,4}[smh]$ ]]; then
  echo 'private-beta-diagnostics: --since takes a duration like 30m, 2h or 900s' >&2
  exit 2
fi
if ! [[ $max_lines =~ ^[0-9]{1,5}$ ]]; then
  echo 'private-beta-diagnostics: --max-lines takes a number' >&2
  exit 2
fi
case $stack in production | development) ;; *)
  echo 'private-beta-diagnostics: --stack is production or development' >&2
  exit 2
  ;;
esac

# The bundle must never be written where `git add` could pick it up.
mkdir -p "$out_dir"
out_dir=$(cd "$out_dir" && pwd -P)
case $out_dir/ in "$repo"/*)
  echo "private-beta-diagnostics: --out-dir must be outside the checkout ($repo)" >&2
  exit 2
  ;;
esac

# The compose command for the chosen stack: `prod` from the operations runbook,
# or `make up`'s files for a development stack.
compose() {
  if [ "$stack" = production ]; then
    jtt_prod "$@"
  else
    (cd "$jtt_repo" && docker compose -f docker-compose.yml -f docker-compose.runtime.yml "$@" </dev/null)
  fi
}

stamp=$(date -u +%Y%m%dT%H%M%SZ)
name=jtt-diagnostics-$stamp
bundle=$out_dir/$name
mkdir -m 0700 "$bundle" "$bundle/logs"

# Every section writes through this: a failing command is recorded as such,
# never allowed to abort the collection (an incident is exactly when half the
# commands fail).
run() {
  local title=$1
  shift
  printf '\n## %s\n' "$title"
  local output status=0
  output=$("$@" 2>&1) || status=$?
  printf '%s\n' "$output" | head -n 400
  if [ "$status" -ne 0 ]; then printf '(exit %s)\n' "$status"; fi
}

# A GET to a port inside a service's own container, printed as `status body`.
# The bodies read here are bounded enums and counts by design (/readyz, /health).
in_container_get() {
  local service=$1 url=$2
  compose exec -T "$service" node -e \
    "fetch('$url',{signal:AbortSignal.timeout(10000)}).then(async r=>{console.log(r.status, await r.text())}).catch(e=>{console.log('unreachable', e.cause?.code ?? e.name); process.exit(1)})"
}

have_tsx() { [ -x "$repo/node_modules/.bin/tsx" ] && have node; }
tsx() { (cd "$repo" && "$repo/node_modules/.bin/tsx" "$@"); }

echo "private-beta-diagnostics: collecting into $bundle"

# --- 00 manifest ----------------------------------------------------------------------
{
  printf 'JumpToTech Labs diagnostics bundle\n'
  printf 'collected: %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  printf 'stack: %s; logs since: %s; at most %s lines per service\n' "$stack" "$since" "$max_lines"
  printf 'checkout: %s\n' "$repo"
  printf '\nContains: versions, host capacity, service state and health, session\n'
  printf 'capacity and session ids/labs/statuses/timestamps, runtime inventory as\n'
  printf 'counts, firing alerts, and sanitized warning/error log lines.\n'
  printf '\nNever contains: .env or environment values, secrets, tokens, cookies,\n'
  printf 'keys, terminal input or output, workspace files, student-chosen resource\n'
  printf 'names, email addresses, internal user ids, SQL, or query strings.\n'
  printf 'Checked for configured secret values before packaging.\n'
} >"$bundle/00-manifest.txt"

# --- 10 deployment --------------------------------------------------------------------
{
  run 'git' bash -c "cd '$repo' && printf 'commit %s\nbranch %s\nuncommitted files %s\n' \"\$(git rev-parse HEAD)\" \"\$(git rev-parse --abbrev-ref HEAD)\" \"\$(git status --porcelain | wc -l | tr -d ' ')\""
  run 'docker version' docker version --format 'client {{.Client.Version}} · server {{.Server.Version}} · api {{.Server.APIVersion}}'
  run 'compose version' docker compose version --short
  if have kind; then run 'kind version' kind version; fi
  if have kubectl; then run 'kubectl version (client)' kubectl version --client=true --output=yaml; fi
  if have node; then run 'node version' node -v; fi
} >"$bundle/10-deployment.txt"

# --- 20 host --------------------------------------------------------------------------
docker_root=$(docker info --format '{{.DockerRootDir}}' 2>/dev/null || true)
{
  run 'kernel' uname -srm
  if [ -r /proc/loadavg ]; then run 'load (1m 5m 15m)' cat /proc/loadavg; else run 'uptime' uptime; fi
  if have nproc; then run 'cpus' nproc; fi
  if [ -r /proc/meminfo ]; then
    run 'memory' grep -E '^(MemTotal|MemAvailable|SwapTotal|SwapFree):' /proc/meminfo
  fi
  run 'disk: /' df -hP /
  if [ -n "$docker_root" ]; then run "disk: docker data root ($docker_root)" df -hP "$docker_root"; fi
  run 'docker system df' docker system df
} >"$bundle/20-host.txt"

# --- 30 services ----------------------------------------------------------------------
{
  run 'services (state · health · status · created)' \
    compose ps -a --format '{{.Service}}	{{.State}}	{{.Health}}	{{.Status}}	{{.CreatedAt}}'
  printf '\n## restarts, OOM kills, exit codes\n'
  ids=$(compose ps -aq 2>/dev/null || true)
  for id in $ids; do
    docker inspect --format '{{index .Config.Labels "com.docker.compose.service"}}	restarts={{.RestartCount}}	oom_killed={{.State.OOMKilled}}	exit={{.State.ExitCode}}	started={{.State.StartedAt}}' "$id" 2>&1 | head -1
  done
  run 'api /health' in_container_get api http://127.0.0.1:4000/health
  run 'api /readyz' in_container_get api http://127.0.0.1:9400/readyz
  run 'terminal /readyz' in_container_get terminal http://127.0.0.1:9401/readyz
  run 'sandboxd /readyz' in_container_get sandboxd http://127.0.0.1:9402/readyz
} >"$bundle/30-services.txt"

# --- 40 sessions ----------------------------------------------------------------------
# Owner ids are removed on the host before anything is written: a session id is
# enough to follow a session through the logs.
drop_owners() {
  if have node; then
    node -e '
      let s = ""; process.stdin.on("data", (c) => (s += c)).on("end", () => {
        try {
          const body = JSON.parse(s);
          for (const x of body?.data?.sessions ?? []) delete x.ownerUserId;
          console.log(JSON.stringify(body, null, 2));
        } catch { console.log("(the operator socket answered something that is not JSON; not recorded)"); }
      });'
  else
    echo '(node is not installed on the host; session list not recorded)'
  fi
}
{
  run 'operator status' compose exec -T api npx tsx apps/api/src/operator-cli.ts status
  printf '\n## sessions (live and recently finished; owner ids removed)\n'
  sessions=$(compose exec -T api npx tsx apps/api/src/operator-cli.ts sessions --recent --json 2>&1) || true
  printf '%s\n' "$sessions" | drop_owners
} >"$bundle/40-sessions.txt"

# --- 50 runtime -----------------------------------------------------------------------
owner=$(jtt_env_value "$env_file" RUNTIME_OWNER_ID || true)
cluster=$(jtt_env_value "$env_file" LAB_CLUSTER_NAME || true)
cluster=${cluster:-jumptotech-labs}
kubeconfig=$repo/infrastructure/kind/generated/kubeconfig-host-$cluster.yaml
[ -f "$kubeconfig" ] || kubeconfig=$repo/infrastructure/kind/generated/kubeconfig-host.yaml
{
  printf 'runtime owner: %s\n' "${owner:-(not set in .env)}"
  filters=(--filter label=jumptotech.io/managed=true)
  if [ -n "$owner" ]; then filters+=(--filter "label=jumptotech.io/runtime-owner=$owner"); fi
  run 'managed sandbox containers by status (this owner)' \
    bash -c 'docker ps -a "$@" --format "{{.State}}" | sort | uniq -c' _ "${filters[@]}"
  run 'managed sandbox containers (this owner)' \
    docker ps -a "${filters[@]}" --format '{{.Names}}	{{.State}}	{{.RunningFor}}	{{.Label "jumptotech.io/provider"}}'
  run 'managed containers with NO owner label (never reclaimed; RB-05 §4b)' \
    bash -c 'docker ps -a --filter label=jumptotech.io/managed=true --format "{{.Names}}	{{.Label \"jumptotech.io/runtime-owner\"}}" | awk -F"\t" "\$2 == \"\"" | wc -l'
  run 'managed networks (this owner)' bash -c 'docker network ls "$@" --format "{{.Name}}" | wc -l' _ "${filters[@]}"
  if have kind; then run 'kind clusters' kind get clusters; fi
  if have kubectl && [ -f "$kubeconfig" ]; then
    run 'kubernetes nodes' kubectl --kubeconfig "$kubeconfig" get nodes -o wide
    run 'lab namespaces (name · phase · created)' kubectl --kubeconfig "$kubeconfig" get ns \
      -l jumptotech.io/managed=true -o 'custom-columns=NAME:.metadata.name,PHASE:.status.phase,CREATED:.metadata.creationTimestamp'
    # Pod names in a lab namespace are the student's own; only counts leave the host.
    run 'pods by namespace and phase (lab namespaces are counts only)' bash -c '
      kubectl --kubeconfig "$1" get pods -A --no-headers -o "custom-columns=NS:.metadata.namespace,PHASE:.status.phase" |
        awk "{print \$1, \$2}" | sort | uniq -c' _ "$kubeconfig"
    run 'system pods not Running' bash -c '
      kubectl --kubeconfig "$1" get pods -n kube-system --no-headers -o "custom-columns=NAME:.metadata.name,PHASE:.status.phase,RESTARTS:.status.containerStatuses[*].restartCount" |
        awk "\$2 != \"Running\" && \$2 != \"Succeeded\""' _ "$kubeconfig"
  else
    printf '\n(no kubectl or no host kubeconfig: Kubernetes not inspected)\n'
  fi
} >"$bundle/50-runtime.txt"

# --- 60 alerts (production) -----------------------------------------------------------
if [ "$stack" = production ]; then
  q() { compose exec -T prometheus promtool query instant http://127.0.0.1:9090 "$1"; }
  {
    run 'alerts firing' compose exec -T alertmanager amtool alert query --alertmanager.url=http://127.0.0.1:9093
    for expr in \
      'jtt_sessions_capacity_limit' 'jtt_sessions_per_student_limit' 'jtt:sessions_headroom:count' \
      'sum by (status) (jtt_sessions_active)' 'jtt_lab_launches_paused' \
      'sum by (outcome) (increase(jtt_lab_start_outcome_total[1h]))' \
      'jtt:reaper_seconds_since_success' 'jtt:sandbox_leak:count' \
      'jtt:backup_age:seconds / 3600' 'jtt:tls_certificate_expiry:seconds / 86400' \
      'jtt:host_filesystem_available:ratio' 'jtt:host_memory_available:ratio' 'jtt:host_load5_per_cpu:ratio' \
      'up'; do
      run "$expr" q "$expr"
    done
  } >"$bundle/60-alerts.txt"
fi

# --- logs -----------------------------------------------------------------------------
if [ "$collect_logs" -eq 1 ]; then
  if have_tsx; then
    for entry in api:structured terminal:structured sandboxd:structured postgres:postgres web:nginx; do
      service=${entry%%:*}
      source=${entry##*:}
      {
        compose logs --no-color --no-log-prefix --since "$since" "$service" 2>/dev/null || true
      } | tsx scripts/diagnostics-sanitize-logs.ts --source "$source" --max-lines "$max_lines" --env-file "$env_file" \
        >"$bundle/logs/$service.log" 2>"$bundle/logs/$service.summary" || echo "sanitizer failed for $service" >"$bundle/logs/$service.summary"
    done
  else
    echo 'logs not collected: node_modules/.bin/tsx is missing (npm ci). Raw logs are never bundled.' >"$bundle/logs/NOT-COLLECTED.txt"
  fi
else
  echo 'logs not collected (--no-logs)' >"$bundle/logs/NOT-COLLECTED.txt"
fi

# --- the gate -------------------------------------------------------------------------
if have_tsx; then
  if ! tsx scripts/diagnostics-sanitize-logs.ts --scan-dir "$bundle" --env-file "$env_file"; then
    rm -rf "$bundle"
    echo 'private-beta-diagnostics: a secret was found in the collected files. Nothing was kept. Report this as a bug; do not collect by hand.' >&2
    exit 1
  fi
else
  echo 'private-beta-diagnostics: WARNING: tsx is missing, so the secret scan could not run. Review the bundle before sending it.' >&2
fi

chmod -R go-rwx "$bundle"
tar -czf "$bundle.tar.gz" -C "$out_dir" "$name"
chmod 0600 "$bundle.tar.gz"
printf 'private-beta-diagnostics: wrote %s.tar.gz (sha256 %s)\n' "$bundle" "$(sha256 <"$bundle.tar.gz")"
printf 'Send it through a private channel. It holds session ids and timestamps, and the host'"'"'s addresses.\n'
