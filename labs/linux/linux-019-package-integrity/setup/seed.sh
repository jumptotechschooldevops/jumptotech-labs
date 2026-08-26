#!/bin/bash
# ---------------------------------------------------------------------------
# LINUX-019 baseline — a host that has drifted from what its packages say it
# should be, and an internal artifact nobody ever installed.
#
# WHY THE PACKAGE DATABASE IS THE POINT
#
# Every other source of truth on this host can be edited by whoever broke it.
# dpkg's database cannot be edited *accidentally*: it records, for every file a
# package owns, the checksum that file had when it was installed. So "has this
# host drifted" is a question the system can answer about itself, and this lab
# is about asking it rather than about eyeballing files.
#
# TWO KINDS OF DRIFT, WHICH LOOK THE SAME AND ARE NOT
#
#   an edited packaged file    /usr/local/lib/jumptotech/jtt-checkctl has had a
#                              line appended. dpkg knows what it should be and
#                              reports the mismatch.
#   an unpackaged shim         /usr/local/bin/jtt-checkctl belongs to no package
#                              at all, and shadows the real tool because
#                              /usr/local/bin comes first on PATH. dpkg cannot
#                              report it as modified — it has never heard of it,
#                              which is exactly what makes it findable.
#
# The second is the more interesting half. An integrity check tells you about
# files packages own; it says nothing about files that were added. Finding that
# one means asking a different question — who owns this path — and getting no
# answer back.
#
# BUILT, NOT SHIPPED
#
# Both packages are built here with dpkg-deb from fixed content, so the payload
# is byte-identical on every run and the expected digests can be literals in
# lab.yaml. `--root-owner-group` keeps the build independent of whatever uid
# the seed happens to run as.
#
# Content is written from the dpkg project's own manual pages as installed on
# this host, and from the Linux man-pages project.
# ---------------------------------------------------------------------------
set -euo pipefail

BUILD=/tmp/jtt-pkg-build
PKGDIR=/srv/jumptotech/pkg
LIB=/usr/local/lib/jumptotech

install -d -o root -g root -m 0755 "${LIB}" /etc/jumptotech
install -d -o student -g student -m 0755 /srv/jumptotech "${PKGDIR}" /srv/jumptotech/runbooks

# --- build the two internal packages ----------------------------------------
control() {
  install -d -m 0755 "${BUILD}/$1/DEBIAN"
  printf 'Package: %s\nVersion: %s\nArchitecture: all\nMaintainer: JumpToTech Platform <platform@jumptotech.invalid>\nSection: admin\nPriority: optional\nDescription: %s\n' \
    "$1" "$2" "$3" > "${BUILD}/$1/DEBIAN/control"
}

rm -rf "${BUILD}"
control jumptotech-tools 1.2.0 "JumpToTech health check controller"
install -d -m 0755 "${BUILD}/jumptotech-tools${LIB}" "${BUILD}/jumptotech-tools/etc/jumptotech"
cat > "${BUILD}/jumptotech-tools${LIB}/jtt-checkctl" <<'SH'
#!/bin/sh
# jtt-checkctl — drives the platform health checks.
# Shipped by jumptotech-tools. Do not edit in place; changes are overwritten
# on the next deployment and flagged by the integrity audit.
set -eu
CONF=/etc/jumptotech/checkctl.conf
[ -r "$CONF" ] || { echo "jtt-checkctl: missing $CONF" >&2; exit 2; }
. "$CONF"
case "${1:-status}" in
  status)  printf 'checkctl %s: %s checks registered\n' "$CHECKCTL_TIER" "$CHECKCTL_COUNT" ;;
  verify)  printf 'checkctl %s: verify ok\n' "$CHECKCTL_TIER" ;;
  *)       echo "usage: jtt-checkctl {status|verify}" >&2; exit 2 ;;
esac
SH
chmod 0755 "${BUILD}/jumptotech-tools${LIB}/jtt-checkctl"
cat > "${BUILD}/jumptotech-tools/etc/jumptotech/checkctl.conf" <<'CONF'
CHECKCTL_TIER=production
CHECKCTL_COUNT=42
CONF
chmod 0644 "${BUILD}/jumptotech-tools/etc/jumptotech/checkctl.conf"

control jumptotech-audit 0.9.1 "JumpToTech package integrity auditor"
install -d -m 0755 "${BUILD}/jumptotech-audit${LIB}"
cat > "${BUILD}/jumptotech-audit${LIB}/jtt-audit" <<'SH'
#!/bin/sh
# jtt-audit — reports which packaged files no longer match their package.
set -eu
printf 'jtt-audit 0.9.1\n'
dpkg --verify "${1:-jumptotech-tools}" || true
SH
chmod 0755 "${BUILD}/jumptotech-audit${LIB}/jtt-audit"

dpkg-deb --root-owner-group --build "${BUILD}/jumptotech-tools" \
  "${PKGDIR}/jumptotech-tools_1.2.0_all.deb" >/dev/null
dpkg-deb --root-owner-group --build "${BUILD}/jumptotech-audit" \
  "${PKGDIR}/jumptotech-audit_0.9.1_all.deb" >/dev/null
chown student:student "${PKGDIR}"/*.deb

# --- install the tools package, then let the host drift ---------------------
dpkg -i "${PKGDIR}/jumptotech-tools_1.2.0_all.deb" >/dev/null

# Drift one: somebody edited the packaged file in place during an incident and
# never put it back. dpkg recorded the original checksum at install time and
# will report the mismatch.
cat >> "${LIB}/jtt-checkctl" <<'SH'

# --- added 2026-08-11 during the settlement incident, "temporarily" ---
# Suppresses the tier check so the on-call rotation stops being paged.
exit 0
SH

# Drift two: an unpackaged shim earlier on PATH than the real tool. dpkg owns
# no such file, so an integrity check cannot see it — asking who owns the path
# is what finds it.
cat > /usr/local/bin/jtt-checkctl <<'SH'
#!/bin/sh
# Quick wrapper someone added so `jtt-checkctl` would be on PATH.
echo "checkctl production: 42 checks registered"
SH
chmod 0755 /usr/local/bin/jtt-checkctl

# The audit package is staged and deliberately NOT installed.

rm -rf "${BUILD}"

# --- the runbook ------------------------------------------------------------
cat > /srv/jumptotech/runbooks/package-drift.md <<'MD'
# Host drift — what the audit wants from you

Config management flagged this host. Before it can go back into the pool,
platform want three things true.

**One. Every file owned by `jumptotech-tools` is exactly what the package
installed.** dpkg recorded a checksum for each of them when the package went
on. Ask it whether they still match, and put back anything that does not. The
package artifact is still in `/srv/jumptotech/pkg`, which is where the internal
repository leaves it, so you do not need the network to restore a file.

**Two. Nothing is shadowing a packaged tool.** `/usr/local/bin` comes before
`/usr/local/lib/jumptotech` for anyone who has the latter on their path at all,
so a file dropped in the former wins. An integrity check will not find this for
you: it only knows about files a package owns, and whatever is doing the
shadowing is not one of them. Ask a different question — *which package owns
this path* — and pay attention to what an unowned path answers.

Remove anything shadowing a packaged tool. Do not remove the package's own
files to make the shadow harmless.

**Three. `jumptotech-audit` is installed.** It was built for exactly this kind
of review and has been sitting in the repository unreleased since March. The
artifact is in `/srv/jumptotech/pkg`. There is no network on this host, and
there does not need to be — the file is right there.

Note for whoever picks this up: "installed" means the package manager knows
about it, not that the files happen to be present. Copying a binary into place
leaves the host in a state nobody can query, upgrade or remove, and that is
half of why this host drifted in the first place.
MD
chmod 0644 /srv/jumptotech/runbooks/package-drift.md
chown student:student /srv/jumptotech/runbooks/package-drift.md
