# ---------------------------------------------------------------------------
# JumpToTech Labs — structured run summary callback.
#
# Idempotency is a property of the *result set*, not of console text. Ansible
# already computes exactly the numbers that matter (ok / changed / failures /
# unreachable, per host); this callback writes them out as JSON so the verifier
# can read a data structure instead of pattern-matching a PLAY RECAP line.
#
# It is a platform-owned plugin baked into the sandbox image. Lab definitions
# cannot supply, name, or replace it.
#
# Enabled by the orchestrator with:
#   ANSIBLE_CALLBACK_PLUGINS=/opt/jumptotech/callbacks
#   ANSIBLE_CALLBACKS_ENABLED=jtt_stats
#   JTT_STATS_FILE=/tmp/jtt-stats-<n>.json
# ---------------------------------------------------------------------------
from __future__ import absolute_import, division, print_function

import json
import os

from ansible.plugins.callback import CallbackBase

__metaclass__ = type

DOCUMENTATION = """
  name: jtt_stats
  type: aggregate
  short_description: Write a machine-readable per-host run summary
  description:
    - Writes the play recap (ok, changed, failures, unreachable, skipped,
      rescued, ignored) for every host as JSON to the file named by the
      JTT_STATS_FILE environment variable.
  requirements:
    - enable in configuration
"""


class CallbackModule(CallbackBase):
    CALLBACK_VERSION = 2.0
    CALLBACK_TYPE = "aggregate"
    CALLBACK_NAME = "jtt_stats"
    CALLBACK_NEEDS_ENABLED = True

    def v2_playbook_on_stats(self, stats):
        summary = {}
        for host in sorted(stats.processed.keys()):
            summary[host] = stats.summarize(host)

        payload = json.dumps({"hosts": summary}, sort_keys=True)
        path = os.environ.get("JTT_STATS_FILE")
        if not path:
            return
        try:
            with open(path, "w") as handle:
                handle.write(payload)
        except OSError:
            # Never fail a student's playbook because bookkeeping could not be
            # written; the verifier treats a missing stats file as "unknown".
            pass
