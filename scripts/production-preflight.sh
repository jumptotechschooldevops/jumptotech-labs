#!/usr/bin/env bash
#
# Production-host preflight — can this host run the private-beta production
# stack, configured the way the beta was proven?
#
#   scripts/production-preflight.sh [--env-file .env] [--backup-dir DIR] [--report FILE]
#   make production-preflight
#
# Run it on the host, from the checkout, as the operator account, BEFORE
# `prod up -d` and again after any change to .env, the certificate, the cluster
# or the host. docs/development/production-host-readiness.md §14.
#
# Every line is one of:
#
#   PASS                   checked, and satisfied
#   FAIL                   checked, and not satisfied: do not start the stack
#   WARN                   checked; allowed, but not the proven configuration
#   INFO                   measured and recorded, never judged
#   MANUAL CHECK REQUIRED  cannot be proven from this host; a person must
#
# It fails closed: a check that cannot run is a FAIL, not a skip. It changes
# nothing: no container, network, volume, file or cluster object is created,
# started or modified (the one file written is --report, if asked for).
#
# ## It never prints a secret
#
# .env is read line by line, never sourced or executed. Secrets are reported as
# `NAME: present` / `NAME: MISSING`. The scrape token is compared by hash. The
# configuration check it runs keeps the resolved configuration in memory and
# redacts loader messages (scripts/production-config-check.ts).
#
# Thresholds: the only numbers judged here are the repository's own —
# HostDiskSpaceLow/Critical and HostMemoryPressure/Critical in
# infrastructure/observability/prometheus/alerts/operations.yml, the tool
# versions CI pins, and the attestation max age. CPU, memory and disk SIZE are
# recorded as INFO only: host sizing is not proven (readiness doc §13).
#
# Exit: 0 no FAIL · 1 at least one FAIL · 2 usage error.
set -Eeuo pipefail
set +x
umask 077

repo=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)
env_file=$repo/.env
backup_dir=${BACKUP_DIR:-/srv/jumptotech/backups/postgres}
report=
skip_config_check=0

# Test seams. Each defaults to the real host path.
proc_root=${JTT_PROC_ROOT:-/proc}
docker_socket=${JTT_DOCKER_SOCKET:-/var/run/docker.sock}
cron_file=${JTT_BACKUP_CRON_FILE:-/etc/cron.d/jumptotech-db}

usage() {
  sed -n '3,12p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
  cat <<'USAGE'
Options:
  --env-file FILE        the .env to check (default: <checkout>/.env). `prod up` always
                         reads <checkout>/.env: checking another file proves nothing
                         about what starts
  --backup-dir DIR       the BACKUP_DIR the backup job uses (default: $BACKUP_DIR or /srv/jumptotech/backups/postgres)
  --report FILE          also write the result lines to FILE (no secrets)
  --skip-config-check    do not run scripts/production-config-check.ts (the result is then a FAIL)
USAGE
}

while [ $# -gt 0 ]; do
  case $1 in
    --env-file) [ $# -ge 2 ] || { usage >&2; exit 2; }; env_file=$2; shift 2 ;;
    --backup-dir) [ $# -ge 2 ] || { usage >&2; exit 2; }; backup_dir=$2; shift 2 ;;
    --report) [ $# -ge 2 ] || { usage >&2; exit 2; }; report=$2; shift 2 ;;
    --skip-config-check) skip_config_check=1; shift ;;
    -h | --help) usage; exit 0 ;;
    *) echo "production-preflight: unknown argument: $1" >&2; usage >&2; exit 2 ;;
  esac
done

# shellcheck source=scripts/production-host-lib.sh
. "$repo/scripts/production-host-lib.sh"
jtt_repo=$repo

env_value() { jtt_env_value "$env_file" "$1"; }
env_set() { local v; v=$(env_value "$1") && [ -n "$v" ]; }
env_or() { local v; if v=$(env_value "$1") && [ -n "$v" ]; then printf '%s' "$v"; else printf '%s' "$2"; fi; }

# Production secrets and settings the stack cannot start without, or that the
# beta contract fixes. Names from infrastructure/secret-distribution.json and the
# production overlays.
secret_names=(
  TERMINAL_SESSION_SECRET INTERNAL_SERVICE_SECRET NAMESPACE_DERIVATION_SECRET
  SANDBOXD_ATTACH_SECRET SANDBOXD_RUNTIME_SECRET SANDBOXD_DOCKER_SECRET
  OIDC_CLIENT_SECRET POSTGRES_PASSWORD OBSERVABILITY_SCRAPE_TOKEN GRAFANA_ADMIN_PASSWORD
)
setting_names=(
  PUBLIC_ORIGIN ALLOWED_ORIGINS OIDC_ISSUER OIDC_CLIENT_ID OIDC_AUDIENCE
  RUNTIME_OWNER_ID MAX_ACTIVE_SESSIONS MAX_ACTIVE_SESSIONS_PER_STUDENT
  BACKUP_STATUS_DIR DOCKER_SOCKET_GID
)

# --- checks ---------------------------------------------------------------------------

started=$(date -u +%Y-%m-%dT%H:%M:%SZ)
printf 'JumpToTech Labs production-host preflight — %s\n' "$started"
printf 'checkout: %s\n' "$repo"

section 'host'
os=$(uname -s 2>/dev/null || echo unknown)
if [ "$os" = Linux ]; then
  pass host.os 'Linux'
else
  fail host.os "$os: the production host contract is Linux. A Docker Desktop run is development evidence, not host evidence"
fi
arch=$(uname -m 2>/dev/null || echo unknown)
case $arch in
  x86_64 | amd64) pass host.arch "$arch (the architecture CI proves)" ;;
  aarch64 | arm64) warn host.arch "$arch: the images build for arm64, but CI proves amd64 only" ;;
  *) fail host.arch "$arch: the api and sandboxd images build for amd64 and arm64 only" ;;
esac
info host.kernel "$(uname -r 2>/dev/null || echo unknown)"
if have nproc; then info host.cpus "$(nproc) (recorded; no minimum is proven)"; fi
if [ -r "$proc_root/meminfo" ]; then
  mem_total=$(awk '/^MemTotal:/ {print $2}' "$proc_root/meminfo")
  mem_available=$(awk '/^MemAvailable:/ {print $2}' "$proc_root/meminfo")
  if [ -n "$mem_total" ] && [ -n "$mem_available" ] && [ "$mem_total" -gt 0 ]; then
    info host.memory "total $((mem_total / 1024)) MiB, available $((mem_available / 1024)) MiB (recorded; no minimum is proven)"
    pct=$((mem_available * 100 / mem_total))
    if [ "$pct" -lt 5 ]; then
      fail host.memory-available "${pct}% available: below HostMemoryCritical (5%) before a single student"
    elif [ "$pct" -lt 10 ]; then
      warn host.memory-available "${pct}% available: below HostMemoryPressure (10%) before a single student"
    else
      pass host.memory-available "${pct}% available (alerts at 10% and 5%)"
    fi
  else
    fail host.memory-available "could not read MemTotal/MemAvailable from $proc_root/meminfo"
  fi
else
  fail host.memory-available "$proc_root/meminfo is not readable"
fi
for knob in max_user_watches max_user_instances; do
  if [ -r "$proc_root/sys/fs/inotify/$knob" ]; then
    info "host.inotify-$knob" "$(cat "$proc_root/sys/fs/inotify/$knob") (kind runs a whole node on this kernel; no value is proven — see readiness doc §5)"
  fi
done
if have timedatectl; then
  if [ "$(timedatectl show -p NTPSynchronized --value 2>/dev/null)" = yes ]; then
    pass host.clock 'NTP synchronized (OIDC tokens allow 5 s of skew; certificates and the attestation are time-bound)'
  else
    warn host.clock 'the clock is not NTP-synchronized: OIDC token checks allow 5 s of skew'
  fi
else
  manual host.clock 'timedatectl is unavailable: confirm the clock is synchronized (OIDC allows 5 s of skew)'
fi
if [ "$(id -u)" -eq 0 ]; then
  warn host.operator 'running as root: run as the operator account in the docker group (root-equivalent either way, but files written here will be root-owned)'
else
  info host.operator "uid $(id -u) ($(id -un 2>/dev/null || echo unknown))"
fi

section 'tools'
for tool in docker git curl openssl jq; do
  if have "$tool"; then pass "tools.$tool" 'installed'; else
    case $tool in
      docker | git) fail "tools.$tool" 'not installed' ;;
      jq) warn "tools.$tool" 'not installed: the runbooks read JSON logs and /health with it (RB-03, RB-08, RB-11)' ;;
      *) warn "tools.$tool" 'not installed (scripts/private-beta-smoke.sh and the TLS runbook use it)' ;;
    esac
  fi
done
if have node; then
  node_version=$(node -v 2>/dev/null || echo unknown)
  node_major=${node_version#v}
  node_major=${node_major%%.*}
  if [ "$node_major" = 22 ]; then
    pass tools.node "$node_version (.nvmrc and CI: 22)"
  elif [[ $node_major =~ ^[0-9]+$ ]] && [ "$node_major" -ge 20 ] && [ "$node_major" -lt 25 ]; then
    warn tools.node "$node_version: inside package.json engines, but CI proves 22 (.nvmrc)"
  else
    fail tools.node "$node_version: package.json engines require >=20 <25"
  fi
else
  fail tools.node 'not installed: the operator tooling (secrets-check, tls:check, verify:network-policy, this check) needs Node 22'
fi
if [ -x "$repo/node_modules/.bin/tsx" ]; then
  pass tools.npm-ci 'node_modules present'
else
  fail tools.npm-ci 'node_modules/.bin/tsx is missing: run `npm ci` in the checkout'
fi
if have kind; then
  kind_version=$( (kind version 2>/dev/null || true) | awk '{print $2}')
  if [ "$kind_version" = v0.31.0 ]; then pass tools.kind "$kind_version (CI: v0.31.0)"; else warn tools.kind "${kind_version:-unknown}: CI proves v0.31.0 with kindest/node v1.34.0"; fi
else
  fail tools.kind 'not installed: the Kubernetes track runs on the kind cluster this host creates'
fi
if have kubectl; then
  kubectl_version=$( (kubectl version --client 2>/dev/null || true) | awk '/Client Version/ {print $3}')
  if [ "$kubectl_version" = v1.34.2 ]; then pass tools.kubectl "$kubectl_version (CI: v1.34.2)"; else warn tools.kubectl "${kubectl_version:-unknown}: CI proves v1.34.2"; fi
else
  fail tools.kubectl 'not installed'
fi

section 'docker'
docker_ok=0
if have docker && docker info >/dev/null 2>&1; then
  docker_ok=1
  pass docker.daemon "reachable, server $(docker version -f '{{.Server.Version}}' 2>/dev/null || echo unknown)"
  ostype=$(docker info -f '{{.OSType}}' 2>/dev/null || echo unknown)
  if [ "$ostype" = linux ]; then pass docker.ostype linux; else fail docker.ostype "$ostype: the images are Linux images"; fi
  info docker.cgroup "cgroup v$(docker info -f '{{.CgroupVersion}}' 2>/dev/null || echo '?') driver $(docker info -f '{{.CgroupDriver}}' 2>/dev/null || echo '?')"
  if jtt_contains "$(docker info -f '{{json .SecurityOptions}}' 2>/dev/null || true)" rootless; then
    warn docker.rootless 'rootless Docker is not proven: Docker-track sandboxes and the kind node need a privileged container'
  else
    pass docker.rootless 'rootful daemon (what kind and the Docker-track sandboxes were proven on)'
  fi
  if have docker && docker compose version >/dev/null 2>&1; then
    pass docker.compose "$(docker compose version --short 2>/dev/null || echo present)"
  else
    fail docker.compose 'the docker compose plugin is not installed'
  fi
else
  fail docker.daemon 'the Docker daemon is not reachable as this user'
fi
if [ -n "${DOCKER_HOST:-}" ]; then
  warn docker.host 'DOCKER_HOST is set: compose still mounts /var/run/docker.sock into sandboxd, so both must be the same daemon'
fi
socket_gid=
if [ -S "$docker_socket" ]; then
  socket_gid=$(gid_of "$docker_socket")
  pass docker.socket "$docker_socket exists (group $socket_gid)"
else
  fail docker.socket "$docker_socket is not a socket: docker-compose.runtime.yml mounts exactly that path into sandboxd"
fi
docker_root=
if [ $docker_ok -eq 1 ]; then docker_root=$(docker info -f '{{.DockerRootDir}}' 2>/dev/null || true); fi

disk_check() { # id path what
  local id=$1 path=$2 what=$3 size avail pct
  if [ -z "$path" ] || ! [ -e "$path" ]; then
    fail "$id" "$what: ${path:-unknown path} does not exist"
    return
  fi
  read -r size avail < <( (df -Pk "$path" 2>/dev/null || true) | awk 'NR==2 {print $2, $4}') || true
  if [ -z "${size:-}" ] || [ "$size" -le 0 ]; then
    fail "$id" "$what: could not measure the filesystem"
    return
  fi
  pct=$((avail * 100 / size))
  info "$id-size" "$what: $((size / 1048576)) GiB, $((avail / 1048576)) GiB free (recorded; no minimum is proven)"
  if [ "$pct" -lt 8 ]; then
    fail "$id" "$what: ${pct}% free, below HostDiskSpaceCritical (8%)"
  elif [ "$pct" -lt 15 ]; then
    warn "$id" "$what: ${pct}% free, below HostDiskSpaceLow (15%)"
  else
    pass "$id" "$what: ${pct}% free (alerts at 15% and 8%)"
  fi
}
if [ $docker_ok -eq 1 ]; then
  disk_check disk.docker-root "$docker_root" "Docker data root"
fi

section 'checkout'
if have git && git -C "$repo" rev-parse HEAD >/dev/null 2>&1; then
  head=$(git -C "$repo" rev-parse HEAD)
  info git.head "$head"
  if tag=$(git -C "$repo" describe --tags --exact-match HEAD 2>/dev/null); then info git.tag "$tag"; fi
  if [ -n "$(git -C "$repo" status --porcelain --untracked-files=no 2>/dev/null)" ]; then
    warn git.clean 'tracked files are modified: the deployed commit is not what is running'
  else
    pass git.clean 'no tracked file is modified'
  fi
  commit=$(env_value JTT_COMMIT || true)
  if [ -z "$commit" ]; then
    warn git.jtt-commit 'JTT_COMMIT is unset: metrics and logs will report commit "unknown"'
  elif [ "$head" = "$commit" ] || [ "${head:0:${#commit}}" = "$commit" ]; then
    pass git.jtt-commit 'JTT_COMMIT matches HEAD'
  else
    warn git.jtt-commit 'JTT_COMMIT does not match HEAD'
  fi
else
  fail git.head 'the checkout is not a git repository: the deployed commit cannot be recorded'
fi
if other_can_read "$repo" || other_can_enter "$repo"; then
  warn checkout.mode "$repo is $(mode_of "$repo"): other local accounts can reach the kubeconfig and scrape token (both must be other-readable for their containers). Use 0750 or 0700"
else
  pass checkout.mode "$repo is $(mode_of "$repo")"
fi

# Container users read these through bind mounts, as uids other than the
# operator: api/sandboxd 1000 (node), Prometheus/Alertmanager 65534, Grafana 472,
# nginx workers 101. A checkout made under umask 077 breaks every one of them.
unreadable=()
for source in labs infrastructure/observability/prometheus infrastructure/observability/grafana \
  infrastructure/observability/alertmanager/alertmanager.yml infrastructure/docker/nginx/web-tls.conf \
  infrastructure/docker/nginx/acme-webroot; do
  path=$repo/$source
  if ! [ -e "$path" ]; then
    unreadable+=("$source (missing)")
  elif [ -n "$(find "$path" \( -type f ! -perm -004 \) -o \( -type d ! -perm -001 \) 2>/dev/null | head -1)" ]; then
    unreadable+=("$source")
  fi
done
if [ ${#unreadable[@]} -eq 0 ]; then
  pass checkout.bind-mounts 'every bind-mounted configuration is readable by its container user'
else
  fail checkout.bind-mounts "not readable by the container user (other-read on files, other-execute on directories): ${unreadable[*]}. A checkout made under umask 077 does this; fix with chmod -R o+rX on those paths"
fi

section '.env'
env_ok=0
if ! [ -f "$env_file" ]; then
  fail env.file "$env_file does not exist"
else
  env_ok=1
  if group_or_other_bits "$env_file"; then
    fail env.file-mode "$env_file is $(mode_of "$env_file"): it holds every secret; chmod 600"
  else
    pass env.file-mode "$env_file is $(mode_of "$env_file")"
  fi
  if [ "$(uid_of "$env_file")" != "$(id -u)" ]; then
    warn env.file-owner "$env_file is not owned by this account"
  fi
  for name in "${secret_names[@]}" "${setting_names[@]}"; do
    if env_set "$name"; then
      pass env.present "$name: present"
    else
      fail env.present "$name: MISSING"
    fi
    if [ -n "${!name+set}" ]; then
      warn env.shell-override "$name is exported in this shell; docker compose prefers it over $env_file"
    fi
  done
  status_dir=$(env_value BACKUP_STATUS_DIR || true)
  if [ -n "$status_dir" ] && [ "${status_dir#/}" = "$status_dir" ]; then
    fail env.backup-status-dir 'BACKUP_STATUS_DIR is not an absolute path'
  fi
  gid_setting=$(env_value DOCKER_SOCKET_GID || true)
  if [ -n "$socket_gid" ] && [ -n "$gid_setting" ] && [ "$gid_setting" != "$socket_gid" ]; then
    fail env.docker-socket-gid "DOCKER_SOCKET_GID=$gid_setting but $docker_socket belongs to gid $socket_gid: sandboxd could not use the runtime"
  fi
fi

section 'tls'
tls_dir=$repo/infrastructure/docker/nginx/tls
for file in fullchain.pem privkey.pem; do
  if [ -s "$tls_dir/$file" ]; then pass "tls.$file" 'present'; else fail "tls.$file" "missing: install with scripts/tls-install.sh (docs/runbooks/production-tls.md §3)"; fi
done
if [ -e "$tls_dir/privkey.pem" ]; then
  if group_or_other_bits "$tls_dir/privkey.pem"; then
    fail tls.key-mode "privkey.pem is $(mode_of "$tls_dir/privkey.pem"): the edge refuses a key readable by group or others"
  else
    pass tls.key-mode "privkey.pem is $(mode_of "$tls_dir/privkey.pem")"
  fi
fi
origin=$(env_value PUBLIC_ORIGIN || true)
if [ -s "$tls_dir/fullchain.pem" ] && [ -n "$origin" ] && [ -x "$repo/node_modules/.bin/tsx" ]; then
  set +e
  tls_output=$(cd "$repo" && npx tsx scripts/tls-check.ts --origin "$origin" --cert-dir "$tls_dir" --offline 2>&1)
  tls_status=$?
  set -e
  case $tls_status in
    0) pass tls.certificate "matches PUBLIC_ORIGIN, chain and key valid, not within 21 days of expiry (tls:check --offline)" ;;
    1) warn tls.certificate "renewal due within 21 days (tls:check --offline): $(printf '%s' "$tls_output" | grep -m1 -E 'WARN|renew' || true)" ;;
    *) fail tls.certificate "tls:check --offline exit $tls_status: $(printf '%s' "$tls_output" | grep -m2 -E 'CRITICAL|FAIL|tls-check' | tr '\n' ' ')" ;;
  esac
else
  fail tls.certificate 'not checked: needs fullchain.pem, PUBLIC_ORIGIN and npm ci'
fi
manual tls.dns "confirm from outside the host that ${origin:-PUBLIC_ORIGIN}'s host name resolves to this host (dig +short), and that no AAAA record points elsewhere"

section 'observability'
token_dir=$repo/infrastructure/observability/secrets
token=$token_dir/scrape-token
if ! [ -s "$token" ]; then
  fail observability.scrape-token 'missing: run `make observability-token`'
else
  if other_can_read "$token" && other_can_enter "$token_dir"; then
    pass observability.scrape-token-mode "file $(mode_of "$token"), directory $(mode_of "$token_dir"): Prometheus (uid 65534) can read it"
  else
    fail observability.scrape-token-mode "file $(mode_of "$token"), directory $(mode_of "$token_dir"): Prometheus runs as uid 65534 and cannot read it, so every target would be down. Run \`make observability-token\` (0644 in a 0711 directory)"
  fi
  if [ $env_ok -eq 1 ] && env_set OBSERVABILITY_SCRAPE_TOKEN; then
    if [ "$(env_value OBSERVABILITY_SCRAPE_TOKEN | sha256)" = "$(tr -d '\n' <"$token" | sha256)" ]; then
      pass observability.scrape-token-match 'the file matches OBSERVABILITY_SCRAPE_TOKEN (compared by hash)'
    else
      fail observability.scrape-token-match 'the file differs from OBSERVABILITY_SCRAPE_TOKEN: every scrape would be refused. Run `make observability-token`'
    fi
  fi
fi
webhook_dir=$repo/infrastructure/observability/alertmanager/secrets
if [ -s "$webhook_dir/webhook-url" ]; then
  if other_can_read "$webhook_dir/webhook-url" && other_can_enter "$webhook_dir"; then
    pass observability.alert-destination-mode 'webhook-url is readable by Alertmanager (uid 65534)'
  else
    fail observability.alert-destination-mode 'webhook-url is not readable by Alertmanager (uid 65534): chmod 0644 the file and 0711 the directory'
  fi
  manual observability.alert-delivery 'a destination is installed; delivery to a person is proven only by the drill in readiness doc §12'
else
  manual observability.alert-delivery 'no alert destination is installed (DECISION REQUIRED): alerts reach nobody until one is'
fi

section 'kubernetes (kind)'
cluster=$(env_or LAB_CLUSTER_NAME jumptotech-labs)
host_kubeconfig=$repo/infrastructure/kind/generated/kubeconfig-host-$cluster.yaml
internal_kubeconfig=$repo/infrastructure/kind/generated/kubeconfig-internal.yaml
cluster_ok=0
if have kind && jtt_contains "$(kind get clusters 2>/dev/null || true)" -x "$cluster"; then
  pass kind.cluster "$cluster exists"
  cluster_ok=1
else
  fail kind.cluster "$cluster does not exist: npm run cluster:up (docs/runbooks/private-beta-operations.md §1)"
fi
if [ $docker_ok -eq 1 ] && docker network inspect kind >/dev/null 2>&1; then
  pass kind.network "the external 'kind' network exists"
else
  fail kind.network "the external 'kind' network does not exist: compose cannot start the api or terminal"
fi
if [ -s "$internal_kubeconfig" ]; then
  if grep -q "server: https://$cluster-control-plane:6443" "$internal_kubeconfig"; then
    pass kind.kubeconfig-internal "kubeconfig-internal.yaml names $cluster"
  else
    fail kind.kubeconfig-internal "kubeconfig-internal.yaml (the file compose mounts) is for a different cluster than $cluster"
  fi
  if other_can_read "$internal_kubeconfig"; then
    pass kind.kubeconfig-mode 'readable by the api (uid 1000)'
  else
    fail kind.kubeconfig-mode 'kubeconfig-internal.yaml is not readable by the api container user (uid 1000)'
  fi
else
  fail kind.kubeconfig-internal 'infrastructure/kind/generated/kubeconfig-internal.yaml is missing'
fi
# The node publishes the cluster-admin API server on the host. cluster.yaml pins
# it to 127.0.0.1:16443; a cluster created from another config (kind's own
# default included, if apiServerAddress was changed) could publish it on every
# interface, where the only thing between the internet and cluster-admin is a
# client certificate. The other-listeners check below would list it only as a
# port to confirm.
if [ $docker_ok -eq 1 ] && [ $cluster_ok -eq 1 ]; then
  api_bindings=$( (docker port "$cluster-control-plane" 2>/dev/null || true) | awk '$1 == "6443/tcp" {print $3}')
  public_bindings=$(printf '%s\n' "$api_bindings" | { grep -Ev '^(127\.[0-9.]+|\[::1\]):[0-9]+$' || true; } | { grep -v '^$' || true; } | tr '\n' ' ')
  if [ -z "$api_bindings" ]; then
    fail kind.api-server-address "could not read where $cluster-control-plane publishes its API server (docker port)"
  elif [ -n "${public_bindings// /}" ]; then
    fail kind.api-server-address "the cluster-admin API server is published on ${public_bindings% }, not loopback: recreate the cluster from infrastructure/kind/cluster.yaml (apiServerAddress 127.0.0.1)"
  else
    pass kind.api-server-address "the API server is published on loopback only ($(printf '%s' "$api_bindings" | tr '\n' ' ' | sed 's/ $//'))"
  fi
fi

attestation_digest=
kube() { KUBECONFIG=$host_kubeconfig kubectl "$@"; }
if [ $cluster_ok -eq 1 ] && [ -s "$host_kubeconfig" ] && have kubectl; then
  not_ready=$( (kube get nodes --no-headers 2>/dev/null || true) | awk '$2 != "Ready"' | wc -l | tr -d ' ')
  if kube get nodes --no-headers >/dev/null 2>&1 && [ "$not_ready" = 0 ]; then
    pass kind.nodes 'every node Ready'
  else
    fail kind.nodes 'the cluster API is unreachable or a node is not Ready'
  fi
  if jtt_contains "$(kube get --raw "/api/v1/nodes/$cluster-control-plane/proxy/configz" 2>/dev/null || true)" '"seccompDefault":true'; then
    pass kind.seccomp-default 'kubelet seccompDefault on (BETA-P0-016)'
  else
    fail kind.seccomp-default 'kubelet seccompDefault is not on: the cluster predates infrastructure/kind/cluster.yaml; recreate it before students'
  fi
  policies=$(kube get validatingadmissionpolicies -o name 2>/dev/null || true)
  missing_policies=()
  for policy in jumptotech-deny-clusterrole-bindings jumptotech-protect-managed-resources jumptotech-require-pod-security; do
    jtt_contains "$policies" "/$policy\$" || missing_policies+=("$policy")
  done
  if [ ${#missing_policies[@]} -eq 0 ]; then
    pass kind.admission-policies 'all three lab admission policies are installed'
  else
    fail kind.admission-policies "missing: ${missing_policies[*]} (kubectl apply -f infrastructure/kind/admission/lab-rbac-policy.yaml)"
  fi
  attestation=$(kube -n kube-system get configmap jumptotech-network-policy-enforcement \
    -o 'jsonpath={.data.verdict}{" "}{.data.policyDigest}{" "}{.data.clusterUid}{" "}{.data.verifiedAt}' 2>/dev/null || true)
  if [ -z "$attestation" ]; then
    fail k8s.attestation 'no NetworkPolicy enforcement attestation: the api refuses every Kubernetes lab in production (readiness doc §15 step 12)'
  else
    read -r att_verdict attestation_digest att_uid att_at <<<"$attestation"
    cluster_uid=$(kube get namespace kube-system -o 'jsonpath={.metadata.uid}' 2>/dev/null || true)
    max_age=$(env_or NETWORK_POLICY_ATTESTATION_MAX_AGE_SECONDS 604800)
    age=
    if have node; then age=$(node -e 'const t=Date.parse(process.argv[1]); console.log(Number.isNaN(t) ? "" : Math.floor((Date.now()-t)/1000))' "$att_at" 2>/dev/null || true); fi
    if [ "$att_verdict" != PASS ]; then
      fail k8s.attestation "the last enforcement probe reported ${att_verdict:-nothing}, not PASS"
    elif [ -z "$cluster_uid" ] || [ "$att_uid" != "$cluster_uid" ]; then
      fail k8s.attestation 'the attestation was recorded on a different cluster (kube-system UID)'
    elif [ -z "$age" ]; then
      fail k8s.attestation 'the attestation timestamp could not be read'
    elif [ "$age" -gt "$max_age" ]; then
      fail k8s.attestation "the attestation is ${age}s old, past NETWORK_POLICY_ATTESTATION_MAX_AGE_SECONDS=$max_age"
    elif [ "$age" -gt $((max_age - 86400)) ]; then
      warn k8s.attestation "PASS, but ${age}s old: it expires within a day (max $max_age)"
    else
      pass k8s.attestation "PASS on this cluster, ${age}s old (max $max_age); digest compared below"
    fi
  fi
else
  fail kind.nodes "not checked: needs the cluster, $host_kubeconfig and kubectl"
fi

section 'images'
image_default() { # variable, fallback: the .env value, else the compose default
  env_or "$1" "$2"
}
dind_default=$( (sed -n 's/.*DOCKER_SANDBOX_IMAGE: \${DOCKER_SANDBOX_IMAGE:-\([^}]*\)}.*/\1/p' "$repo/docker-compose.runtime.yml" 2>/dev/null || true) | head -1)
if [ $docker_ok -eq 1 ]; then
  for pair in "LINUX_SANDBOX_IMAGE jumptotech/lab-linux:latest" "TERRAFORM_SANDBOX_IMAGE jumptotech/lab-terraform:latest" \
    "ANSIBLE_SANDBOX_IMAGE jumptotech/lab-ansible:latest" "CICD_SANDBOX_IMAGE jumptotech/lab-cicd:latest"; do
    read -r variable fallback <<<"$pair"
    image=$(image_default "$variable" "$fallback")
    if docker image inspect "$image" >/dev/null 2>&1; then pass "images.$variable" "$image present"; else fail "images.$variable" "$image is missing: make sandbox-build"; fi
  done
  dind=$(image_default DOCKER_SANDBOX_IMAGE "${dind_default:-docker:27-dind}")
  if docker image inspect "$dind" >/dev/null 2>&1; then
    pass images.DOCKER_SANDBOX_IMAGE "$dind present"
  else
    warn images.DOCKER_SANDBOX_IMAGE "$dind is not present: the first Docker-track start pulls it (docker pull $dind now, so a registry outage cannot block a class)"
  fi
else
  fail images.sandbox 'not checked: the Docker daemon is unreachable'
fi

section 'network exposure'
if have ss; then
  listeners=$( (ss -Hltn 2>/dev/null || true) | awk '{print $4}')
  for port in 80 443; do
    if jtt_contains "$listeners" -E "[:.]$port\$"; then
      holder=
      if [ $docker_ok -eq 1 ]; then holder=$( (docker ps --filter "publish=$port" --format '{{.Names}}' 2>/dev/null || true) | head -1); fi
      if [ -z "$holder" ]; then
        fail "exposure.port-$port" "port $port is held by a process that is not a container: the web container cannot publish it"
      elif [[ $holder == *-web-1 ]]; then
        pass "exposure.port-$port" "port $port is published by $holder"
      else
        fail "exposure.port-$port" "port $port is published by another container ($holder)"
      fi
    else
      pass "exposure.port-$port" "port $port is free"
    fi
  done
  others=$(printf '%s\n' "$listeners" | { grep -Ev '^(127\.[0-9.]+|\[::1\]|::1)(%[^:]+)?:[0-9]+$' || true; } | { grep -Ev '[:.](80|443)$' || true; } |
    sed -E 's/.*[:.]([0-9]+)$/\1/' | sort -un | tr '\n' ' ')
  if [ -n "${others// /}" ]; then
    manual exposure.other-listeners "non-loopback TCP listeners besides 80/443: ${others% }. Confirm each is intended (SSH) and firewalled"
  else
    pass exposure.other-listeners 'no non-loopback TCP listener besides 80/443'
  fi
else
  warn exposure.listeners 'ss is not installed: listening ports were not checked'
fi
manual exposure.firewall 'Docker-published ports bypass ufw/firewalld INPUT rules. Confirm the provider firewall or the DOCKER-USER chain admits only 80, 443 and operator SSH (runtime-architecture.md §11.7)'

section 'backups'
status_dir=$(env_value BACKUP_STATUS_DIR || true)
if [ -z "$status_dir" ]; then
  fail backup.status-dir 'BACKUP_STATUS_DIR is not set in .env'
elif ! [ -d "$status_dir" ]; then
  fail backup.status-dir "$status_dir does not exist: create it owned by the backup account before the stack starts (private-beta-operations.md §1.1 step 4)"
elif ! other_can_enter "$status_dir"; then
  fail backup.status-dir "$status_dir is $(mode_of "$status_dir"): the api (uid 1000) cannot enter it; 0755"
else
  pass backup.status-dir "$status_dir exists and the api can read it"
  # db-backup.sh logs a status it cannot write and still exits 0 (db-lib.sh
  # jtt_record_status), so an unwritable directory is a backup that succeeds
  # every night while BackupStale fires. Docker creates it owned by root when
  # the stack starts before it exists (private-beta-operations.md §1.1 step 4).
  if [ -w "$status_dir" ]; then
    info backup.status-dir-writable 'writable by this account'
  else
    warn backup.status-dir-writable "$status_dir is not writable by this account (owner uid $(uid_of "$status_dir")): if the backup job runs as this account, it cannot record its outcome and BackupStale fires while backups succeed"
  fi
fi
if [ "${backup_dir#/}" = "$backup_dir" ]; then
  fail backup.dir "BACKUP_DIR $backup_dir is not absolute"
elif ! [ -d "$backup_dir" ]; then
  fail backup.dir "$backup_dir does not exist (pass --backup-dir, or create it 0700 owned by the backup account)"
else
  if group_or_other_bits "$backup_dir"; then
    warn backup.dir "$backup_dir is $(mode_of "$backup_dir"): archives hold every student's data; db-backup.sh creates it 0700"
  else
    pass backup.dir "$backup_dir is $(mode_of "$backup_dir")"
  fi
  if [ -w "$backup_dir" ]; then
    info backup.dir-writable 'writable by this account'
  else
    warn backup.dir-writable 'not writable by this account: confirm the backup job account can write it'
  fi
  if [ -n "$status_dir" ]; then
    case "${status_dir%/}/" in "${backup_dir%/}/"*) fail backup.overlap 'BACKUP_STATUS_DIR is, or is inside, BACKUP_DIR: the api must never see the archives' ;; esac
    case "${backup_dir%/}/" in "${status_dir%/}/"*) fail backup.overlap 'BACKUP_DIR is inside BACKUP_STATUS_DIR: the api would mount the archives' ;; esac
  fi
  disk_check disk.backup "$backup_dir" "backup filesystem"
  if [ -n "$docker_root" ] && [ -e "$docker_root" ] &&
    [ "$(df -P "$backup_dir" 2>/dev/null | awk 'NR==2 {print $1}')" = "$(df -P "$docker_root" 2>/dev/null | awk 'NR==2 {print $1}')" ]; then
    warn backup.filesystem 'BACKUP_DIR is on the same filesystem as Docker data (the PostgreSQL volume): one disk loss takes both'
  fi
fi
if [ -f "$cron_file" ]; then
  # A file that exists is not a schedule: every job line in it may be commented out.
  cron_jobs=$(grep -Ev '^[[:space:]]*(#|$)' "$cron_file" 2>/dev/null || true)
  if jtt_contains "$cron_jobs" 'db-backup\.sh'; then
    pass backup.schedule "$cron_file schedules scripts/db-backup.sh"
  else
    manual backup.schedule "$cron_file exists but no uncommented line runs scripts/db-backup.sh: confirm backups are scheduled (private-beta-operations.md §1.2)"
  fi
  if ! jtt_contains "$cron_jobs" 'db-restore\.sh.*--verify-only'; then
    manual backup.verify-schedule "$cron_file does not run db-restore.sh --verify-only: confirm the weekly archive verification is scheduled (private-beta-operations.md §1.2)"
  fi
  if jtt_contains "$cron_jobs" BACKUP_COPY_HOOK; then info backup.copy-hook 'the schedule names a BACKUP_COPY_HOOK'; fi
else
  manual backup.schedule "$cron_file does not exist: confirm backups and weekly verification are scheduled some other way (private-beta-operations.md §1.2)"
fi
manual backup.offhost 'off-host destination and encryption are DECISION REQUIRED; until a copy is proven off the host, a lost host loses every student record'

section 'configuration'
if [ $env_ok -eq 1 ] && [ -x "$repo/node_modules/.bin/tsx" ] && [ $skip_config_check -eq 0 ]; then
  if (cd "$repo" && jtt_bounded "${JTT_TOOL_TIMEOUT:-300}" node scripts/check-secret-distribution.mjs >/dev/null 2>&1); then
    pass config.secret-distribution 'each service receives exactly its secrets, mounts, ports and networks (make secrets-check)'
  else
    fail config.secret-distribution 'make secrets-check fails: run it for the names involved'
  fi
  set +e
  config_output=$(cd "$repo" && npx tsx scripts/production-config-check.ts --env-file "$env_file" ${socket_gid:+--docker-socket-gid "$socket_gid"} 2>&1)
  config_status=$?
  set -e
  # Its lines are already secret-free; indent them under one result, on screen
  # and in --report (the summary line below points at them). A check that died
  # before printing any result line (a tsx crash, the tool timeout) must reach
  # the "could not run" FAIL below rather than stop this script under pipefail.
  config_lines=$(printf '%s\n' "$config_output" | { grep -E '^(PASS|FAIL|WARN|INFO)' || true; })
  if [ -n "$config_lines" ]; then
    while IFS= read -r config_line; do
      printf '    %s\n' "$config_line"
      jtt_lines+=("    $config_line")
    done <<<"$config_lines"
  fi
  expected_digest=$(printf '%s\n' "$config_output" | awk '$2 == "attestation.expected-digest" {print $3}')
  config_warnings=$(printf '%s\n' "$config_output" | grep -c '^WARN' || true)
  if [ "$config_warnings" -gt 0 ]; then
    warn config.production-warnings "$config_warnings WARN line(s) above: accepted, but not the proven configuration"
  fi
  case $config_status in
    0) pass config.production "every production gate accepts this .env (npm run production:config-check)" ;;
    1) fail config.production "$(printf '%s\n' "$config_output" | grep -c '^FAIL') FAIL line(s) above: the stack would refuse to start, or would start outside the proven configuration" ;;
    *) fail config.production "the configuration check could not run: $(printf '%s\n' "$config_output" | tail -1)" ;;
  esac
  if [ -n "$attestation_digest" ] && [ -n "$expected_digest" ]; then
    if [ "$attestation_digest" = "$expected_digest" ]; then
      pass k8s.attestation-digest "the cluster's attestation was measured against the contract this .env produces"
    else
      fail k8s.attestation-digest "the attestation digest differs from what the api will demand: re-run the probe with \`env \$(npm run -s production:config-check -- --print-network-env) npm run verify:network-policy -- --write-attestation\`"
    fi
  fi
else
  fail config.production 'not run: needs .env and npm ci (or --skip-config-check was given)'
fi

section 'decisions no host check can make'
manual auth.admission 'the api admits ANY account the OIDC issuer authenticates (authentication.md §4.7). Confirm the identity provider itself admits only the beta students'
manual capacity.host-sizing 'no host size is proven: run the five-student measurement procedure on this host (readiness doc §13) before inviting students'

# --- summary ----------------------------------------------------------------------------

printf '\n%s\n' "$(jtt_summary_line)"
if [ "$jtt_fail_count" -gt 0 ]; then
  result='RESULT: FAIL — do not start the production stack on this host'
else
  result='RESULT: PASS — no check failed; every MANUAL CHECK REQUIRED still needs a person'
fi
printf '%s\n' "$result"

if [ -n "$report" ]; then
  {
    printf '# production-preflight %s\n# checkout %s\n' "$started" "$repo"
    printf '%s\n' "${jtt_lines[@]}"
    printf '%s\n%s\n' "$(jtt_summary_line)" "$result"
  } >"$report"
  printf 'report: %s\n' "$report"
fi

[ "$jtt_fail_count" -eq 0 ]
