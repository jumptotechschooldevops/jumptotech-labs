#!/usr/bin/env bash
#
# scripts/private-beta-diagnostics.sh, proven with no host, daemon or cluster.
#
#   bash scripts/test-private-beta-diagnostics.sh   (make test-private-beta-diagnostics)
#
# `docker`, `kubectl` and `kind` are fakes that answer like a production host in
# the middle of an incident, and that plant a sentinel in every place a secret or
# a student's data could come from: .env, a log message, a PostgreSQL STATEMENT,
# an nginx query string, the operator socket's owner ids, a line of terminal
# output. The real sanitizer (services/observability/src/support-bundle.ts)
# runs over them. The cases prove:
#
#   · no sentinel reaches the bundle, in any file, and the useful lines survive;
#   · every docker/kubectl invocation is a read-only verb;
#   · the bundle and its archive are private (0700 / 0600);
#   · a secret that does get through deletes the bundle and exits 1;
#   · the bundle cannot be written inside the checkout;
#   · without the sanitizer, logs are not collected — never collected raw.
set -Eeuo pipefail
set +x

source_repo=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)
work=$(mktemp -d "${TMPDIR:-/tmp}/jtt-diagnostics-test.XXXXXX")
work=$(cd "$work" && pwd -P) # macOS: /var is /private/var, and the script resolves paths
if [ "${JTT_TEST_KEEP:-}" = 1 ]; then trap 'echo "kept $work"' EXIT; else trap 'rm -rf "$work"' EXIT; fi

failures=0
pass() { printf '  ok   %s\n' "$1"; }
fail() { printf '  FAIL %s\n' "$1"; failures=$((failures + 1)); }

# --- the sentinels ------------------------------------------------------------------------
S_POSTGRES=pgpass5e17c0ffee5e17c0ffee5e17c0ffee5e17
S_INTERNAL=internal0a11ce0a11ce0a11ce0a11ce0a11ce
S_OIDC=Gocspx-oidc-client-secret-sentinel-value
S_SCRAPE=scrape7ab1e7ab1e7ab1e7ab1e7ab1e7ab1e7a
S_OWNER=owner-uuid-sentinel-7f3a
S_AUTHCODE=AUTHCODESENTINEL42
S_ROW=row-value-sentinel@example.edu
S_TERMINAL='student-typed-sentinel-cat-secret'
S_USERID=userid-sentinel-19c4

# --- a fixture checkout -------------------------------------------------------------------
fixture=$work/checkout
mkdir -p "$fixture/scripts" "$fixture/services/observability" "$fixture/infrastructure/kind/generated" "$fixture/apps/api/src"
cp "$source_repo/scripts/private-beta-diagnostics.sh" "$source_repo/scripts/production-host-lib.sh" \
  "$source_repo/scripts/diagnostics-sanitize-logs.ts" "$fixture/scripts/"
cp -R "$source_repo/services/observability/src" "$fixture/services/observability/src"
cp "$source_repo/infrastructure/secret-distribution.json" "$fixture/infrastructure/"
ln -s "$source_repo/node_modules" "$fixture/node_modules"
: >"$fixture/infrastructure/kind/generated/kubeconfig-host-jumptotech-labs.yaml"
cat >"$fixture/.env" <<ENV
NODE_ENV=production
POSTGRES_PASSWORD=$S_POSTGRES
INTERNAL_SERVICE_SECRET="$S_INTERNAL"
OIDC_CLIENT_SECRET=$S_OIDC
OBSERVABILITY_SCRAPE_TOKEN=$S_SCRAPE
RUNTIME_OWNER_ID=beta-host-1
ENV

fakebin=$work/bin
mkdir -p "$fakebin"
calls=$work/calls.log

cat >"$fakebin/docker" <<FAKE
#!/usr/bin/env bash
printf 'docker %s\n' "\$*" >>"$calls"
args=" \$* "
case \$args in
  *' version '*) echo 'client 27.3.1 · server 27.3.1 · api 1.47'; exit 0 ;;
  *' info '*) echo /var/lib/docker; exit 0 ;;
  *' system df '*) echo 'TYPE TOTAL ACTIVE SIZE'; echo "\${FAKE_SYSTEM_DF_EXTRA:-Images 12 9 8.1GB}"; exit 0 ;;
  *' network ls '*) echo jumptotech-sandboxes; exit 0 ;;
  *' inspect '*) printf 'api\trestarts=2\toom_killed=false\texit=0\tstarted=2026-09-18T05:00:00Z\n'; exit 0 ;;
esac
if [ "\$1" = ps ]; then echo 'running'; echo 'jtt-lab-3f9a2c1b77e0	running	12 minutes ago	linux'; exit 0; fi
if [ "\$1" = compose ]; then
  case \$args in
    *' ps -aq '*) echo c0ffee01; exit 0 ;;
    *' ps '*) printf 'api\trunning\thealthy\tUp 2 hours\t2026-09-18\npostgres\trunning\thealthy\tUp 2 hours\t2026-09-18\n'; exit 0 ;;
    *' logs '*api*)
      echo '{"ts":"2026-09-18T06:00:00.000Z","level":"info","service":"api","event":"http.request.completed","status":200}'
      echo '{"ts":"2026-09-18T06:00:01.000Z","level":"warn","service":"api","event":"lab.start.failed","labId":"K8S-001","outcome":"platform_error","code":"ECONNREFUSED","userId":"$S_USERID"}'
      echo '{"ts":"2026-09-18T06:00:02.000Z","level":"error","service":"api","event":"auth.callback.failed","msg":"provider rejected $S_OIDC for /auth/callback?code=$S_AUTHCODE"}'
      echo '$S_TERMINAL'
      exit 0 ;;
    *' logs '*terminal*) echo '$S_TERMINAL'; echo '{"ts":"t","level":"warn","service":"terminal","event":"terminal.attach.failed","sessionId":"sess-0123456789abcdef","code":"CREDENTIALS_UNAVAILABLE"}'; exit 0 ;;
    *' logs '*sandboxd*) echo '{"ts":"t","level":"error","service":"sandboxd","event":"http.request.failed","err":{"name":"Error","message":"internal secret $S_INTERNAL rejected"}}'; exit 0 ;;
    *' logs '*postgres*)
      echo '2026-09-18 06:00:00.000 UTC [42] ERROR:  duplicate key value violates unique constraint "users_email_key"'
      echo "2026-09-18 06:00:00.000 UTC [42] STATEMENT:  INSERT INTO users (email) VALUES ('$S_ROW')"
      echo '2026-09-18 06:00:01.000 UTC [43] FATAL:  password authentication failed for user "jumptotech"'
      exit 0 ;;
    *' logs '*web*)
      echo '203.0.113.9 - - [18/Sep/2026:06:00:00 +0000] "GET /auth/callback?code=$S_AUTHCODE&state=x HTTP/2.0" 502 0 "https://idp/?c=$S_AUTHCODE" "UA" "-"'
      echo '2026/09/18 06:00:00 [error] 29#29: *1 connect() failed (111: Connection refused) while connecting to upstream, request: "GET /auth/callback?code=$S_AUTHCODE HTTP/2.0", host: "labs.example.org"'
      exit 0 ;;
    *' exec '*operator-cli.ts*status*) printf 'new labs:        NO\n                 - capacity is full: 5 of 5 slots held\n'; exit 0 ;;
    *' exec '*operator-cli.ts*sessions*)
      echo '{"ok":true,"data":{"scope":"recent","count":1,"sessions":[{"sessionId":"sess-0123456789abcdef","labId":"LNX-001","status":"ACTIVE","ownerUserId":"$S_OWNER"}]}}'
      exit 0 ;;
    *' exec '*node*) echo '200 {"ok":true,"data":{"service":"api","ready":true}}'; exit 0 ;;
    *' exec '*promtool*) echo 'jtt_sessions_capacity_limit{instance="api:9400"} => 5 @[1]'; exit 0 ;;
    *' exec '*amtool*) echo 'Alertname  Starts At  Summary'; echo 'CapacityExhausted  2026-09-18  students are being refused'; exit 0 ;;
  esac
fi
echo "fake docker: unhandled: \$*" >&2
exit 3
FAKE

cat >"$fakebin/kubectl" <<FAKE
#!/usr/bin/env bash
printf 'kubectl %s\n' "\$*" >>"$calls"
case " \$* " in
  *' --client=true '*) echo 'clientVersion: v1.34.2' ;;
  *' get nodes '*) echo 'NAME STATUS'; echo 'jumptotech-labs-control-plane Ready' ;;
  *' get ns '*) echo 'NAME PHASE CREATED'; echo 'lab-5e1f0a Active 2026-09-18T05:00:00Z' ;;
  *' get pods -A '*) echo 'lab-5e1f0a Running'; echo 'lab-5e1f0a Pending' ;;
  *' get pods -n kube-system '*) echo 'coredns-1 Running 0' ;;
  *) echo "fake kubectl: unhandled: \$*" >&2; exit 3 ;;
esac
FAKE

cat >"$fakebin/kind" <<FAKE
#!/usr/bin/env bash
printf 'kind %s\n' "\$*" >>"$calls"
case "\$1" in version) echo 'kind v0.27.0' ;; get) echo jumptotech-labs ;; esac
FAKE
chmod +x "$fakebin"/*

# run_case NAME [ENV=VALUE...] -- [ARGS...]
run_case() {
  local name=$1
  shift
  local envs=()
  while [ $# -gt 0 ] && [ "$1" != -- ]; do envs+=("$1"); shift; done
  [ "${1:-}" = -- ] && shift
  case_dir=$work/case-$name
  mkdir -p "$case_dir/out"
  : >"$calls"
  set +e
  env PATH="$fakebin:$PATH" HOME="$case_dir" JTT_COMMAND_TIMEOUT=20 ${envs[@]+"${envs[@]}"} \
    bash "$fixture/scripts/private-beta-diagnostics.sh" --out-dir "$case_dir/out" "$@" >"$case_dir/output" 2>&1
  status=$?
  set -e
}

mode_of() { stat -c '%a' "$1" 2>/dev/null || stat -f '%Lp' "$1"; }

echo 'private-beta-diagnostics: a production host mid-incident'
run_case healthy -- --stack production
if [ "$status" -eq 0 ]; then pass 'exits 0'; else fail "exit $status: $(tail -5 "$case_dir/output")"; fi
archive=$(ls "$case_dir"/out/*.tar.gz 2>/dev/null | head -1 || true)
bundle=${archive%.tar.gz}
if [ -n "$archive" ] && [ "$(mode_of "$archive")" = 600 ]; then pass 'archive is 0600'; else fail "archive mode $(mode_of "$archive" 2>/dev/null)"; fi
if [ -d "$bundle" ] && [ "$(mode_of "$bundle")" = 700 ]; then pass 'bundle directory is 0700'; else fail 'bundle directory mode'; fi
if [ -n "$bundle" ] && [ -z "$(find "$bundle" -type f ! -perm 600 ! -perm 400)" ]; then pass 'every file is private'; else fail 'a bundle file is readable by others'; fi

extract=$case_dir/extract
mkdir -p "$extract"
tar -xzf "$archive" -C "$extract"
leaked=0
for sentinel in "$S_POSTGRES" "$S_INTERNAL" "$S_OIDC" "$S_SCRAPE" "$S_OWNER" "$S_AUTHCODE" "$S_ROW" "$S_TERMINAL" "$S_USERID"; do
  if grep -rqF -- "$sentinel" "$extract" "$case_dir/output"; then
    fail "sentinel reached the bundle or the console: ${sentinel:0:12}…"
    leaked=1
  fi
done
[ $leaked -eq 0 ] && pass 'no secret, owner id, user id, auth code, row value or terminal line in the bundle'
if grep -rqE 'STATEMENT|INSERT INTO' "$extract"; then fail 'SQL reached the bundle'; else pass 'no SQL'; fi

logs=$(find "$extract" -type d -name logs)
grep -q '"outcome":"platform_error"' "$logs/api.log" && pass 'the api warning survives, with its outcome' || fail 'api warning lost'
grep -q '"code":"CREDENTIALS_UNAVAILABLE"' "$logs/terminal.log" && pass 'the terminal warning survives' || fail 'terminal warning lost'
grep -q 'users_email_key' "$logs/postgres.log" && pass 'the PostgreSQL error survives' || fail 'postgres error lost'
grep -q '"GET /auth/callback" 502' "$logs/web.log" && pass 'the 5xx edge line survives, without its query' || fail 'edge 5xx lost'
grep -q 'unrecognised (dropped)' "$logs/api.summary" && pass 'unrecognised lines are counted, not kept' || fail 'no summary'
grep -q '"sessionId": "sess-0123456789abcdef"' "$extract"/*/40-sessions.txt && pass 'sessions are listed by id, owner removed' || fail 'sessions missing'
grep -q 'CapacityExhausted' "$extract"/*/60-alerts.txt && pass 'firing alerts are recorded' || fail 'alerts missing'
grep -q 'restarts=2' "$extract"/*/30-services.txt && pass 'restart counts are recorded' || fail 'restarts missing'

# Read-only: every docker and kubectl call is one of these shapes.
bad_calls=$(grep -vE '^(docker (version|compose version --short|info|system df|network ls|ps|inspect --format)|docker compose .* (ps|logs --no-color|exec -T (api|terminal|sandboxd) node -e|exec -T api node /app/node_modules/\.bin/tsx apps/api/src/operator-cli\.ts (status|sessions --recent --json)|exec -T prometheus promtool query instant|exec -T alertmanager amtool alert query)|kubectl (version --client|--kubeconfig [^ ]+ get )|kind (version|get clusters))' "$calls" || true)
if [ -z "$bad_calls" ]; then pass 'every docker, kubectl and kind call is read-only'; else fail "unexpected calls: $bad_calls"; fi
if grep -qE ' config( |$)| inspect [^-]| (rm|stop|restart|down|kill|delete|end) ' "$calls"; then fail 'a mutating or env-revealing verb ran'; else pass 'no config, bare inspect, rm, stop, restart, down, kill, delete or end'; fi

echo
echo 'private-beta-diagnostics: a secret that gets through is caught, and nothing is kept'
run_case leak FAKE_SYSTEM_DF_EXTRA="Images 1 1 postgres password $S_POSTGRES" -- --stack production
if [ "$status" -eq 1 ]; then pass 'exits 1'; else fail "exit $status"; fi
if [ -z "$(ls -A "$case_dir/out")" ]; then pass 'no bundle directory or archive left behind'; else fail "left: $(ls "$case_dir/out")"; fi
if grep -qF "$S_POSTGRES" "$case_dir/output"; then fail 'the leaked value was printed'; else pass 'the value is not printed, only the file and kind'; fi
grep -q 'LEAK 20-host.txt: configured-secret' "$case_dir/output" && pass 'names the file and the kind' || fail 'no LEAK line'

echo
echo 'private-beta-diagnostics: a second stack on the host, with its own env file'
S_ALT=altpass0ddba110ddba110ddba110ddba110ddba11
printf 'POSTGRES_PASSWORD=%s\nRUNTIME_OWNER_ID=beta-host-2\nCOMPOSE_PROJECT_NAME=jtt-second\n' "$S_ALT" >"$work/alt.env"
: >"$work/alt-compose.yml"
run_case altenv FAKE_SYSTEM_DF_EXTRA="Images 1 1 $S_ALT" -- --stack development --env-file "$work/alt.env" --compose-file "$work/alt-compose.yml"
if [ "$status" -eq 1 ] && grep -q 'LEAK 20-host.txt: configured-secret' "$case_dir/output"; then pass "the leak scan reads the stack's own env file"; else fail "alt env scan: exit $status"; fi
if grep -q -- "--env-file $work/alt.env" "$calls" && grep -q -- "-f $work/alt-compose.yml" "$calls"; then pass 'compose is pointed at that stack'; else fail 'compose did not get --env-file / -f'; fi
if grep -q 'label=jumptotech.io/runtime-owner=beta-host-2' "$calls"; then pass "sandboxes are filtered by that stack's runtime owner"; else fail 'owner filter not from the env file'; fi

echo
echo 'private-beta-diagnostics: refusals'
run_case inside -- --stack production --out-dir "$fixture/diagnostics"
if [ "$status" -eq 2 ] && [ ! -e "$fixture/diagnostics/jtt-diagnostics-"* ]; then pass 'refuses to write inside the checkout'; else fail "inside checkout: exit $status"; fi
rm -rf "$fixture/diagnostics"
run_case badsince -- --since '1; rm -rf /'
if [ "$status" -eq 2 ]; then pass 'refuses a --since that is not a duration'; else fail "--since: exit $status"; fi

echo
echo 'private-beta-diagnostics: without the sanitizer, logs are not collected'
mv "$fixture/node_modules" "$fixture/node_modules.off"
run_case notsx -- --stack development
mv "$fixture/node_modules.off" "$fixture/node_modules"
archive=$(ls "$case_dir"/out/*.tar.gz 2>/dev/null | head -1 || true)
mkdir -p "$case_dir/extract" && tar -xzf "$archive" -C "$case_dir/extract"
if [ -f "$(find "$case_dir/extract" -name NOT-COLLECTED.txt | head -1)" ] && [ -z "$(find "$case_dir/extract" -name 'api.log')" ]; then
  pass 'no raw logs; says why'
else
  fail 'logs were collected without the sanitizer'
fi
if grep -rqF "$S_AUTHCODE" "$case_dir/extract"; then fail 'raw log content reached the bundle'; else pass 'nothing raw'; fi
grep -q 'secret scan could not run' "$case_dir/output" && pass 'warns that the scan did not run' || fail 'no scan warning'
if [ ! -e "$(find "$case_dir/extract" -name 60-alerts.txt | head -1)" ]; then pass 'a development stack has no alert section'; else fail 'alerts on development'; fi

echo
if [ "$failures" -eq 0 ]; then echo 'all diagnostics cases passed'; else echo "$failures diagnostics case(s) FAILED"; exit 1; fi
