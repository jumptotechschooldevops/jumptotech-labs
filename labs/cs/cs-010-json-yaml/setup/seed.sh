#!/bin/bash
# ---------------------------------------------------------------------------
# CS-010 baseline — the config that was read differently by the machine than
# by the person who edited it.
#
# --- Why two valid configs -------------------------------------------------
#
# depot-a.json and depot-b.json are the SAME config: same keys, same values,
# same list order. They differ only in key order and whitespace. Normalising
# both and hashing the results is how the lab shows what "normalise" is for —
# two files that look different and are not.
#
# --- Why every number in the JSON is an int, and version is a string -------
#
# The canonical form is graded by sha256, so the serialisation has to be
# reproducible. Floats are not: their shortest-repr can be argued about. There
# are no floats in the fixture. `version` is the string "3.10" precisely
# because the YAML half is about what happens when it is not quoted.
#
# Determinism was proved in the real image before the hash was written into
# lab.yaml — 18 plausible implementations across both inputs, three hash
# seeds, one digest. See labs/cs/SOURCES.md.
#
# --- The four YAML traps ---------------------------------------------------
#
#   country: no       YAML 1.1 reads the boolean false, not the country code
#   version: 3.10     reads the float 3.1, and 3.10 != 3.1
#   a tab             YAML forbids tabs as indentation
#   duplicate leeds:  the second block silently wins
#
# Each is graded on the corrected file's real bytes, not on the write-up.
# ---------------------------------------------------------------------------
set -euo pipefail

BUNDLE=/srv/kestrel/config

install -d -o root -g root -m 0755 /srv/kestrel
install -d -o root -g root -m 0755 "$BUNDLE"

cat > "$BUNDLE/README.txt" <<'TXT'
kestrel depot configuration

  depot-a.json        last night's config, as the collector wrote it
  depot-b.json        the same config, as the console exported it
  depot-missing.json  rejected by the loader
  depot-wrongtype.json  rejected by the loader
  depot-broken.json   rejected by the parser
  depots.yaml         the file the depot team edits by hand

depot-a.json and depot-b.json came from different tools and do not look alike.
Whether they ARE alike is the question the loader keeps having to answer.

depots.yaml is the file that disabled the wrong depot and deployed the wrong
version. Nothing in it is a syntax error the team could see.
TXT

# --- the same config, written by two different tools ----------------------
cat > "$BUNDLE/depot-a.json" <<'JSON'
{"version": "3.10", "depot": "leeds", "scanners": ["sc-04", "sc-01", "sc-02"], "enabled": true, "limits": {"port": 8080, "max_parcels": 500}, "region": "north"}
JSON

cat > "$BUNDLE/depot-b.json" <<'JSON'
{
    "depot": "leeds",
    "region": "north",
    "limits": {
        "max_parcels": 500,
        "port": 8080
    },
    "enabled": true,
    "scanners": [
        "sc-04",
        "sc-01",
        "sc-02"
    ],
    "version": "3.10"
}
JSON

# --- one problem each, so the loader's answer is never ambiguous ----------
# `region` is absent. Every other key is present and correctly typed.
cat > "$BUNDLE/depot-missing.json" <<'JSON'
{
  "depot": "leeds",
  "version": "3.10",
  "enabled": true,
  "limits": {"port": 8080, "max_parcels": 500},
  "scanners": ["sc-04", "sc-01", "sc-02"]
}
JSON

# `enabled` is the string "yes" rather than a boolean — the JSON spelling of
# the same mistake the YAML file makes.
cat > "$BUNDLE/depot-wrongtype.json" <<'JSON'
{
  "depot": "leeds",
  "region": "north",
  "version": "3.10",
  "enabled": "yes",
  "limits": {"port": 8080, "max_parcels": 500},
  "scanners": ["sc-04", "sc-01", "sc-02"]
}
JSON

# A trailing comma. Valid in a Python literal, not in JSON (RFC 8259).
cat > "$BUNDLE/depot-broken.json" <<'JSON'
{
  "depot": "leeds",
  "region": "north",
  "version": "3.10",
  "enabled": true,
  "limits": {"port": 8080, "max_parcels": 500},
  "scanners": ["sc-04", "sc-01", "sc-02"],
}
JSON

# --- the hand-edited YAML, with its four traps ----------------------------
# Written with printf so the tab on the bristol line is a real tab and cannot
# be turned into spaces by an editor between here and the container.
{
  printf '# kestrel depot configuration — edited by the depot team\n'
  printf 'depots:\n'
  printf '  leeds:\n'
  printf '    country: no\n'
  printf '    version: 3.10\n'
  printf '    enabled: yes\n'
  printf '  bristol:\n'
  printf '    country: gb\n'
  printf '    version: "2.4"\n'
  printf '\tenabled: yes\n'
  printf '  leeds:\n'
  printf '    country: gb\n'
  printf '    version: "1.0"\n'
  printf '    enabled: no\n'
} > "$BUNDLE/depots.yaml"

# The tab has to survive seeding, or one of the four traps is not there.
grep -qP '\tenabled' "$BUNDLE/depots.yaml" || { echo "seed: the tab trap did not survive" >&2; exit 1; }

chown root:root "$BUNDLE"/*
chmod 0444 "$BUNDLE"/*
chmod 0755 "$BUNDLE"

# /home/student/py, /home/student/out and /home/student/ops are the student's
# to create.
