#!/usr/bin/env bash
#
# Host capacity sampler — what did this host actually use while students worked?
#
#   scripts/host-capacity-sample.sh --out-dir DIR [--interval 15] [--duration 3600] [--kubeconfig FILE]
#   make host-capacity-sample ARGS="--out-dir /srv/jumptotech/evidence/capacity-$(date -u +%Y%m%d)"
#
# Host sizing for the private beta is NOT proven: the release gate's resource
# figures are one laptop's. This records the numbers the five-student host
# validation needs (docs/development/production-host-readiness.md §13), on the
# host itself, while the five-student gate or a five-person rehearsal runs:
#
#   host.csv        time, load 1/5, CPUs, memory total/available, swap used,
#                   Docker data root size/available, running containers,
#                   platform-managed sandbox containers, Kubernetes Pods
#   containers.csv  time, container, CPU %, memory used (MiB), PIDs
#
# It judges nothing and has no thresholds: acceptable limits are a product
# decision (§13). At the end, or on Ctrl-C, it prints the peaks.
#
# Read-only: /proc, df, `docker ps`, `docker stats --no-stream`, `kubectl get
# pods`. It starts, stops and creates nothing, and reads no secret.
#
# Exit: 0 sampled · 2 usage error or nothing could be sampled.
set -Eeuo pipefail
set +x

repo=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)
# shellcheck source=scripts/production-host-lib.sh
. "$repo/scripts/production-host-lib.sh"

interval=15
duration=3600
out_dir=
kubeconfig=
proc_root=${JTT_PROC_ROOT:-/proc}

usage() {
  sed -n '3,6p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
}

while [ $# -gt 0 ]; do
  case $1 in
    --interval) [ $# -ge 2 ] || { usage >&2; exit 2; }; interval=$2; shift 2 ;;
    --duration) [ $# -ge 2 ] || { usage >&2; exit 2; }; duration=$2; shift 2 ;;
    --out-dir) [ $# -ge 2 ] || { usage >&2; exit 2; }; out_dir=$2; shift 2 ;;
    --kubeconfig) [ $# -ge 2 ] || { usage >&2; exit 2; }; kubeconfig=$2; shift 2 ;;
    -h | --help) usage; exit 0 ;;
    *) echo "host-capacity-sample: unknown argument: $1" >&2; usage >&2; exit 2 ;;
  esac
done
if [ -z "$out_dir" ] || ! [[ $interval =~ ^[0-9]+$ ]] || ! [[ $duration =~ ^[0-9]+$ ]] || [ "$interval" -lt 1 ]; then
  usage >&2
  exit 2
fi
if ! have docker || ! docker info >/dev/null 2>&1; then
  echo 'host-capacity-sample: the Docker daemon is not reachable' >&2
  exit 2
fi

mkdir -p "$out_dir"
host_csv=$out_dir/host.csv
containers_csv=$out_dir/containers.csv
[ -s "$host_csv" ] || echo 'time,load1,load5,cpus,mem_total_mib,mem_available_mib,swap_used_mib,docker_root_size_mib,docker_root_available_mib,containers_running,sandbox_containers,pods' >"$host_csv"
[ -s "$containers_csv" ] || echo 'time,container,cpu_percent,memory_mib,pids' >"$containers_csv"

docker_root=$(docker info -f '{{.DockerRootDir}}' 2>/dev/null || echo /var/lib/docker)
cpus=$(nproc 2>/dev/null || docker info -f '{{.NCPU}}' 2>/dev/null || true)

# A source this host lacks records an empty field; it never stops the sampler.
meminfo() { awk -v k="$1:" '$1 == k {print int($2 / 1024)}' "$proc_root/meminfo" 2>/dev/null || true; }

# "512.3MiB / 2GiB" -> 512 ; "1.5GiB / 4GiB" -> 1536 ; "900KiB / 1GiB" -> 0
to_mib() {
  awk -v v="$1" 'BEGIN {
    n = v + 0; u = v; sub(/^[0-9.]+/, "", u);
    if (u == "GiB" || u == "GB") n *= 1024; else if (u == "KiB" || u == "kB" || u == "KB") n /= 1024; else if (u == "B") n /= 1048576;
    printf "%d", n }'
}

sample() {
  local now load1= load5= total avail swap_total swap_free df_line size= available= running sandboxes pods=
  now=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  if [ -r "$proc_root/loadavg" ]; then read -r load1 load5 _ <"$proc_root/loadavg"; fi
  total=$(meminfo MemTotal)
  avail=$(meminfo MemAvailable)
  swap_total=$(meminfo SwapTotal)
  swap_free=$(meminfo SwapFree)
  if df_line=$(df -Pk "$docker_root" 2>/dev/null | awk 'NR==2 {print int($2/1024), int($4/1024)}'); then
    read -r size available <<<"$df_line"
  fi
  running=$( (docker ps -q 2>/dev/null || true) | wc -l | tr -d ' ')
  sandboxes=$( (docker ps -q --filter label=jumptotech.io/managed=true 2>/dev/null || true) | wc -l | tr -d ' ')
  if [ -n "$kubeconfig" ]; then
    pods=$( (KUBECONFIG=$kubeconfig kubectl get pods -A --no-headers 2>/dev/null || true) | wc -l | tr -d ' ')
  fi
  printf '%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s\n' "$now" "$load1" "$load5" "$cpus" "$total" "$avail" \
    "$(if [ -n "$swap_total" ] && [ -n "$swap_free" ]; then echo $((swap_total - swap_free)); fi)" \
    "$size" "$available" "$running" "$sandboxes" "$pods" >>"$host_csv"
  { docker stats --no-stream --format '{{.Name}}|{{.CPUPerc}}|{{.MemUsage}}|{{.PIDs}}' 2>/dev/null || true; } |
    while IFS='|' read -r name cpu mem pids; do
      [ -n "$name" ] || continue
      printf '%s,%s,%s,%s,%s\n' "$now" "$name" "${cpu%\%}" "$(to_mib "${mem%% /*}")" "$pids"
    done >>"$containers_csv"
}

summary() {
  echo
  echo "samples: $(($(wc -l <"$host_csv") - 1)) in $host_csv"
  awk -F, 'NR > 1 {
      n++
      if ($2 != "" && $2 + 0 > l1) l1 = $2 + 0
      if ($6 != "" && (min_av == "" || $6 + 0 < min_av)) min_av = $6 + 0
      if ($7 != "" && $7 + 0 > swap) swap = $7 + 0
      if ($9 != "" && (min_disk == "" || $9 + 0 < min_disk)) min_disk = $9 + 0
      if ($10 + 0 > ctr) ctr = $10 + 0
      if ($11 + 0 > sbx) sbx = $11 + 0
      if ($12 != "" && $12 + 0 > pods) pods = $12 + 0
      total = $5; cpus = $4
    }
    END {
      if (!n) { print "no samples"; exit }
      printf "peak load1            %s (on %s CPUs)\n", l1, cpus
      printf "lowest mem available  %s MiB of %s MiB\n", min_av, total
      printf "peak swap used        %s MiB\n", swap
      printf "lowest Docker disk    %s MiB available\n", min_disk
      printf "peak containers       %s running, %s platform sandboxes\n", ctr, sbx
      printf "peak pods             %s\n", (pods == "" ? "not sampled" : pods)
    }' "$host_csv"
  echo 'peak memory per container (MiB):'
  awk -F, 'NR > 1 { if ($4 + 0 > m[$2]) m[$2] = $4 + 0 } END { for (c in m) printf "  %6d  %s\n", m[c], c }' "$containers_csv" | sort -rn | head -25
  echo 'Record these with the run they describe; they are this host only (readiness doc §13).'
}

trap 'summary; exit 0' INT TERM

echo "sampling every ${interval}s for ${duration}s into $out_dir (Ctrl-C prints the peaks and stops)"
end=$(($(date +%s) + duration))
while :; do
  sample
  [ "$(date +%s)" -lt "$end" ] || break
  sleep "$interval"
done
summary
