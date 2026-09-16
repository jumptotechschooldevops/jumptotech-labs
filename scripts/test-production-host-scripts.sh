#!/usr/bin/env bash
#
# The production-host scripts' decisions, with no host, daemon, cluster or
# network: scripts/production-preflight.sh, scripts/private-beta-smoke.sh and
# scripts/host-capacity-sample.sh.
#
#   bash scripts/test-production-host-scripts.sh   (make test-production-host; CI `gates`)
#
# `docker`, `kind`, `kubectl`, `curl`, `npx`, `git`, `ss`, `df`, `uname` and
# friends are fakes driven by FAKE_* variables, against a fixture checkout built
# in a temporary directory. Each case proves one decision: a healthy host passes,
# and each unsafe state is a FAIL (never a WARN or a silent skip).
#
# Three properties are asserted on every run:
#
#   · no secret sentinel from the fixture .env appears in any output or report;
#   · every docker/kubectl invocation is a read-only verb — the scripts change
#     nothing on a production host;
#   · a MANUAL CHECK REQUIRED line is never counted as a PASS.
#
# What this cannot prove — that the checks agree with a real host — is the
# first real run on one (docs/development/production-host-readiness.md §20).
set -Eeuo pipefail
set +x

source_repo=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)
real_node=$(command -v node)
work=$(mktemp -d "${TMPDIR:-/tmp}/jtt-production-host-test.XXXXXX")
# Unix socket paths are limited to ~104 bytes, which a macOS TMPDIR exceeds.
sockets=$(mktemp -d /tmp/jttph.XXXXXX)
# JTT_TEST_KEEP=1 keeps every case's output (case-*/output) for debugging.
if [ "${JTT_TEST_KEEP:-}" = 1 ]; then
  trap 'echo "kept $work"' EXIT
else
  trap 'rm -rf "$work" "$sockets"' EXIT
fi
fakebin=$work/bin
mkdir -p "$fakebin"

# --- fakes ------------------------------------------------------------------------------

cat >"$fakebin/uname" <<'FAKE'
#!/usr/bin/env bash
case ${1:-} in
  -s) echo "${FAKE_UNAME_S:-Linux}" ;;
  -m) echo "${FAKE_UNAME_M:-x86_64}" ;;
  -r) echo 6.8.0-fake ;;
  *) echo "${FAKE_UNAME_S:-Linux}" ;;
esac
FAKE

cat >"$fakebin/nproc" <<'FAKE'
#!/usr/bin/env bash
echo 8
FAKE

cat >"$fakebin/timedatectl" <<'FAKE'
#!/usr/bin/env bash
echo "${FAKE_NTP:-yes}"
FAKE

cat >"$fakebin/df" <<'FAKE'
#!/usr/bin/env bash
path=${!#}
device=/dev/data
case $path in "$FAKE_DOCKER_ROOT"*) device=/dev/docker ;; esac
[ -n "${FAKE_DF_SAME_DEVICE-}" ] && device=/dev/shared
size=100000000
avail=$((size * ${FAKE_DF_PCT:-40} / 100))
echo 'Filesystem 1024-blocks Used Available Capacity Mounted on'
echo "$device $size $((size - avail)) $avail $((100 - ${FAKE_DF_PCT:-40}))% /"
FAKE

cat >"$fakebin/ss" <<'FAKE'
#!/usr/bin/env bash
[ -n "${FAKE_SS_NO_SSH-}" ] || echo 'LISTEN 0 4096 0.0.0.0:22 0.0.0.0:*'
echo 'LISTEN 0 4096 127.0.0.1:16443 0.0.0.0:*'
if [ -n "${FAKE_SS_EXTRA-}" ]; then printf '%s\n' "$FAKE_SS_EXTRA"; fi
FAKE

cat >"$fakebin/git" <<'FAKE'
#!/usr/bin/env bash
while [ "${1:-}" = -C ]; do shift 2; done
case ${1:-} in
  rev-parse) [ -z "${FAKE_KIND_BROKEN-}" ] || true; echo 0123456789abcdef0123456789abcdef01234567 ;;
  describe) exit 1 ;;
  status) printf '%s' "${FAKE_GIT_DIRTY-}" ;;
  *) exit 1 ;;
esac
FAKE

cat >"$fakebin/kind" <<'FAKE'
#!/usr/bin/env bash
case "$*" in
  'get clusters') [ -n "${FAKE_NO_CLUSTER-}" ] || echo jumptotech-labs ;;
  version) [ -z "${FAKE_KIND_BROKEN-}" ] || exit 1; echo 'kind v0.31.0 go1.25.5 linux/amd64' ;;
  *) exit 1 ;;
esac
FAKE

cat >"$fakebin/kubectl" <<'FAKE'
#!/usr/bin/env bash
{ printf 'kubectl'; printf ' %s' "$@"; printf '\n'; } >>"$FAKE_LOG"
args="$*"
case $args in
  'version --client') echo 'Client Version: v1.34.2' ;;
  'get nodes --no-headers') [ -z "${FAKE_KUBE_DOWN-}" ] || exit 1; echo "jumptotech-labs-control-plane ${FAKE_NODE_STATE:-Ready} control-plane 1d v1.34.0" ;;
  get\ --raw\ *configz) echo "{\"kubeletconfig\":{\"seccompDefault\":${FAKE_SECCOMP:-true}}}" ;;
  'get validatingadmissionpolicies -o name')
    for p in jumptotech-deny-clusterrole-bindings jumptotech-protect-managed-resources jumptotech-require-pod-security; do
      [ "$p" = "${FAKE_MISSING_POLICY-}" ] || echo "validatingadmissionpolicy.admissionregistration.k8s.io/$p"
    done
    ;;
  '-n kube-system get configmap jumptotech-network-policy-enforcement'*)
    [ -z "${FAKE_NO_ATTESTATION-}" ] || exit 1
    at=$("$REAL_NODE" -e 'console.log(new Date(Date.now() - Number(process.argv[1]) * 1000).toISOString())' "${FAKE_ATT_AGE:-3600}")
    printf '%s %s %s %s' "${FAKE_ATT_VERDICT:-PASS}" "${FAKE_ATT_DIGEST:-digest-abc}" "${FAKE_ATT_UID:-uid-1}" "$at"
    ;;
  'get namespace kube-system'*) printf uid-1 ;;
  'get pods -A --no-headers') printf 'a\nb\nc\n' ;;
  *) echo "fake kubectl: unexpected: $args" >&2; exit 1 ;;
esac
FAKE

cat >"$fakebin/node" <<'FAKE'
#!/usr/bin/env bash
case ${1:-} in
  -v) echo "${FAKE_NODE_VERSION:-v22.23.2}" ;;
  scripts/check-secret-distribution.mjs) exit "${FAKE_SECRETS_CHECK:-0}" ;;
  *) exec "$REAL_NODE" "$@" ;;
esac
FAKE

cat >"$fakebin/npx" <<'FAKE'
#!/usr/bin/env bash
{ printf 'npx'; printf ' %s' "$@"; printf '\n'; } >>"$FAKE_LOG"
case "${2:-}" in
  scripts/production-config-check.ts)
    echo 'PASS   compose.services  8 services'
    [ -z "${FAKE_CONFIG_FAIL-}" ] || echo 'FAIL   capacity.beta-contract  MAX_ACTIVE_SESSIONS resolves to 20, not the proven 5'
    [ -z "${FAKE_CONFIG_WARN-}" ] || echo 'WARN   durability.restart-policy  api has no restart policy'
    echo "INFO   attestation.expected-digest  ${FAKE_EXPECTED_DIGEST:-digest-abc}"
    [ -z "${FAKE_CONFIG_FAIL-}" ] || exit 1
    ;;
  scripts/tls-check.ts) exit "${FAKE_TLS_STATUS:-0}" ;;
  *) echo "fake npx: unexpected: $*" >&2; exit 1 ;;
esac
FAKE

cat >"$fakebin/curl" <<'FAKE'
#!/usr/bin/env bash
url= write_out= headers_to_stdout=0 method=GET
request_headers=()
while [ $# -gt 0 ]; do
  case $1 in
    -w) write_out=$2; shift 2 ;;
    -o | --max-time | --proto | --resolve | --data | --connect-timeout) shift 2 ;;
    -H) request_headers+=("$2"); shift 2 ;;
    -D) headers_to_stdout=1; shift 2 ;;
    -X) method=$2; shift 2 ;;
    -*) shift ;;
    *) url=$1; shift ;;
  esac
done
{ printf 'curl %s %s' "$method" "$url"; printf ' [%s]' "${request_headers[@]+"${request_headers[@]}"}"; printf '\n'; } >>"$FAKE_LOG"
code=200 location= body='<!doctype html><title>JumpToTech Labs</title>'
case $url in
  telnet://*)
    port=${url##*:}
    for open in ${FAKE_OPEN_PORTS-}; do [ "$open" = "$port" ] && exit 0; done
    exit 7
    ;;
  http://labs.test.invalid/*) code=${FAKE_REDIRECT_CODE:-301}; location="https://labs.test.invalid${url#http://labs.test.invalid}" ;;
  https://labs.test.invalid/) code=${FAKE_ROOT_CODE:-200} ;;
  https://labs.test.invalid/auth/config) body=${FAKE_AUTH_CONFIG:-'{"ok":true,"data":{"mode":"oidc","signInAvailable":true}}'} ;;
  https://labs.test.invalid/auth/login) code=302; location=${FAKE_LOGIN_LOCATION:-https://idp.test.invalid/authorize?state=x} ;;
  https://labs.test.invalid/api/*)
    code=401 body='{"ok":false,"error":{"code":"AUTH_REQUIRED"}}'
    for header in "${request_headers[@]+"${request_headers[@]}"}"; do
      case $header in "Authorization: Developer"*) [ -z "${FAKE_DEV_AUTH_OPEN-}" ] || code=200 ;; esac
    done
    ;;
  https://labs.test.invalid/internal/*) [ -z "${FAKE_INTERNAL_OPEN-}" ] || body='{"ok":false,"error":{"message":"This endpoint is for internal service use only."}}' ;;
  https://labs.test.invalid/metrics) [ -z "${FAKE_METRICS_OPEN-}" ] || body='# HELP jtt_up x' ;;
esac
[ "${FAKE_TLS_BROKEN-}" = 1 ] && [ "${url#https://}" != "$url" ] && exit 60
if [ $headers_to_stdout -eq 1 ]; then
  printf 'HTTP/1.1 %s\r\n' "$code"
  [ -n "${FAKE_NO_HSTS-}" ] || printf 'strict-transport-security: max-age=31536000\r\n'
  printf '\r\n'
fi
if [ -n "$write_out" ]; then
  out=${write_out//%\{http_code\}/$code}
  out=${out//%\{redirect_url\}/$location}
  printf '%s' "$out"
elif [ $headers_to_stdout -eq 0 ]; then
  printf '%s' "$body"
fi
FAKE

cat >"$fakebin/docker" <<'FAKE'
#!/usr/bin/env bash
{ printf 'docker'; printf ' %s' "$@"; printf '\n'; } >>"$FAKE_LOG"
if [ -n "${FAKE_DOCKER_DOWN-}" ] && [ "${1:-}" != compose ]; then exit 1; fi
services='postgres api terminal sandboxd web prometheus alertmanager grafana'
promql() {
  case $1 in
    up)
      for job in api terminal sandboxd; do
        value=1; [ "$job" = "${FAKE_TARGET_DOWN-}" ] && value=0
        echo "up{instance=\"$job:9400\", job=\"$job\"} => $value @[1726488000]"
      done
      ;;
    'ALERTS{alertstate="firing"}') [ -z "${FAKE_FIRING-}" ] || echo "ALERTS{alertname=\"$FAKE_FIRING\", alertstate=\"firing\"} => 1 @[1]" ;;
    jtt_sessions_capacity_limit) echo "jtt_sessions_capacity_limit{service=\"api\"} => ${FAKE_CAPACITY:-5} @[1]" ;;
    jtt_sessions_per_student_limit) echo 'jtt_sessions_per_student_limit{service="api"} => 1 @[1]' ;;
    'sum(jtt_sessions_active)') echo '{} => 0 @[1]' ;;
    jtt_network_isolation_attestation_valid) echo "jtt_network_isolation_attestation_valid{service=\"api\"} => ${FAKE_ATTESTED:-1} @[1]" ;;
    'jtt:tls_certificate_expiry:seconds / 86400') echo "{service=\"api\"} => ${FAKE_CERT_DAYS:-60.5} @[1]" ;;
    'jtt:backup_age:seconds{operation="backup"}') [ -n "${FAKE_NO_BACKUP-}" ] || echo "{operation=\"backup\"} => ${FAKE_BACKUP_AGE:-3600} @[1]" ;;
    'jtt:backup_age:seconds{operation="verify"}') echo '{operation="verify"} => 86400 @[1]' ;;
    jtt_backup_last_success_offhost) echo "jtt_backup_last_success_offhost{operation=\"backup\"} => ${FAKE_OFFHOST:-1} @[1]" ;;
    *) echo "fake promql: unexpected $1" >&2; return 1 ;;
  esac
}
case ${1:-} in
  info)
    case "$*" in
      info) exit 0 ;;
      *OSType*) echo linux ;;
      *CgroupVersion*) echo 2 ;;
      *CgroupDriver*) echo systemd ;;
      *SecurityOptions*) echo '["name=apparmor","name=seccomp,profile=builtin"]' ;;
      *DockerRootDir*) echo "$FAKE_DOCKER_ROOT" ;;
      *NCPU*) echo 8 ;;
    esac
    ;;
  version) echo 28.4.0 ;;
  network)
    case "$*" in
      'network inspect kind') [ -z "${FAKE_NO_KIND_NETWORK-}" ] ;;
      *Internal*) echo "${FAKE_DB_INTERNAL:-true}" ;;
      *) exit 1 ;;
    esac
    ;;
  image) for missing in ${FAKE_MISSING_IMAGES-}; do [ "$missing" = "$3" ] && exit 1; done; exit 0 ;;
  ps)
    case "$*" in
      *publish=443*) printf '%s' "${FAKE_PUBLISH_443-}" ;;
      *publish=80*) printf '%s' "${FAKE_PUBLISH_80-}" ;;
      *) echo id-api ;;
    esac
    ;;
  inspect)
    case "$*" in
      *RestartCount*) echo "${FAKE_RESTARTS:-0} ${FAKE_RESTART_POLICY:-unless-stopped}" ;;
      *'{{.Name}}'*) echo "/jumptotech-labs-${!##id-}-1" ;;
      *Networks*) echo 'jumptotech-labs-database ' ;;
      *) exit 1 ;;
    esac
    ;;
  port)
    case $2 in
      id-web) printf '8443/tcp -> 0.0.0.0:443\n8443/tcp -> [::]:443\n8080/tcp -> 0.0.0.0:80\n8080/tcp -> [::]:80\n' ;;
      id-prometheus) printf '3000/tcp -> 127.0.0.1:3001\n' ;;
      id-postgres) [ -z "${FAKE_POSTGRES_PUBLISHED-}" ] || printf '5432/tcp -> 127.0.0.1:5432\n' ;;
    esac
    ;;
  stats) printf 'jumptotech-labs-api-1|1.50%%|211.4MiB / 7.6GiB|40\njumptotech-labs-postgres-1|0.20%%|1.1GiB / 7.6GiB|12\n' ;;
  compose)
    [ -z "${FAKE_COMPOSE_DOWN-}" ] || { echo 'no configuration file provided: not found' >&2; exit 1; }
    shift
    while [ $# -gt 0 ]; do
      case $1 in -f | --profile) shift 2 ;; *) break ;; esac
    done
    case ${1:-} in
      version) echo 2.39.2 ;;
      ps)
        if [ "${2:-}" = -q ]; then
          if [ -n "${3:-}" ]; then echo "id-$3"; else for s in $services; do echo "id-$s"; done; fi
        else
          for s in $services; do
            health=healthy
            case $s in prometheus | alertmanager | grafana) health= ;; esac
            [ "$s" = "${FAKE_UNHEALTHY-}" ] && health=unhealthy
            [ "$s" = "${FAKE_MISSING_SERVICE-}" ] && continue
            echo "$s|running|$health|jumptotech-labs-$s-1"
          done
        fi
        ;;
      exec)
        shift 2 # exec -T
        service=$1
        shift
        case "$service $*" in
          'prometheus promtool query instant'*) promql "${!#}" ;;
          'prometheus wget'*) echo '{"commit":"x","database": "ok","version":"11.2.0"}' ;;
          'alertmanager amtool'*) exit 0 ;;
          'postgres sh'*) exit 0 ;;
          *'/readyz'*)
            [ "$service" != "${FAKE_NOT_READY-}" ] || { echo 503; exit 1; }
            echo 200
            ;;
          'api node -e'*'/health'*)
            echo '{"ok":true,"data":{"service":"api","status":"ok","labsLoaded":114,"labLoadErrors":[],"providers":[{"provider":"kubernetes","registered":true,"available":true},{"provider":"linux","registered":true,"available":true},{"provider":"docker","registered":true,"available":'"${FAKE_DOCKER_PROVIDER:-true}"',"reason":"sandboxd runtime unreachable"},{"provider":"aws","registered":true,"available":false,"reason":"architecture only"}],"sessions":{"active":0,"maxActive":'"${FAKE_CAPACITY:-5}"'},"progress":{"store":"postgres","ok":true,"durable":true}}}'
            ;;
          *) echo "fake docker compose exec: unexpected $service $*" >&2; exit 1 ;;
        esac
        ;;
      *) echo "fake docker compose: unexpected $*" >&2; exit 1 ;;
    esac
    ;;
  *) echo "fake docker: unexpected $1" >&2; exit 1 ;;
esac
FAKE

chmod +x "$fakebin"/*

# --- fixture checkout ---------------------------------------------------------------------

sentinel() { printf 'sentinel%s%s' "$1" "$(od -An -N12 -tx1 /dev/urandom | tr -d ' \n')"; }
secret_names=(TERMINAL_SESSION_SECRET INTERNAL_SERVICE_SECRET NAMESPACE_DERIVATION_SECRET SANDBOXD_ATTACH_SECRET
  SANDBOXD_RUNTIME_SECRET SANDBOXD_DOCKER_SECRET OIDC_CLIENT_SECRET POSTGRES_PASSWORD OBSERVABILITY_SCRAPE_TOKEN GRAFANA_ADMIN_PASSWORD)

fixture() {
  local root=$work/case-$1
  rm -rf "$root"
  (
    umask 022
    mkdir -p "$root/repo/scripts" "$root/repo/labs/linux" "$root/repo/node_modules/.bin" \
      "$root/repo/infrastructure/observability/prometheus" "$root/repo/infrastructure/observability/grafana/provisioning" \
      "$root/repo/infrastructure/observability/alertmanager/secrets" "$root/repo/infrastructure/observability/secrets" \
      "$root/repo/infrastructure/docker/nginx/tls" "$root/repo/infrastructure/docker/nginx/acme-webroot" \
      "$root/repo/infrastructure/kind/generated" "$root/docker-root" "$root/backups/postgres" "$root/backups/status" "$root/proc"
    cp "$source_repo/scripts/production-preflight.sh" "$source_repo/scripts/private-beta-smoke.sh" \
      "$source_repo/scripts/host-capacity-sample.sh" "$source_repo/scripts/production-host-lib.sh" "$root/repo/scripts/"
    printf '#!/bin/sh\nexit 0\n' >"$root/repo/node_modules/.bin/tsx"
    chmod +x "$root/repo/node_modules/.bin/tsx"
    echo 'id: LINUX-001' >"$root/repo/labs/linux/lab.yaml"
    echo 'global: {}' >"$root/repo/infrastructure/observability/prometheus/prometheus.yml"
    echo 'apiVersion: 1' >"$root/repo/infrastructure/observability/grafana/provisioning/datasources.yml"
    echo 'route: {}' >"$root/repo/infrastructure/observability/alertmanager/alertmanager.yml"
    echo 'server {}' >"$root/repo/infrastructure/docker/nginx/web-tls.conf"
    echo 'acme' >"$root/repo/infrastructure/docker/nginx/acme-webroot/README.md"
    echo 'CERTIFICATE' >"$root/repo/infrastructure/docker/nginx/tls/fullchain.pem"
    echo 'KEY' >"$root/repo/infrastructure/docker/nginx/tls/privkey.pem"
    chmod 600 "$root/repo/infrastructure/docker/nginx/tls/privkey.pem"
    echo '      DOCKER_SANDBOX_IMAGE: ${DOCKER_SANDBOX_IMAGE:-docker:27-dind}' >"$root/repo/docker-compose.runtime.yml"
    printf 'clusters:\n- cluster:\n    server: https://jumptotech-labs-control-plane:6443\n' >"$root/repo/infrastructure/kind/generated/kubeconfig-internal.yaml"
    printf 'clusters: []\n' >"$root/repo/infrastructure/kind/generated/kubeconfig-host-jumptotech-labs.yaml"
    printf 'MemTotal: 16000000 kB\nMemAvailable: 12000000 kB\nSwapTotal: 0 kB\nSwapFree: 0 kB\n' >"$root/proc/meminfo"
    printf '0.50 0.40 0.30 1/200 999\n' >"$root/proc/loadavg"
    echo '17 3 * * * jtt-ops BACKUP_COPY_HOOK=/usr/local/sbin/copy scripts/db-backup.sh' >"$root/cron"
  )
  chmod 750 "$root/repo"
  chmod 700 "$root/backups/postgres"
  chmod 755 "$root/backups/status"
  python3 -c 'import socket, sys; socket.socket(socket.AF_UNIX).bind(sys.argv[1])' "$sockets/$1.sock"
  ln -s "$sockets/$1.sock" "$root/docker.sock"

  : >"$root/secret-values"
  {
    for name in "${secret_names[@]}"; do
      value=$(sentinel "$name")
      # Outside the checkout, so nothing under test can read it.
      printf '%s\n' "$value" >>"$root/secret-values"
      printf '%s=%s\n' "$name" "$value"
    done
    cat <<ENV
PUBLIC_ORIGIN=https://labs.test.invalid
ALLOWED_ORIGINS=https://labs.test.invalid
OIDC_ISSUER=https://idp.test.invalid
OIDC_CLIENT_ID=jtt-beta
OIDC_AUDIENCE=jtt-beta
RUNTIME_OWNER_ID=jtt-production
MAX_ACTIVE_SESSIONS=5
MAX_ACTIVE_SESSIONS_PER_STUDENT=1
BACKUP_STATUS_DIR=$root/backups/status
DOCKER_SOCKET_GID=$(stat -c '%g' "$root/docker.sock" 2>/dev/null || stat -f '%g' "$root/docker.sock")
JTT_COMMIT=0123456789ab
ENV
  } >"$root/repo/.env"
  chmod 600 "$root/repo/.env"
  printf '%s' "$(grep '^OBSERVABILITY_SCRAPE_TOKEN=' "$root/repo/.env" | cut -d= -f2-)" >"$root/repo/infrastructure/observability/secrets/scrape-token"
  chmod 644 "$root/repo/infrastructure/observability/secrets/scrape-token"
  chmod 711 "$root/repo/infrastructure/observability/secrets"
  printf '%s\n' "$root"
}

# --- running and asserting ----------------------------------------------------------------

failures=0
cases=0
out=
status=
root=

run() { # script case-root args...
  local script=$1
  root=$2
  shift 2
  : >"$root/log"
  # The case's FAKE_* settings, as whole NAME=value words (values may hold spaces).
  local fakes=() name
  for name in $(compgen -e | grep -E '^FAKE_' | grep -vE '^FAKE_(LOG|DOCKER_ROOT)$' || true); do
    fakes+=("$name=${!name}")
  done
  set +e
  out=$(env -i PATH="$fakebin:/usr/bin:/bin" HOME="$root" TMPDIR="$work" REAL_NODE="$real_node" \
    FAKE_LOG="$root/log" FAKE_DOCKER_ROOT="$root/docker-root" JTT_PROC_ROOT="$root/proc" \
    JTT_DOCKER_SOCKET="$root/docker.sock" JTT_BACKUP_CRON_FILE="$root/cron" \
    ${fakes[@]+"${fakes[@]}"} \
    bash "$root/repo/scripts/$script" "$@" 2>&1)
  status=$?
  set -e
  printf '%s\n' "$out" >"$root/output"
}

check() { # description condition-command...
  local description=$1
  shift
  if "$@"; then return 0; fi
  failures=$((failures + 1))
  printf '  not ok: %s\n' "$description"
}

has_line() { printf '%s\n' "$out" | grep -Eq "$1"; }
has_fail() { has_line "^FAIL +$1( |$)"; }
exit_is() { [ "$status" -eq "$1" ]; }

no_secret_leaked() {
  local value file
  [ -s "$root/secret-values" ] || return 1
  while IFS= read -r value; do
    if printf '%s' "$out" | grep -qF "$value"; then return 1; fi
    for file in "$root"/*.txt "$root"/evidence/*; do
      [ -f "$file" ] || continue
      if grep -qF "$value" "$file"; then return 1; fi
    done
    if grep -qF "$value" "$root/log"; then return 1; fi
  done <"$root/secret-values"
}

# Every docker and kubectl call is a read-only verb.
only_read_only_calls() {
  ! grep -E '^docker ' "$root/log" | sed -E 's/ -f [^ ]+//g; s/ --profile [^ ]+//g' |
    grep -vE '^docker (info|version|network inspect|image inspect|ps|inspect|port|stats|compose (version|ps|exec -T (prometheus promtool query instant|prometheus wget -qO- http://127\.0\.0\.1:3000/api/health|alertmanager amtool alert query|postgres sh -c pg_isready|(api|terminal|sandboxd) node -e)))( |$)' |
    grep -q . &&
    ! grep -E '^kubectl ' "$root/log" | grep -vE '^kubectl( -n kube-system)? (version|get)( |$)' | grep -q .
}

manual_never_passes() {
  local manual_count summary
  manual_count=$(printf '%s\n' "$out" | grep -c '^MANUAL CHECK REQUIRED ' || true)
  summary=$(printf '%s\n' "$out" | grep -E '^[0-9]+ PASS, ' | tail -1)
  [ -n "$summary" ] && printf '%s' "$summary" | grep -q " $manual_count MANUAL CHECK REQUIRED"
}

scenario() { # name, then the body runs in the caller
  cases=$((cases + 1))
  printf 'case %d: %s\n' "$cases" "$1"
}

common_properties() {
  check 'no secret value appears in output, report or call log' no_secret_leaked
  check 'only read-only docker/kubectl verbs were used' only_read_only_calls
  check 'MANUAL CHECK REQUIRED lines are counted separately' manual_never_passes
}

preflight() { run production-preflight.sh "$@" --backup-dir "$root/backups/postgres"; }

# --- production-preflight.sh ----------------------------------------------------------------

scenario 'preflight: a healthy host passes, with the manual checks still listed'
root=$(fixture ok)
preflight "$root" --report "$root/preflight.txt"
check 'exit 0' exit_is 0
check 'RESULT: PASS' has_line '^RESULT: PASS'
check 'secret reported by name only' has_line '^PASS +env\.present +OIDC_CLIENT_SECRET: present$'
check 'the admission decision is surfaced' has_line '^MANUAL CHECK REQUIRED +auth\.admission '
check 'the firewall cannot be proven from the host' has_line '^MANUAL CHECK REQUIRED +exposure\.firewall '
check 'off-host backup is a manual check' has_line '^MANUAL CHECK REQUIRED +backup\.offhost '
check 'the attestation digest is compared' has_line '^PASS +k8s\.attestation-digest '
check 'the configuration check receives the socket group' grep -q 'production-config-check.ts --env-file .* --docker-socket-gid ' "$root/log"
check 'the report is written' grep -q '^RESULT: PASS' "$root/preflight.txt"
common_properties

scenario 'preflight: usage errors exit 2'
root=$(fixture usage)
run production-preflight.sh "$root" --no-such-flag
check 'exit 2' exit_is 2

scenario 'preflight: a group-readable .env fails'
root=$(fixture envmode)
chmod 640 "$root/repo/.env"
preflight "$root"
check 'env.file-mode FAIL' has_fail 'env\.file-mode'
check 'exit 1' exit_is 1
common_properties

scenario 'preflight: a missing secret fails by name'
root=$(fixture missing)
grep -v '^OIDC_CLIENT_SECRET=' "$root/repo/.env" >"$root/env.tmp" && mv "$root/env.tmp" "$root/repo/.env" && chmod 600 "$root/repo/.env"
preflight "$root"
check 'OIDC_CLIENT_SECRET: MISSING' has_line '^FAIL +env\.present +OIDC_CLIENT_SECRET: MISSING$'
check 'exit 1' exit_is 1
common_properties

scenario 'preflight: the old 0600 scrape token fails (Prometheus runs as 65534)'
root=$(fixture token600)
chmod 600 "$root/repo/infrastructure/observability/secrets/scrape-token"
preflight "$root"
check 'scrape-token-mode FAIL' has_fail 'observability\.scrape-token-mode'
common_properties

scenario 'preflight: an untraversable token directory fails'
root=$(fixture tokendir)
chmod 700 "$root/repo/infrastructure/observability/secrets"
preflight "$root"
check 'scrape-token-mode FAIL' has_fail 'observability\.scrape-token-mode'

scenario 'preflight: a stale scrape token fails, compared without printing either value'
root=$(fixture tokenstale)
printf 'stale-token-value-0123456789' >"$root/repo/infrastructure/observability/secrets/scrape-token"
preflight "$root"
check 'scrape-token-match FAIL' has_fail 'observability\.scrape-token-match'
check 'the stale value is not printed' bash -c '! printf "%s" "$1" | grep -q stale-token-value' _ "$out"
common_properties

scenario 'preflight: a non-Linux machine is not host evidence'
root=$(fixture darwin)
FAKE_UNAME_S=Darwin preflight "$root"
check 'host.os FAIL' has_fail 'host\.os'

scenario 'preflight: an unreachable daemon fails and the run still completes'
root=$(fixture dockerdown)
FAKE_DOCKER_DOWN=1 preflight "$root"
check 'docker.daemon FAIL' has_fail 'docker\.daemon'
check 'a RESULT line is still printed' has_line '^RESULT: FAIL'
check 'exit 1' exit_is 1

scenario 'preflight: a missing Docker socket fails'
root=$(fixture nosocket)
rm -f "$root/docker.sock"
preflight "$root"
check 'docker.socket FAIL' has_fail 'docker\.socket'

scenario 'preflight: DOCKER_SOCKET_GID that is not the socket group fails'
root=$(fixture gid)
sed -i.bak 's/^DOCKER_SOCKET_GID=.*/DOCKER_SOCKET_GID=4242/' "$root/repo/.env" && rm -f "$root/repo/.env.bak"
preflight "$root"
check 'env.docker-socket-gid FAIL' has_fail 'env\.docker-socket-gid'

scenario 'preflight: critically low memory fails on the HostMemoryCritical threshold'
root=$(fixture memory)
printf 'MemTotal: 16000000 kB\nMemAvailable: 480000 kB\n' >"$root/proc/meminfo"
preflight "$root"
check 'host.memory-available FAIL' has_fail 'host\.memory-available'

scenario 'preflight: disk below HostDiskSpaceCritical fails'
root=$(fixture disk)
FAKE_DF_PCT=5 preflight "$root"
check 'disk.docker-root FAIL' has_fail 'disk\.docker-root'

scenario 'preflight: a failed or foreign or expired attestation fails'
root=$(fixture attfail)
FAKE_ATT_VERDICT=FAIL preflight "$root"
check 'verdict FAIL' has_fail 'k8s\.attestation'
root=$(fixture attuid)
FAKE_ATT_UID=uid-other preflight "$root"
check 'other cluster FAIL' has_fail 'k8s\.attestation'
root=$(fixture attold)
FAKE_ATT_AGE=700000 preflight "$root"
check 'expired FAIL' has_fail 'k8s\.attestation'
root=$(fixture attnone)
FAKE_NO_ATTESTATION=1 preflight "$root"
check 'missing FAIL' has_fail 'k8s\.attestation'

scenario 'preflight: an attestation measured against another contract fails'
root=$(fixture digest)
FAKE_ATT_DIGEST=digest-other preflight "$root"
check 'attestation-digest FAIL' has_fail 'k8s\.attestation-digest'

scenario 'preflight: seccompDefault off and a missing admission policy fail'
root=$(fixture cluster)
FAKE_SECCOMP=false FAKE_MISSING_POLICY=jumptotech-require-pod-security preflight "$root"
check 'seccomp FAIL' has_fail 'kind\.seccomp-default'
check 'admission FAIL' has_fail 'kind\.admission-policies'
common_properties

scenario 'preflight: a configuration the gates refuse fails the preflight'
root=$(fixture config)
FAKE_CONFIG_FAIL=1 preflight "$root"
check 'the FAIL line is shown' has_line '^    FAIL +capacity\.beta-contract'
check 'config.production FAIL' has_fail 'config\.production'
root=$(fixture configwarn)
FAKE_CONFIG_WARN=1 preflight "$root"
check 'configuration warnings are counted' has_line '^WARN +config\.production-warnings +1 WARN'
check 'a warning alone does not fail' exit_is 0

scenario 'preflight: a checkout made under umask 077 fails'
root=$(fixture umask)
chmod 600 "$root/repo/labs/linux/lab.yaml"
chmod 700 "$root/repo/infrastructure/observability/grafana/provisioning"
preflight "$root"
check 'checkout.bind-mounts FAIL' has_fail 'checkout\.bind-mounts'

scenario 'preflight: a readable private key fails'
root=$(fixture key)
chmod 644 "$root/repo/infrastructure/docker/nginx/tls/privkey.pem"
preflight "$root"
check 'tls.key-mode FAIL' has_fail 'tls\.key-mode'

scenario 'preflight: a certificate the TLS check refuses fails'
root=$(fixture cert)
FAKE_TLS_STATUS=2 preflight "$root"
check 'tls.certificate FAIL' has_fail 'tls\.certificate'

scenario 'preflight: port 443 held outside Docker fails'
root=$(fixture port)
FAKE_SS_EXTRA='LISTEN 0 511 0.0.0.0:443 0.0.0.0:*' preflight "$root"
check 'exposure.port-443 FAIL' has_fail 'exposure\.port-443'
root=$(fixture listeners)
FAKE_SS_EXTRA='LISTEN 0 511 0.0.0.0:5432 0.0.0.0:*' preflight "$root"
check 'an extra public listener needs a person' has_line '^MANUAL CHECK REQUIRED +exposure\.other-listeners .*5432'

scenario 'preflight: backup directories that overlap, or a missing status directory, fail'
root=$(fixture overlap)
mkdir -p "$root/backups/postgres/status"
sed -i.bak "s#^BACKUP_STATUS_DIR=.*#BACKUP_STATUS_DIR=$root/backups/postgres/status#" "$root/repo/.env" && rm -f "$root/repo/.env.bak"
preflight "$root"
check 'backup.overlap FAIL' has_fail 'backup\.overlap'
root=$(fixture nostatus)
rmdir "$root/backups/status"
preflight "$root"
check 'backup.status-dir FAIL' has_fail 'backup\.status-dir'

scenario 'preflight: a quiet host, a broken kind binary and an unreachable cluster API are reported, not fatal'
root=$(fixture quiet)
FAKE_SS_NO_SSH=1 FAKE_KIND_BROKEN=1 FAKE_KUBE_DOWN=1 preflight "$root"
check 'no other listener is a PASS' has_line '^PASS +exposure\.other-listeners '
check 'an unreachable cluster API fails' has_fail 'kind\.nodes'
check 'a kind that cannot report its version is warned about' has_line '^WARN +tools\.kind '
check 'the run still completes' has_line '^RESULT: FAIL'
common_properties

scenario 'preflight: missing sandbox images fail'
root=$(fixture images)
FAKE_MISSING_IMAGES=jumptotech/lab-linux:latest preflight "$root"
check 'images.LINUX_SANDBOX_IMAGE FAIL' has_fail 'images\.LINUX_SANDBOX_IMAGE'

# --- private-beta-smoke.sh ---------------------------------------------------------------------

smoke() { run private-beta-smoke.sh "$@"; }

scenario 'smoke: a healthy deployment passes and writes evidence, leaving the person-only checks'
root=$(fixture smoke)
smoke "$root" --public-ip 203.0.113.10 --report-dir "$root/evidence"
check 'exit 0' exit_is 0
check 'RESULT: PASS' has_line '^RESULT: PASS'
check 'development auth is refused' has_line '^PASS +auth\.dev-identity-refused-authorization '
check 'the development student header is refused' has_line '^PASS +auth\.dev-identity-refused-x-dev-student-id '
check 'the api requires a session' has_line '^PASS +auth\.required/api/sessions '
check 'a student flow is a manual check' has_line '^MANUAL CHECK REQUIRED +student\.flow '
check 'alert delivery is a manual check' has_line '^MANUAL CHECK REQUIRED +alerts\.delivery '
check 'the external scan is a manual check' has_line '^MANUAL CHECK REQUIRED +exposure\.external '
check 'an evidence file is written' bash -c 'ls "$1"/evidence/private-beta-smoke-*.txt >/dev/null' _ "$root"
check 'the evidence says which host it proves' bash -c 'grep -q "proves nothing about any other host" "$1"/evidence/private-beta-smoke-*.txt' _ "$root"
common_properties

scenario 'smoke: a plaintext origin is refused before anything runs'
root=$(fixture smokeusage)
smoke "$root" --origin http://labs.test.invalid
check 'exit 2' exit_is 2
check 'nothing was called' bash -c '! grep -q . "$1/log"' _ "$root"

scenario 'smoke: a stack that is not running fails everywhere and still finishes'
root=$(fixture down)
FAKE_COMPOSE_DOWN=1 smoke "$root" --report-dir "$root/evidence"
check 'stack FAIL' has_fail 'stack\.api'
check 'readiness FAIL' has_fail 'ready\.api'
check 'targets FAIL' has_fail 'observability\.targets'
check 'backup FAIL' has_fail 'backup\.recent'
check 'RESULT: FAIL' has_line '^RESULT: FAIL'
check 'evidence is still written' bash -c 'ls "$1"/evidence/private-beta-smoke-*.txt >/dev/null' _ "$root"
common_properties

scenario 'smoke: an unhealthy or missing service fails'
root=$(fixture unhealthy)
FAKE_UNHEALTHY=web FAKE_MISSING_SERVICE=grafana smoke "$root"
check 'stack.web FAIL' has_fail 'stack\.web'
check 'stack.grafana FAIL' has_fail 'stack\.grafana'
check 'exit 1' exit_is 1

scenario 'smoke: a service that is not ready fails'
root=$(fixture ready)
FAKE_NOT_READY=sandboxd smoke "$root"
check 'ready.sandboxd FAIL' has_fail 'ready\.sandboxd'

scenario 'smoke: an unavailable provider fails, AWS is informational'
root=$(fixture provider)
FAKE_DOCKER_PROVIDER=false smoke "$root"
check 'runtime.provider-docker FAIL' has_fail 'runtime\.provider-docker'
check 'aws is INFO' has_line '^INFO +runtime\.provider-aws '

scenario 'smoke: development authentication answering in production fails'
root=$(fixture devauth)
FAKE_DEV_AUTH_OPEN=1 smoke "$root"
check 'auth.dev-identity-refused-authorization FAIL' has_fail 'auth\.dev-identity-refused-authorization'

scenario 'smoke: a broken TLS chain, a missing redirect and missing HSTS fail'
root=$(fixture edge)
FAKE_TLS_BROKEN=1 smoke "$root"
check 'edge.https FAIL' has_fail 'edge\.https'
root=$(fixture redirect)
FAKE_REDIRECT_CODE=200 FAKE_NO_HSTS=1 smoke "$root"
check 'edge.http-redirect FAIL' has_fail 'edge\.http-redirect'
check 'edge.hsts FAIL' has_fail 'edge\.hsts'

scenario 'smoke: sign-in that cannot reach the identity provider fails'
root=$(fixture login)
FAKE_LOGIN_LOCATION=https://labs.test.invalid/error smoke "$root"
check 'auth.login-redirect FAIL' has_fail 'auth\.login-redirect'

scenario 'smoke: internal and metrics paths reachable through the edge fail'
root=$(fixture internal)
FAKE_INTERNAL_OPEN=1 FAKE_METRICS_OPEN=1 smoke "$root"
check 'edge.internal-not-routed FAIL' has_fail 'edge\.internal-not-routed'
check 'edge.not-routed/metrics FAIL' has_fail 'edge\.not-routed/metrics'

scenario 'smoke: an unexpected publication, a routable database network and open public ports fail'
root=$(fixture exposure)
FAKE_POSTGRES_PUBLISHED=1 FAKE_DB_INTERNAL=false FAKE_OPEN_PORTS='5432 9090' smoke "$root" --public-ip 203.0.113.10
check 'exposure.published FAIL' has_fail 'exposure\.published'
check 'exposure.database-network FAIL' has_fail 'exposure\.database-network'
check 'exposure.public-ip FAIL' has_fail 'exposure\.public-ip'

scenario 'smoke: a scrape target down, the wrong capacity and no attestation fail'
root=$(fixture observability)
FAKE_TARGET_DOWN=terminal FAKE_CAPACITY=20 FAKE_ATTESTED=0 FAKE_FIRING=ServiceDown smoke "$root"
check 'observability.targets FAIL' has_fail 'observability\.targets'
check 'capacity.deployed FAIL' has_fail 'capacity\.deployed'
check 'runtime.capacity FAIL' has_fail 'runtime\.capacity'
check 'k8s.attestation FAIL' has_fail 'k8s\.attestation'
check 'a firing alert is named' has_line '^WARN +observability\.alerts +firing: ServiceDown'

scenario 'smoke: no backup, a stale backup, no off-host copy and an expiring certificate fail'
root=$(fixture backups)
FAKE_NO_BACKUP=1 FAKE_OFFHOST=0 FAKE_CERT_DAYS=3.2 smoke "$root"
check 'backup.recent FAIL' has_fail 'backup\.recent'
check 'backup.offhost FAIL' has_fail 'backup\.offhost'
check 'tls.expiry-metric FAIL' has_fail 'tls\.expiry-metric'
root=$(fixture stale)
FAKE_BACKUP_AGE=200000 smoke "$root"
check 'stale backup FAIL' has_fail 'backup\.recent'

scenario 'smoke: a Docker restart count and a missing restart policy are warned about'
root=$(fixture restarts)
FAKE_RESTARTS=3 FAKE_RESTART_POLICY=no smoke "$root"
check 'restarts WARN' has_line '^WARN +stack\.api-restarts '
check 'restart policy WARN' has_line '^WARN +stack\.api-restart-policy '

# --- host-capacity-sample.sh --------------------------------------------------------------------

scenario 'sampler: records host and container samples and prints the peaks'
root=$(fixture sampler)
run host-capacity-sample.sh "$root" --out-dir "$root/capacity" --interval 1 --duration 0 --kubeconfig "$root/kubeconfig"
check 'exit 0' exit_is 0
check 'host.csv has a header and a sample' bash -c '[ "$(wc -l <"$1/capacity/host.csv")" -eq 2 ]' _ "$root"
check 'memory, containers and pods are recorded' bash -c 'tail -1 "$1/capacity/host.csv" | grep -Eq ",15625,11718,.*,1,1,3$"' _ "$root"
check 'container memory is converted to MiB' grep -q ',jumptotech-labs-postgres-1,0.20,1126,12$' "$root/capacity/containers.csv"
check 'the peaks are printed' has_line '^peak containers +1 running'
check 'only read-only calls' only_read_only_calls

scenario 'sampler: usage errors exit 2'
root=$(fixture samplerusage)
run host-capacity-sample.sh "$root" --interval 0
check 'exit 2' exit_is 2

printf '\n%d case(s), %d failed assertion(s)\n' "$cases" "$failures"
[ "$failures" -eq 0 ]
