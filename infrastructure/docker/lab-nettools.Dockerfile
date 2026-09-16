#
# JumpToTech Labs — network-tools lab image.
#
# A small Alpine image carrying the firewall and diagnostic tools that a
# *student container* needs from inside a Docker lab — as opposed to the
# sandbox image (`jumptotech/lab-docker`, N8), which carries them for the
# Docker *host*. NET-011 seeds a container that programs its own nftables
# ruleset, and NET-019 seeds a NAT box; both run inside the student's inner
# daemon, so the tools have to be in the container, not on the host.
#
# This is a JumpToTech image built from Alpine, the same arrangement as the
# `jumptotech/greeter` images the Docker track builds. It is baked into the
# sandbox image and loaded offline by the provider (N18), so a lab that uses
# it needs no registry at start.
#
# Deliberately minimal: a firewall (nftables and the iptables compatibility
# front-end), the connectivity tools a student measures with, and nothing
# else. No scanner, no packet crafter — every tool is one a working engineer
# runs on a host they own.
#
# Pinned by the Alpine base tag; bumping it is the one place a tool version
# changes, and the smoke test below fails the build if a bump drops one.

FROM alpine:3.20

RUN set -eux; \
    apk add --no-cache \
      nftables \
      iptables \
      iproute2 \
      tcpdump \
      busybox-extras; \
    rm -rf /var/cache/apk/*

# Fail the build, not a student's lab, if a base bump removes a tool a lab
# depends on.
RUN set -eux; \
    for binary in nft iptables ip tcpdump nc; do \
      command -v "$binary" >/dev/null || { echo "missing: $binary" >&2; exit 1; }; \
    done

# No ENTRYPOINT or CMD: a lab gives the container its command in setup.docker,
# and a bare image with a default command would only hide a lab that forgot to.
