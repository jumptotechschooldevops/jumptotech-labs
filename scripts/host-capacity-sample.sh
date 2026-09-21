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
#                   platform-managed sandbox containers, Kubernetes Pods, and
#                   the saturation signals load alone hides: CPU busy, iowait
#                   and steal % since the previous sample (steal is a noisy
#                   neighbour on a VM), pressure-stall avg60 for CPU some,
#                   memory some and full, and I/O some (/proc/pressure, Linux
#                   4.20+), the kernel's cumulative OOM-kill count since boot
#                   (oom_kills_total, /proc/vmstat), Docker data root free
#                   inodes, and the container OOM events the Docker daemon
#                   reported since the sampler started (docker_oom_events).
#                   A source the host lacks leaves its field empty.
#   oom.csv         time, container — one row per Docker container OOM event
#   containers.csv  time, container, CPU %, memory used (MiB), PIDs
#
# Load and "memory available" can look healthy while the kernel is killing a
# student's sandbox or stalling every task on reclaim; OOM kills and PSI are
# the numbers that say a run actually hit the host's limits. The kernel count
# includes kills outside containers; the Docker events name the containers.
#
# It judges nothing and has no thresholds: acceptable limits are a product
# decision (§13). At the end, or on Ctrl-C, it prints the peaks.
#
# Read-only: /proc, df, `docker ps`, `docker stats --no-stream`, `docker events
# --until` (bounded, returns at once), `kubectl get pods`. It starts, stops and
# creates nothing, and reads no secret.
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
oom_csv=$out_dir/oom.csv
host_header='time,load1,load5,cpus,mem_total_mib,mem_available_mib,swap_used_mib,docker_root_size_mib,docker_root_available_mib,containers_running,sandbox_containers,pods,cpu_busy_pct,cpu_iowait_pct,cpu_steal_pct,psi_cpu_some_avg60,psi_memory_some_avg60,psi_io_some_avg60,oom_kills_total,psi_memory_full_avg60,docker_root_inodes_free,docker_oom_events'
if [ -s "$host_csv" ] && [ "$(head -1 "$host_csv")" != "$host_header" ]; then
  echo "host-capacity-sample: $host_csv was written by another version of this sampler (different columns); use a new --out-dir" >&2
  exit 2
fi
[ -s "$host_csv" ] || echo "$host_header" >"$host_csv"
[ -s "$containers_csv" ] || echo 'time,container,cpu_percent,memory_mib,pids' >"$containers_csv"
[ -s "$oom_csv" ] || echo 'time,container' >"$oom_csv"

docker_root=$(docker info -f '{{.DockerRootDir}}' 2>/dev/null || echo /var/lib/docker)
cpus=$(nproc 2>/dev/null || docker info -f '{{.NCPU}}' 2>/dev/null || true)

started=$(date +%s)
oom_seen=0

# A source this host lacks records an empty field; it never stops the sampler.
meminfo() { awk -v k="$1:" '$1 == k {print int($2 / 1024)}' "$proc_root/meminfo" 2>/dev/null || true; }

# "512.3MiB / 2GiB" -> 512 ; "1.5GiB / 4GiB" -> 1536 ; "900KiB / 1GiB" -> 0
to_mib() {
  awk -v v="$1" 'BEGIN {
    n = v + 0; u = v; sub(/^[0-9.]+/, "", u);
    if (u == "GiB" || u == "GB") n *= 1024; else if (u == "KiB" || u == "kB" || u == "KB") n /= 1024; else if (u == "B") n /= 1048576;
    printf "%d", n }'
}

# CPU time from /proc/stat's aggregate line, as percentages of the interval
# since the previous sample; empty on the first sample.
prev_cpu=
cpu_percentages() {
  local line user nice system idle iowait irq softirq steal total busy delta_total
  line=$(awk '$1 == "cpu" {print $2, $3, $4, $5, $6, $7, $8, $9; exit}' "$proc_root/stat" 2>/dev/null || true)
  [ -n "$line" ] || { printf ',,'; return; }
  read -r user nice system idle iowait irq softirq steal <<<"$line"
  total=$((user + nice + system + idle + iowait + irq + softirq + ${steal:-0}))
  busy=$((user + nice + system + irq + softirq))
  if [ -n "$prev_cpu" ]; then
    set -- $prev_cpu
    delta_total=$((total - $1))
    if [ "$delta_total" -gt 0 ]; then
      awk -v b=$((busy - $2)) -v w=$((iowait - $3)) -v s=$((${steal:-0} - $4)) -v t="$delta_total" \
        'BEGIN { printf "%.1f,%.1f,%.1f", 100 * b / t, 100 * w / t, 100 * s / t }'
    else
      printf ',,'
    fi
  else
    printf ',,'
  fi
  prev_cpu="$total $busy $iowait ${steal:-0}"
}
# psi_avg60 RESOURCE some|full, e.g. "full avg10=0.00 avg60=0.10 …" -> 0.10
psi_avg60() { awk -v k="$2" '$1 == k { for (i = 2; i <= NF; i++) if ($i ~ /^avg60=/) { sub(/^avg60=/, "", $i); print $i; exit } }' "$proc_root/pressure/$1" 2>/dev/null || true; }

sample() {
  local now load1= load5= total avail swap_total swap_free df_line size= available= running sandboxes pods= cpu oom inodes= epoch oom_now
  now=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  epoch=$(date +%s)
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
  cpu_percentages >"$out_dir/.cpu.$$"
  cpu=$(cat "$out_dir/.cpu.$$")
  rm -f "$out_dir/.cpu.$$"
  oom=$(awk '$1 == "oom_kill" {print $2; exit}' "$proc_root/vmstat" 2>/dev/null || true)
  inodes=$(df -Pi "$docker_root" 2>/dev/null | awk 'NR==2 {print $4}') || inodes=
  # Every container OOM event since the sampler started; the daemon keeps the
  # history, so one between two samples is not missed. `--until` makes it
  # return at once.
  oom_now=$( (docker events --since "$started" --until "$epoch" --filter event=oom --format '{{.Actor.Attributes.name}}' 2>/dev/null || true) | sed '/^$/d')
  if [ -n "$oom_now" ]; then
    printf '%s\n' "$oom_now" | tail -n "+$((oom_seen + 1))" | while read -r victim; do printf '%s,%s\n' "$now" "$victim"; done >>"$oom_csv"
    oom_seen=$(printf '%s\n' "$oom_now" | wc -l | tr -d ' ')
  fi
  printf '%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s\n' "$now" "$load1" "$load5" "$cpus" "$total" "$avail" \
    "$(if [ -n "$swap_total" ] && [ -n "$swap_free" ]; then echo $((swap_total - swap_free)); fi)" \
    "$size" "$available" "$running" "$sandboxes" "$pods" "$cpu" \
    "$(psi_avg60 cpu some)" "$(psi_avg60 memory some)" "$(psi_avg60 io some)" "$oom" \
    "$(psi_avg60 memory full)" "$inodes" "$oom_seen" >>"$host_csv"
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
      if ($15 != "" && $15 + 0 > steal) steal = $15 + 0
      if ($14 != "" && $14 + 0 > iowait) iowait = $14 + 0
      if ($17 != "" && $17 + 0 > psimem) psimem = $17 + 0
      if ($18 != "" && $18 + 0 > psiio) psiio = $18 + 0
      if ($19 != "") { if (oom_first == "") oom_first = $19 + 0; oom_last = $19 + 0 }
      if ($20 != "" && $20 + 0 > psifull) psifull = $20 + 0
      if ($21 != "" && (min_inodes == "" || $21 + 0 < min_inodes)) min_inodes = $21 + 0
      if ($22 + 0 > dooms) dooms = $22 + 0
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
      printf "peak CPU iowait/steal %s%% / %s%%\n", iowait + 0, steal + 0
      printf "peak memory pressure  some %s / full %s (PSI avg60, %%; empty file means the kernel has no /proc/pressure)\n", psimem + 0, psifull + 0
      printf "peak io pressure      %s (PSI some avg60, %%)\n", psiio + 0
      printf "lowest Docker inodes  %s free\n", (min_inodes == "" ? "not sampled" : min_inodes)
      printf "OOM kills in the run  %s (kernel, any process)\n", (oom_first == "" ? "not sampled" : oom_last - oom_first)
      printf "container OOM events  %s (Docker daemon, see oom.csv)\n", dooms + 0
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
