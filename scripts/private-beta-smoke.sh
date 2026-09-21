#!/usr/bin/env bash
#
# Private-beta smoke and evidence — is the RUNNING production stack on this host
# serving the beta the way it was proven, and what can only a person confirm?
#
#   scripts/private-beta-smoke.sh [--origin https://host] [--connect IP]
#                                 [--public-ip IP] [--report-dir DIR]
#   make private-beta-smoke ARGS="--public-ip 203.0.113.10 --report-dir /srv/jumptotech/evidence"
#
# Run on the production host, from the checkout the stack was started from,
# after `prod up -d` and before students are invited; again after every restart,
# upgrade or incident. docs/development/production-host-readiness.md §16.
#
# Same vocabulary as the preflight (scripts/production-host-lib.sh): PASS, FAIL,
# WARN, INFO, and MANUAL CHECK REQUIRED for what no script on this host can
# prove — a real student sign-in, alert delivery to a person, reachability from
# outside. A MANUAL line is never a pass.
#
# ## It is non-destructive
#
# Read-only requests and queries only: `docker compose ps/exec/port`,
# `docker inspect`, HTTP GETs, one unauthenticated POST to a path nginx must not
# route, Prometheus and Alertmanager queries. It starts, stops, restarts and
# creates nothing, and needs no student account. It never signs in.
#
# ## What kind of proof each line is
#
# Every section header names its proof class, because they are not
# interchangeable:
#
#   LOCAL ENDPOINT PROOF      a request to 127.0.0.1 inside a container
#   HOST-LOCAL PROOF          the Docker daemon's view on this host
#   PUBLIC-ENDPOINT PROOF     a request to the public name, made from this host.
#                             It proves the edge serves that name with a trusted
#                             certificate; the packets may never leave the host,
#                             so it does NOT prove the internet can reach it
#   EXTERNAL-INFRASTRUCTURE   DNS as others see it, the provider firewall, a
#                             person receiving an alert: always MANUAL CHECK REQUIRED
#
# Every network call is bounded: curl --max-time (JTT_SMOKE_CURL_TIMEOUT, 15 s),
# docker and npx through scripts/production-host-lib.sh's timeouts.
#
# ## It never prints a secret
#
# It reads no secret. .env supplies PUBLIC_ORIGIN only. Response bodies are
# inspected, never printed.
#
# Exit: 0 no FAIL · 1 at least one FAIL · 2 usage error.
set -Eeuo pipefail
set +x
umask 077

repo=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)
# shellcheck source=scripts/production-host-lib.sh
. "$repo/scripts/production-host-lib.sh"
jtt_repo=$repo

env_file=$repo/.env
origin=
connect=
public_ip=
report_dir=
curl_timeout=${JTT_SMOKE_CURL_TIMEOUT:-15}

usage() {
  sed -n '3,12p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
  cat <<'USAGE'
Options:
  --origin URL       the public origin (default: PUBLIC_ORIGIN from .env)
  --connect IP       connect to this address instead of DNS (before DNS is live); the Host/SNI stay the origin's
  --public-ip IP     also probe this host's public address for ports that must be closed (from the host itself)
  --report-dir DIR   write the evidence file there (no secrets)
  --env-file FILE    where PUBLIC_ORIGIN is read (default: <checkout>/.env); the
                     stack itself always runs with <checkout>/.env
USAGE
}

while [ $# -gt 0 ]; do
  case $1 in
    --origin) [ $# -ge 2 ] || { usage >&2; exit 2; }; origin=$2; shift 2 ;;
    --connect) [ $# -ge 2 ] || { usage >&2; exit 2; }; connect=$2; shift 2 ;;
    --public-ip) [ $# -ge 2 ] || { usage >&2; exit 2; }; public_ip=$2; shift 2 ;;
    --report-dir) [ $# -ge 2 ] || { usage >&2; exit 2; }; report_dir=$2; shift 2 ;;
    --env-file) [ $# -ge 2 ] || { usage >&2; exit 2; }; env_file=$2; shift 2 ;;
    -h | --help) usage; exit 0 ;;
    *) echo "private-beta-smoke: unknown argument: $1" >&2; usage >&2; exit 2 ;;
  esac
done

if [ -z "$origin" ]; then origin=$(jtt_env_value "$env_file" PUBLIC_ORIGIN || true); fi
if ! [[ $origin =~ ^https://([a-z0-9.-]+)$ ]]; then
  echo "private-beta-smoke: need --origin https://<host> or PUBLIC_ORIGIN in $env_file (a bare https origin)" >&2
  exit 2
fi
host=${BASH_REMATCH[1]}
for address in "$connect" "$public_ip"; do
  if [ -n "$address" ] && ! [[ $address =~ ^[0-9A-Fa-f:.]+$ ]]; then
    echo "private-beta-smoke: --connect and --public-ip take an IP address" >&2
    exit 2
  fi
done

started=$(date -u +%Y-%m-%dT%H:%M:%SZ)
head=$(git -C "$repo" rev-parse HEAD 2>/dev/null || echo unknown)
printf 'JumpToTech Labs private-beta smoke — %s\n' "$started"
printf 'checkout %s at %s; origin %s\n' "$repo" "$head" "$origin"

# curl against the public edge. --resolve keeps SNI and Host as the origin's.
edge_curl() {
  local args=(-sS --max-time "$curl_timeout" --proto '=https,http')
  if [ -n "$connect" ]; then args+=(--resolve "$host:443:$connect" --resolve "$host:80:$connect"); fi
  curl "${args[@]}" "$@"
}

# One PromQL expression, answered inside Prometheus's namespace (runbook `q`).
# Prints `value` per series, one per line, as `labels value`.
q() {
  jtt_prod exec -T prometheus promtool query instant http://127.0.0.1:9090 "$1" 2>/dev/null |
    sed -nE 's/^(.*) => ([^ ]+) @.*/\1 \2/p'
}
q_first() { q "$1" | awk 'NR==1 {print $NF}'; }

section 'stack — HOST-LOCAL PROOF (the Docker daemon on this host)'
services=(postgres api terminal sandboxd web prometheus alertmanager grafana)
if ! ps_output=$(jtt_prod ps -a --format '{{.Service}}|{{.State}}|{{.Health}}|{{.Name}}' 2>&1); then
  fail stack.compose "docker compose ps failed: $(printf '%s' "$ps_output" | tail -1)"
  ps_output=
fi
for service in "${services[@]}"; do
  row=$(printf '%s\n' "$ps_output" | awk -F'|' -v s="$service" '$1 == s' | head -1)
  if [ -z "$row" ]; then
    fail "stack.$service" 'not running (no container)'
    continue
  fi
  IFS='|' read -r _ state health name <<<"$row"
  if [ "$state" != running ]; then
    fail "stack.$service" "state $state"
  elif [ -n "$health" ] && [ "$health" != healthy ]; then
    fail "stack.$service" "running, health $health"
  else
    pass "stack.$service" "running${health:+, $health}"
  fi
  if restart=$(docker inspect -f '{{.RestartCount}} {{.HostConfig.RestartPolicy.Name}}' "$name" 2>/dev/null); then
    read -r count policy <<<"$restart"
    if [ "${count:-0}" -gt 0 ]; then warn "stack.$service-restarts" "restarted $count time(s) by Docker since it was created"; fi
    if [ "$policy" != unless-stopped ]; then
      fail "stack.$service-restart-policy" "restart policy '${policy:-no}', not unless-stopped as docker-compose.production.yml ships: was the stack started without the production overlays?"
    fi
  fi
done

section 'readiness — LOCAL ENDPOINT PROOF (loopback inside each container)'
for pair in 'api 9400' 'terminal 9401' 'sandboxd 9402'; do
  read -r service port <<<"$pair"
  if code=$(jtt_prod exec -T "$service" node -e \
    "fetch('http://127.0.0.1:$port/readyz').then(r => { console.log(r.status); process.exit(r.ok ? 0 : 1) }).catch(() => { console.log('unreachable'); process.exit(1) })" 2>/dev/null); then
    pass "ready.$service" "/readyz $code"
  else
    fail "ready.$service" "/readyz ${code:-unreachable}"
  fi
done

section 'runtime — LOCAL ENDPOINT PROOF (the api, from inside its container)'
health_json=$(jtt_prod exec -T api node -e \
  "fetch('http://127.0.0.1:4000/health').then(r => r.text()).then(t => console.log(t)).catch(() => process.exit(1))" 2>/dev/null || true)
if [ -z "$health_json" ]; then
  fail runtime.health 'the api /health endpoint did not answer'
else
  # Parsed on the host; only names, booleans, counts and provider reasons are printed.
  while IFS='|' read -r status id detail; do
    [ -n "$status" ] && jtt_record "$status" "$id" "$detail"
  done < <(printf '%s' "$health_json" | node -e '
    let text = ""; process.stdin.on("data", (d) => (text += d)).on("end", () => {
      let h; try { h = JSON.parse(text); h = h.data ?? h; } catch { console.log("FAIL|runtime.health|/health is not JSON"); return; }
      const out = (s, id, d) => console.log(`${s}|${id}|${String(d).replace(/[|\n]/g, " ")}`);
      out(h.labsLoaded > 0 ? "PASS" : "FAIL", "runtime.labs", `${h.labsLoaded ?? 0} labs loaded, ${(h.labLoadErrors ?? []).length} load errors`);
      const p = h.progress ?? {};
      out(p.store === "postgres" && p.durable === true && p.ok === true ? "PASS" : "FAIL", "runtime.progress-store", `store ${p.store}, durable ${p.durable}, ok ${p.ok}`);
      const s = h.sessions ?? {};
      out(s.maxActive === 5 ? "PASS" : "FAIL", "runtime.capacity", `maxActive ${s.maxActive} (contract 5), active ${s.active}`);
      for (const provider of h.providers ?? []) {
        if (!provider.registered) continue;
        // AWS labs are simulated on the Linux sandbox; the aws provider is unavailable by design.
        const status = provider.available ? "PASS" : provider.provider === "aws" ? "INFO" : "FAIL";
        out(status, `runtime.provider-${provider.provider}`, provider.available ? "available" : `unavailable: ${provider.reason ?? "no reason given"}`);
      }
    });' 2>/dev/null || echo 'FAIL|runtime.health|could not parse /health')
fi
if jtt_prod exec -T postgres sh -c 'pg_isready -q -U "$POSTGRES_USER" -d "$POSTGRES_DB"' >/dev/null 2>&1; then
  pass database.ready 'pg_isready inside the postgres container'
else
  fail database.ready 'pg_isready failed'
fi

section 'public edge — PUBLIC-ENDPOINT PROOF, requested FROM THIS HOST (not proof the internet can reach it)'
root_code=$(edge_curl -o /dev/null -w '%{http_code}' "https://$host/" 2>/dev/null) && root_status=0 || root_status=$?
if [ "$root_status" -eq 0 ] && [ "$root_code" = 200 ]; then
  pass edge.https "https://$host/ answers 200 with a certificate this host's CA store trusts${connect:+ (connected to $connect, not through DNS)}"
elif [ "$root_status" -eq 60 ] || [ "$root_status" -eq 35 ] || [ "$root_status" -eq 51 ]; then
  fail edge.https "https://$host/: TLS verification failed (curl exit $root_status)"
else
  fail edge.https "https://$host/: HTTP ${root_code:-none}, curl exit $root_status"
fi
if jtt_contains "$(edge_curl -o /dev/null -D - "https://$host/" 2>/dev/null || true)" -i '^strict-transport-security:'; then
  pass edge.hsts 'Strict-Transport-Security is sent'
else
  fail edge.hsts 'no Strict-Transport-Security header'
fi
redirect=$(edge_curl -o /dev/null -w '%{http_code} %{redirect_url}' "http://$host/jtt-smoke?probe=1" 2>/dev/null || true)
if [ "$redirect" = "301 https://$host/jtt-smoke?probe=1" ]; then
  pass edge.http-redirect 'port 80 answers 301 to the same path over https'
else
  fail edge.http-redirect "port 80 answered '${redirect:-nothing}', not a 301 to https://$host/jtt-smoke?probe=1"
fi
if [ -x "$repo/node_modules/.bin/tsx" ]; then
  set +e
  tls_output=$(cd "$repo" && npx tsx scripts/tls-check.ts --origin "$origin" --cert-dir infrastructure/docker/nginx/tls --expect-acme ${connect:+--connect "$connect"} 2>&1)
  tls_status=$?
  set -e
  case $tls_status in
    0) pass edge.tls-check 'files, served certificate, redirect and ACME route OK (npm run tls:check)' ;;
    1) warn edge.tls-check "renewal due: $(printf '%s\n' "$tls_output" | grep -m1 -iE 'warn|renew' || true)" ;;
    *) fail edge.tls-check "tls:check exit $tls_status: $(printf '%s\n' "$tls_output" | grep -m2 -E 'CRITICAL|FAIL|tls-check' | tr '\n' ' ')" ;;
  esac
else
  fail edge.tls-check 'not run: npm ci is needed for npm run tls:check'
fi

section 'authentication boundary — PUBLIC-ENDPOINT PROOF, from this host'
auth_config=$(edge_curl "https://$host/auth/config" 2>/dev/null || true)
if jtt_contains "$auth_config" '"mode":"oidc"' && jtt_contains "$auth_config" '"signInAvailable":true'; then
  pass auth.config 'mode oidc, sign-in available'
else
  fail auth.config '/auth/config does not report mode oidc with sign-in available'
fi
for probe in '/api/me|' '/api/labs|' '/api/sessions|' '/api/me|Authorization: Developer beta-student-1' '/api/me|x-dev-student-id: beta-student-1'; do
  path=${probe%%|*}
  header=${probe#*|}
  code=$(edge_curl -o /dev/null -w '%{http_code}' ${header:+-H "$header"} "https://$host$path" 2>/dev/null || true)
  label=${header%%:*}
  if [ -n "$label" ]; then
    id=auth.dev-identity-refused-$(printf '%s' "$label" | tr '[:upper:]' '[:lower:]')
  else
    id=auth.required$path
  fi
  if [ "$code" = 401 ]; then
    pass "$id" "GET $path${label:+ with $label} is 401"
  else
    fail "$id" "GET $path${label:+ with $label} is ${code:-no answer}, not 401: development authentication must never answer in production"
  fi
done
login=$(edge_curl -o /dev/null -w '%{http_code} %{redirect_url}' "https://$host/auth/login" 2>/dev/null || true)
read -r login_code login_location <<<"$login"
if [ "$login_code" = 302 ] && [[ ${login_location:-} =~ ^https://([^/]+)/ ]] && [ "${BASH_REMATCH[1]}" != "$host" ]; then
  pass auth.login-redirect "sign-in redirects to the identity provider at ${BASH_REMATCH[1]} (discovery reachable)"
else
  fail auth.login-redirect "GET /auth/login answered ${login_code:-nothing}: sign-in cannot reach the identity provider"
fi

section 'private paths through the edge — PUBLIC-ENDPOINT PROOF, from this host'
# An empty body proves nothing when the request itself failed (edge down, TLS
# refused): those are FAILs that say the check could not run, never PASSes.
if ! internal=$(edge_curl -X POST -H 'content-type: application/json' --data '{}' "https://$host/internal/sessions/jtt-smoke/credentials" 2>/dev/null); then
  fail edge.internal-not-routed 'could not check: the request to the edge failed (see edge.https)'
elif jtt_contains "$internal" 'internal service use only'; then
  fail edge.internal-not-routed 'POST /internal/... reached the api through the public edge'
else
  pass edge.internal-not-routed '/internal is not routed to the api'
fi
for path in /metrics /readyz /health; do
  if ! body=$(edge_curl "https://$host$path" 2>/dev/null); then
    fail "edge.not-routed$path" 'could not check: the request to the edge failed (see edge.https)'
  elif jtt_contains "$body" -E '^# (HELP|TYPE) |"service":"api"|jtt_'; then
    fail "edge.not-routed$path" "GET $path returned an api/metrics response through the public edge"
  else
    pass "edge.not-routed$path" "GET $path does not reach a service"
  fi
done

section 'exposure — HOST-LOCAL PROOF (published ports, networks); EXTERNAL-INFRASTRUCTURE is manual'
unexpected=()
published=()
if ids=$(jtt_prod ps -q 2>/dev/null) && [ -n "$ids" ]; then
  while read -r id; do
    [ -n "$id" ] || continue
    name=$( (docker inspect -f '{{.Name}}' "$id" 2>/dev/null || echo "$id") | sed 's#^/##')
    while read -r mapping; do
      [ -n "$mapping" ] || continue
      # "8443/tcp -> 0.0.0.0:443"
      target=${mapping%% *}
      bind=${mapping##*-> }
      published+=("$name:$bind->$target")
      case "$target $bind" in
        '8443/tcp 0.0.0.0:443' | '8443/tcp [::]:443' | '8443/tcp :::443') ;;
        '8080/tcp 0.0.0.0:80' | '8080/tcp [::]:80' | '8080/tcp :::80') ;;
        '3000/tcp 127.0.0.1:'*) ;;
        *) unexpected+=("$name $bind->$target") ;;
      esac
    done < <(docker port "$id" 2>/dev/null || true)
  done <<<"$ids"
  if [ ${#unexpected[@]} -eq 0 ] && [ ${#published[@]} -gt 0 ]; then
    pass exposure.published "only 443, 80 and loopback Grafana are published (${#published[@]} bindings)"
  elif [ ${#published[@]} -eq 0 ]; then
    fail exposure.published 'no published port found: the edge is not published'
  else
    fail exposure.published "unexpected publication: ${unexpected[*]}"
  fi
else
  fail exposure.published 'could not list the stack containers'
fi
# exposure.published sees this compose project only. Anything else running on
# the daemon — the kind node, a validation stack left from the synthetic gate
# (readiness doc §13.1), a debug container — publishes past it, and the
# --public-ip probe covers a fixed list of ports. Every container here may bind
# loopback; only this project's web may bind anything else, and only 443/80.
web_container=$(printf '%s\n' "$ps_output" | awk -F'|' '$1 == "web" {print $4}' | head -1)
if all_ports=$(docker ps --format '{{.Names}}|{{.Ports}}' 2>/dev/null); then
  host_public=()
  while IFS='|' read -r container ports; do
    [ -n "$container" ] || continue
    IFS=',' read -r -a entries <<<"$ports"
    for entry in ${entries[@]+"${entries[@]}"}; do
      # "0.0.0.0:443->8443/tcp", "[::]:443->8443/tcp", "127.0.0.1:3001->3000/tcp"; "4002/tcp" is not published.
      # Docker joins them with ", ".
      entry=${entry# }
      case $entry in *'->'*) ;; *) continue ;; esac
      bind=${entry%%->*}
      case ${bind%:*} in 127.* | '[::1]' | ::1) continue ;; esac
      if [ -n "$web_container" ] && [ "$container" = "$web_container" ]; then
        case $entry in *:443'->8443/tcp' | *:80'->8080/tcp') continue ;; esac
      fi
      host_public+=("$container $entry")
    done
  done <<<"$all_ports"
  if [ ${#host_public[@]} -eq 0 ]; then
    pass exposure.host-containers 'no container on this daemon publishes beyond loopback except the edge on 443/80'
  else
    fail exposure.host-containers "published beyond loopback: ${host_public[*]}"
  fi
else
  fail exposure.host-containers 'could not list the containers on this daemon'
fi
postgres_id=$(jtt_prod ps -q postgres 2>/dev/null | head -1 || true)
if [ -n "$postgres_id" ]; then
  internal_all=1
  networks=$(docker inspect -f '{{range $name, $_ := .NetworkSettings.Networks}}{{$name}} {{end}}' "$postgres_id" 2>/dev/null || true)
  for network in $networks; do
    [ "$(docker network inspect -f '{{.Internal}}' "$network" 2>/dev/null)" = true ] || internal_all=0
  done
  if [ -n "$networks" ] && [ $internal_all -eq 1 ]; then
    pass exposure.database-network "postgres is only on internal networks ($networks)"
  else
    fail exposure.database-network "postgres is on a network with a route off the host: ${networks:-none found}"
  fi
else
  fail exposure.database-network 'no postgres container'
fi
if [ -n "$public_ip" ]; then
  open=()
  for port in 22 3000 3001 4000 4001 4002 5432 6443 9090 9093 9400 9401 9402 16443; do
    # Open means the TCP handshake completed, not that curl exited 0: almost
    # every port here (PostgreSQL, HTTP, TLS, SSH after its banner) waits for
    # the client, so an open port ends in curl's time limit (28), exactly like
    # a filtered one. time_connect is 0 unless a connection was made.
    connected=$(curl -s --connect-timeout 3 --max-time 3 -o /dev/null -w '%{time_connect}' "telnet://$public_ip:$port" </dev/null 2>/dev/null || true)
    if awk -v t="${connected:-0}" 'BEGIN { exit !(t + 0 > 0) }'; then open+=("$port"); fi
  done
  if [ ${#open[@]} -eq 0 ]; then
    pass exposure.public-ip "from this host, $public_ip refuses 22, 3000-3001, 4000-4002, 5432, 6443, 9090, 9093, 9400-9402, 16443"
  elif [ "${open[*]}" = 22 ]; then
    info exposure.public-ip "from this host, only 22 (SSH) answers on $public_ip among the probed ports"
  else
    fail exposure.public-ip "from this host, $public_ip answers on: ${open[*]}"
  fi
  manual exposure.external "from a machine OUTSIDE this host's network: only 80 and 443 (and SSH if intended) may answer on $public_ip, e.g. nc -zv -w3 $public_ip 22 80 443 3001 4000 5432 9090 16443 — this host cannot see its own provider firewall"
else
  manual exposure.external 'pass --public-ip, and scan the public address from a machine outside the host: only 80 and 443 (and SSH if intended) may answer'
fi

section 'observability — LOCAL ENDPOINT PROOF (inside the monitoring namespace)'
up=$(q 'up' || true)
if [ -z "$up" ]; then
  fail observability.targets 'Prometheus returned no targets (is it running, and can it read the scrape token?)'
else
  down=$(printf '%s\n' "$up" | awk '$NF != 1' | sed -nE 's/.*job="([^"]+)".*/\1/p' | sort -u | tr '\n' ' ')
  if [ -z "${down// /}" ]; then
    pass observability.targets "$(printf '%s\n' "$up" | wc -l | tr -d ' ') scrape targets up"
  else
    fail observability.targets "targets down: ${down% }"
  fi
fi
firing=$(q 'ALERTS{alertstate="firing"}' | sed -nE 's/.*alertname="([^"]+)".*/\1/p' | sort -u | tr '\n' ' ' || true)
if [ -z "$up" ]; then
  # q prints nothing both for "no alert" and for "Prometheus did not answer".
  fail observability.alerts 'could not check: Prometheus did not answer (see observability.targets)'
elif [ -z "${firing// /}" ]; then
  pass observability.alerts 'no alert is firing'
else
  warn observability.alerts "firing: ${firing% } (docs/runbooks/private-beta-operations.md §3 decides whether students may launch)"
fi
if jtt_prod exec -T alertmanager amtool alert query --alertmanager.url=http://127.0.0.1:9093 >/dev/null 2>&1; then
  pass observability.alertmanager 'Alertmanager answers inside its namespace'
else
  fail observability.alertmanager 'Alertmanager did not answer'
fi
if jtt_contains "$(jtt_prod exec -T prometheus wget -qO- http://127.0.0.1:3000/api/health 2>/dev/null || true)" '"database": *"ok"'; then
  pass observability.grafana 'Grafana is healthy inside the namespace'
else
  fail observability.grafana 'Grafana /api/health is not ok'
fi
limit=$(q_first 'jtt_sessions_capacity_limit' || true)
per_student=$(q_first 'jtt_sessions_per_student_limit' || true)
if [ "$limit" = 5 ] && [ "$per_student" = 1 ]; then
  pass capacity.deployed 'jtt_sessions_capacity_limit 5, jtt_sessions_per_student_limit 1'
else
  fail capacity.deployed "deployed limits are ${limit:-unknown} / ${per_student:-unknown}, not the proven 5 / 1"
fi
info capacity.active "sessions active now: $(q_first 'sum(jtt_sessions_active)' || echo unknown)"
attested=$(q_first 'jtt_network_isolation_attestation_valid' || true)
if [ "$attested" = 1 ]; then
  pass k8s.attestation 'the api accepts the NetworkPolicy enforcement attestation'
else
  fail k8s.attestation "jtt_network_isolation_attestation_valid is ${attested:-absent}: Kubernetes labs are refused (RB-18)"
fi

# What is running, against the checkout. Each service reports JTT_COMMIT from
# the environment it was created with (jtt_build_info). A service that was not
# re-created after an upgrade or a rollback, or a JTT_COMMIT left from the last
# release, reports another commit while every health check passes.
if [ -n "$up" ]; then
  build_info=$(q 'jtt_build_info' || true)
  reported=$(printf '%s\n' "$build_info" | sed -nE 's/.*commit="([^"]*)".*service="([^"]*)".*/\2=\1/p; s/.*service="([^"]*)".*commit="([^"]*)".*/\1=\2/p' | sort -u)
  mismatched=() unknown=()
  for pair in $reported; do
    svc=${pair%%=*} sha=${pair#*=}
    if [ -z "$sha" ] || [ "$sha" = unknown ]; then
      unknown+=("$svc")
    elif [ "$head" = unknown ] || [ "${head:0:${#sha}}" != "$sha" ] || [ "${#sha}" -lt 7 ]; then
      mismatched+=("$svc=$sha")
    fi
  done
  if [ -z "$reported" ]; then
    fail release.commit 'no service reports jtt_build_info: which software is running cannot be established'
  elif [ ${#mismatched[@]} -gt 0 ]; then
    fail release.commit "running services report another commit than the checkout (${head:0:12}): ${mismatched[*]}. Set JTT_COMMIT in .env to \`git rev-parse HEAD\` and \`prod up -d --build --wait\`"
  elif [ ${#unknown[@]} -gt 0 ]; then
    warn release.commit "${unknown[*]} report commit unknown: set JTT_COMMIT in .env to \`git rev-parse HEAD\` and \`prod up -d --wait\`, so the running release can be attested"
  else
    pass release.commit "api, terminal and sandboxd report the checkout's commit ${head:0:12}"
  fi
else
  fail release.commit 'could not check: Prometheus did not answer (see observability.targets)'
fi

days=$(q_first 'jtt:tls_certificate_expiry:seconds / 86400' || true)
if [ -z "$days" ]; then
  fail tls.expiry-metric 'no certificate expiry is measured'
else
  whole=${days%%.*}
  if [ "${whole:-0}" -lt 7 ]; then fail tls.expiry-metric "certificate expires in ${whole} day(s)"
  elif [ "$whole" -lt 21 ]; then warn tls.expiry-metric "certificate expires in ${whole} days: renew (RB-15)"
  else pass tls.expiry-metric "certificate expires in ${whole} days"; fi
fi

section 'backups — LOCAL ENDPOINT PROOF (what the backup job recorded)'
backup_age=$(q_first 'jtt:backup_age:seconds{operation="backup"}' || true)
if [ -z "$backup_age" ]; then
  fail backup.recent 'no successful backup has been recorded (run scripts/db-backup.sh and schedule it)'
else
  hours=$(( ${backup_age%%.*} / 3600 ))
  # BackupStale's 26 hours, not a bare 24: a daily job's last success is a
  # little over 24 hours old just before the next run, and a smoke at that
  # minute failed a schedule that was working.
  if [ "${backup_age%%.*}" -le 93600 ]; then pass backup.recent "last successful backup ${hours}h ago (daily schedule, 24h RPO; BackupStale at 26h)"; else fail backup.recent "last successful backup ${hours}h ago: past BackupStale's 26h, so a daily run was missed"; fi
fi
verify_age=$(q_first 'jtt:backup_age:seconds{operation="verify"}' || true)
if [ -z "$verify_age" ]; then
  warn backup.verified 'no archive verification has been recorded (weekly, private-beta-operations.md §1.2)'
elif [ "${verify_age%%.*}" -le $((8 * 86400)) ]; then
  pass backup.verified "last verification $(( ${verify_age%%.*} / 86400 )) day(s) ago"
else
  warn backup.verified "last verification $(( ${verify_age%%.*} / 86400 )) days ago: the schedule is weekly"
fi
offhost=$(q 'jtt_backup_last_success_offhost' | awk '{print $NF}' | sort -r | head -1 || true)
if [ "$offhost" = 1 ]; then
  pass backup.offhost 'the last backup reports an off-host copy'
else
  fail backup.offhost 'no off-host copy is recorded (DECISION REQUIRED): a lost host loses every student record'
fi
manual backup.restore 'restore the newest archive beside production with scripts/db-restore.sh --into and validate it (postgres-backup-restore.md §6.3); record the archive name and result'

section 'EXTERNAL-INFRASTRUCTURE and PERSON — no script on this host can prove these'
manual student.flow 'sign in at the public origin as a beta account; start LINUX-001; type in the terminal; Check Solution; Reset; End Lab. Record times (readiness doc §16)'
manual auth.admission 'sign in with an account that is NOT on the beta list: it must be refused by the identity provider. The platform admits any account the issuer authenticates'
manual alerts.delivery 'fire the drill alert (readiness doc §12) and confirm a person received it; record who, where and when'
manual operator.grafana 'open Grafana through ssh -L 3001:127.0.0.1:3001 and sign in; confirm the private-beta dashboard renders'

printf '\n%s\n' "$(jtt_summary_line)"
if [ "$jtt_fail_count" -gt 0 ]; then
  result='RESULT: FAIL — do not invite students to this deployment'
else
  result='RESULT: PASS — no automated check failed; every MANUAL CHECK REQUIRED still needs a person before students are invited'
fi
printf '%s\n' "$result"

if [ -n "$report_dir" ]; then
  mkdir -p "$report_dir"
  report=$report_dir/private-beta-smoke-$(date -u +%Y%m%dT%H%M%SZ).txt
  {
    printf '# private-beta-smoke %s\n# checkout %s\n# commit %s\n# origin %s\n' "$started" "$repo" "$head" "$origin"
    printf '# THIS FILE IS EVIDENCE FROM THE HOST IT RAN ON. It proves nothing about any other host.\n'
    printf '%s\n' "${jtt_lines[@]}"
    printf '%s\n%s\n' "$(jtt_summary_line)" "$result"
  } >"$report"
  printf 'evidence: %s\n' "$report"
fi

[ "$jtt_fail_count" -eq 0 ]
