#!/bin/bash
# ---------------------------------------------------------------------------
# CS-005 baseline — the pipeline step that "passed" and shipped a broken build.
#
# Three separate contract violations, seeded as the real thing rather than
# described:
#
#   1. the check writes its verdict to stdout whether it passed or failed, so
#      the failure was piped into the next stage as if it were data;
#   2. it exits 0 on every path, so the pipeline believed it;
#   3. its launcher assigns KESTREL_MAX_FAILURES without exporting it, so the
#      value never reaches the child at all and the check silently falls back
#      to a default.
#
# All three are visible only by running the thing and looking at what came out
# of which stream and what status came back. None of them is commented, named
# or hinted at in the files themselves.
#
# The originals live under /srv/kestrel/pipeline, read-only and root-owned:
# they are the version in the repository, not the student's working copy. The
# student writes their corrected version into their own home, which is what an
# engineer actually does and which keeps the seed out of the student's
# workspace.
#
# Nothing here contains a graded value. The pipeline's failure limit is in
# pipeline.yml because that is genuinely where a pipeline keeps it — it is the
# input to the exercise, not its answer.
# ---------------------------------------------------------------------------
set -euo pipefail

BUNDLE=/srv/kestrel/pipeline

install -d -o root -g root -m 0755 /srv/kestrel
install -d -o root -g root -m 0755 "$BUNDLE"

cat > "$BUNDLE/README.txt" <<'TXT'
deploy-check — the pipeline step that runs after every deploy

  pipeline.yml      the pipeline definition, including the failure limit
  deploy-check.py   the check itself, as it is in the repository today
  run-check.sh      the wrapper the pipeline invokes
  job-4417.log      last night's job output, captured by the runner

Last night the deploy had 12 failed health probes. The job went green and the
build shipped.
TXT

cat > "$BUNDLE/pipeline.yml" <<'TXT'
# Kestrel deploy pipeline
stages:
  - deploy
  - verify

verify:
  # A deploy may leave at most this many failed health probes behind.
  max_failures: 5
  run: /srv/kestrel/pipeline/run-check.sh "$FAILED_PROBES"
  # The runner treats a non-zero exit status from any step as a failed job.
TXT

# The check, exactly as broken as described above.
cat > "$BUNDLE/deploy-check.py" <<'PY'
#!/usr/bin/env python3
"""Post-deploy health check for the Kestrel pipeline."""
import os
import sys

DEFAULT_MAX_FAILURES = 999


def main() -> int:
    failures = int(sys.argv[1])
    limit = int(os.environ.get("KESTREL_MAX_FAILURES", DEFAULT_MAX_FAILURES))

    if failures > limit:
        print(f"DEPLOY_CHECK=failed failures={failures} limit={limit}")
        return 0

    print(f"DEPLOY_CHECK=ok failures={failures} limit={limit}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
PY

# The wrapper. The assignment is here; the export is not.
cat > "$BUNDLE/run-check.sh" <<'SH'
#!/bin/bash
# Invoked by the pipeline runner for the verify stage.
KESTREL_MAX_FAILURES=5

/srv/kestrel/pipeline/deploy-check.py "$1"
SH

# Last night's job log: the evidence that it went green anyway.
cat > "$BUNDLE/job-4417.log" <<'TXT'
2026-08-24T22:03:11 runner: job 4417 started (branch=main)
2026-08-24T22:07:52 runner: stage deploy finished
2026-08-24T22:07:52 runner: stage verify: /srv/kestrel/pipeline/run-check.sh "12"
2026-08-24T22:07:53 runner: stage verify stdout: DEPLOY_CHECK=ok failures=12 limit=999
2026-08-24T22:07:53 runner: stage verify stderr: (empty)
2026-08-24T22:07:53 runner: stage verify exit status: 0
2026-08-24T22:07:53 runner: job 4417 SUCCEEDED
2026-08-25T08:15:02 ops: build 4417 is broken in production. the job was green.
TXT

chown -R root:root "$BUNDLE"
chmod 0444 "$BUNDLE"/README.txt "$BUNDLE"/pipeline.yml "$BUNDLE"/job-4417.log
chmod 0555 "$BUNDLE"/deploy-check.py "$BUNDLE"/run-check.sh
chmod 0755 "$BUNDLE"

# `/home/student/py`, `/home/student/bin` and `/home/student/ops` are the
# student's to create. The repository copy is read-only on purpose: an engineer
# fixes a check and ships the fix, they do not edit the deployed artifact.
