#
# JumpToTech Labs — Docker sandbox image.
#
# Deliberately no `# syntax=` directive, for the same reason as the other
# sandbox images: nothing here needs the external Dockerfile frontend, and the
# built-in one is one fewer moving part between a developer and a working
# sandbox.
#
# The stock `docker:dind` image plus the networking diagnostic tools the
# Networking track's container labs are written against. This is capability
# **N8** in labs/networking/CURRICULUM.md.
#
# ## Why an image rather than a pull list
#
# N8 is described in the roadmap as "add the networking tooling image to those
# labs", which assumes such an image exists to be added. It did not. The three
# images a Docker lab may use — `alpine:3.20`, `nginx:1.27-alpine`,
# `busybox:1.36` — carry BusyBox applets and nothing else, and stock
# `docker:27-dind` has BusyBox `ip` (no `-d`, no `ip netns`), `iptables`,
# `nsenter` and `nslookup`. Measured 2026-09-16.
#
# Pulling a third-party tooling image into each session's daemon would have
# meant a supply-chain dependency the platform does not control *and* a
# registry fetch on the path of every lab start. Baking the tools into the
# sandbox image instead is the pattern this repository already uses for exactly
# this problem: `sandbox-terraform.Dockerfile` bakes a filesystem provider
# mirror so that `terraform init` needs no registry at lab time. This is the
# same trade, one layer up.
#
# What that buys, in the same three terms:
#
#   1. a Docker lab needs **no registry fetch for its tools** — the sandbox is
#      created from this image by the host daemon, so the tools are present
#      before the student's session exists;
#   2. the tool set is **deterministic and reviewable** — it is this file, not
#      whatever a floating upstream tag happened to contain;
#   3. nothing is fetched inside a student's session, so no new egress path is
#      opened and no credential is ever involved.
#
# ## Where these tools run, and where they do not
#
# They are installed in the **sandbox**, which is the Docker *host* from the
# student's point of view. That is deliberate and it is where the Networking
# labs need them: a container's veth peer, the bridge it is attached to, and
# the DHCP exchange on that bridge are all in the sandbox's network namespace,
# not inside any student container. A lab that needs a tool *inside* a student
# container still declares an image in `setup.docker.images`, exactly as before.
#
# ## Why each package is here
#
#   iproute2        the real `ip`. BusyBox's applet has no `-d` (so no veth peer,
#                   no bridge detail), no `ip netns`, and no `-j`. NET-021 is
#                   written against all three.
#   tcpdump         NET-010 captures a DHCP exchange on a user-defined bridge.
#   bind-tools      `dig`, for the resolution-path labs. BusyBox `nslookup`
#                   cannot ask a specific server or show a record's TTL.
#   curl            measuring a request with `--max-time` and `-w`, which
#                   BusyBox `wget` cannot do. Also closes the LINUX-006 `curl`
#                   discrepancy noted against N1.
#   nftables        NET-011 and NET-029 part two read and write a rule set.
#                   `iptables` is already in the base image; both are kept
#                   because the labs teach the difference.
#   netcat-openbsd  `nc -z` with a timeout, for refused-versus-dropped.
#
# Nothing here is a general-purpose offensive toolkit: there is no scanner, no
# packet crafter, no exploit tooling. Every package is named by a lab in the
# curriculum and is a diagnostic a working engineer runs on a host they own.
#
# ## Versions
#
# `ARG DIND_IMAGE` pins the base, and the Alpine release that base carries
# (3.21 at the time of writing) pins the package repository the tools come
# from. Bumping the base is therefore the one place a tool version changes, and
# the `docker version` / tool smoke test at the end of the build fails loudly
# if a bump removes something a lab depends on.
#

ARG DIND_IMAGE=docker:27-dind

FROM ${DIND_IMAGE}

# `dockerd` runs as root in this image and the student's shell reaches the
# daemon over TLS; this adds binaries and changes no user, no capability and no
# entrypoint. The privileged flag the Docker provider already sets is unchanged
# by anything here.
USER root

RUN set -eux; \
    apk add --no-cache \
      iproute2 \
      tcpdump \
      bind-tools \
      curl \
      nftables \
      netcat-openbsd; \
    rm -rf /var/cache/apk/*

# Fail the build rather than a student's lab.
#
# Every binary below is named by a lab in labs/networking/CURRICULUM.md. If a
# base-image bump drops one, or `iproute2` stops shadowing the BusyBox applet,
# this is where that is discovered — not at lab time, and not by a student.
RUN set -eux; \
    for binary in ip tcpdump dig curl nft nc iptables nsenter; do \
      command -v "$binary" >/dev/null || { echo "missing: $binary" >&2; exit 1; }; \
    done; \
    # BusyBox `ip` has no `-d`; the real one does. This asserts which one is on
    # PATH, which is the whole reason iproute2 is installed.
    ip -d link show lo >/dev/null; \
    ip -j link show lo >/dev/null; \
    docker --version

# Entrypoint, command, user and environment are inherited from the base image
# unchanged: this image is `docker:dind` with diagnostics, not a different
# sandbox. The Docker provider starts it exactly as it started the stock one.
