#
# JumpToTech Labs — Linux sandbox image.
#
# Deliberately no `# syntax=` directive: this image needs nothing from the
# external Dockerfile frontend, and the built-in one is one fewer moving part
# (and one fewer network fetch) between a developer and a working sandbox.
#
# One container built from this image is one student's Linux lab environment.
# It is not a service: it has no listening port on the outside, no network
# (`--network none` at run time), and no credential of any kind. Its job is to
# be a small, ordinary, *real* Debian system — one a student can be given a
# shell in and that the verifier can read back afterwards.
#
# Base choice: Debian stable slim. The Linux track teaches portable POSIX and
# GNU behaviour, and Debian is both what the Ubuntu documentation describes and
# the smallest credible full userland.
#
# Things this image deliberately does NOT contain:
#   · no Docker client and no socket — a Linux lab has no business reaching a
#     container runtime, and a sandbox that could would be a host escape;
#   · no compilers, no package indexes, no editor beyond nano;
#   · no pip, no virtualenv tooling, no third-party Python packages;
#   · no secrets, no kubeconfig, nothing belonging to the platform.
#
# --- On root, sudo, and what the boundary actually is -----------------------
#
# The student account has passwordless sudo, and `LinuxLabProvider` runs these
# containers with a narrow set of capabilities added back rather than with
# `--cap-drop ALL` alone. That is deliberate: LINUX-003 is about `useradd`,
# LINUX-005 is about a supervised service, LINUX-002 is about a file the
# student does not own. None of it is teachable from an account that cannot
# administer anything, and a stubbed `useradd` would teach students to type
# commands that do nothing.
#
# The isolation boundary for a Linux lab is *the container*, not the account
# inside it. One container belongs to exactly one session; it has no host
# mounts, no socket, no network, and hard CPU/memory/pids ceilings. What a
# student can reach inside it, they were given deliberately. See
# providers/linux-provider.ts and README → Security model.
#
# --- LINUX-005: services, without faking systemd ----------------------------
#
# A container does not run systemd, and this image does not pretend otherwise:
# there is no fake `systemctl` anywhere in it. A stub would teach a student to
# type commands that produce no effect, which is worse than teaching nothing.
#
# Instead the image ships `runit`, a real process supervisor used in production
# container images. A service is a directory under /etc/sv containing an
# executable `run` script, and it is enabled by symlinking it into
# /etc/service. Students start, stop and inspect services with `sv`, read
# supervised logs, and see a stopped daemon genuinely come back — the concepts
# systemd exists to provide, running for real. The differences from systemd are
# stated in the lab text rather than hidden.
#
# Build it on the host: `npm run sandbox:build`. The orchestrator never builds
# images — that needs the Docker socket, and the same rule that keeps kind
# cluster creation out of the API applies here.

FROM debian:bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive \
    LANG=C.UTF-8 \
    LC_ALL=C.UTF-8

# Package set, justified line by line:
#   procps psmisc                       ps, top, pgrep, kill, fuser (LINUX-004)
#   iproute2 iputils-ping netcat socat  LINUX-006 networking
#   passwd sudo                         LINUX-002/003 accounts
#   runit                               LINUX-005 supervision
#   less tree file nano                 reading and identifying what is there
#   man-db manpages                     the labs cite man pages; they must exist
#   gawk diffutils sed grep findutils   the analysis labs' toolset
#   tar gzip                            LINUX-008 archives
#   tzdata ca-certificates              sane log timestamps, TLS roots
#   python3                             the CS track's programming runtime —
#                                       see "On the Python runtime" below
# `coreutils` comes with the base image. Nothing else is added.
RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends \
      procps \
      psmisc \
      iproute2 \
      iputils-ping \
      netcat-openbsd \
      socat \
      passwd \
      sudo \
      runit \
      less \
      tree \
      file \
      nano \
      man-db \
      manpages \
      gawk \
      diffutils \
      sed \
      grep \
      findutils \
      tar \
      gzip \
      tzdata \
      ca-certificates \
      python3; \
    rm -rf /var/lib/apt/lists/* /var/cache/apt/archives/*

# --- On the Python runtime -------------------------------------------------
#
# The Computer Science Fundamentals track teaches programming fundamentals,
# data structures, HTTP and relational databases, and its labs are graded by
# running the student's own program and comparing its *behaviour*. That needs
# a real interpreter in the sandbox; a mocked one would grade nothing.
#
# Why this image rather than a separate CS image and provider: a provider
# models the *substrate* a lab runs on — a namespace, a container, a cloud
# session. A CS lab wants exactly the substrate a Linux lab wants: one
# unprivileged container, the same capability set, the same reader. The only
# difference is which packages are present, and that is a property of the
# image, not a new kind of sandbox. Adding a second provider identical to
# `linux` in every respect except one package would duplicate the provider id,
# the isolation mode, the requirement families, the registry wiring, the
# availability probe and a whole image to patch and scan, to express nothing.
#
# Why this does not move the security boundary: this sandbox already ships
# `bash`, `gawk` and `sed`. A student can already author and run arbitrary
# programs here; that is what a shell is. Python changes how expressively they
# can do it, not what they can reach. It adds no capability, no socket, no
# network, no setuid binary and no privilege — the container still runs
# `--network none`, `--cap-drop ALL` plus a narrow add-back, as an
# unprivileged user, with no host mount.
#
# Deliberately NOT installed, because no approved CS lab needs them:
#   · pip and the package indexes — CS-023 teaches dependency *resolution* by
#     reading real manifests and lock files, which needs no installer, and the
#     sandbox has no network to install from;
#   · python3-venv — CS-023's optional venv step works with
#     `python3 -m venv --without-pip`, which the stock package supports;
#   · any third-party distribution. The whole track runs on the standard
#     library: sqlite3, json, http.server, socket, threading, hashlib,
#     struct, dis, py_compile and friends all ship with `python3`.
#
# Version: constrained by the base image to Debian bookworm's Python 3.11
# series. Asserted at build time rather than pinned to an exact package
# revision: an exact pin breaks on every Debian point release, while this
# fails the build loudly if the base image ever moves to a different minor
# series, which is the change that would actually invalidate lab content.
RUN set -eux; \
    python3 --version; \
    python3 -c 'import sys; assert sys.version_info[:2] == (3, 11), f"CS runtime expects Python 3.11.x, image has {sys.version.split()[0]}"'; \
    python3 -c 'import sqlite3, json, http.server, socket, threading, hashlib, struct, dis, py_compile, venv, unicodedata'

# The unprivileged student, a second group they are a *member* of, and sudo.
#
# The `deployers` membership matters pedagogically: a user may change a file's
# group to any group they belong to, which is real, documented behaviour
# (chown(2)) and is what lets a permissions lab teach group ownership.
RUN set -eux; \
    groupadd --gid 2001 deployers; \
    useradd --create-home --home-dir /home/student --shell /bin/bash \
            --uid 1001 --user-group student; \
    usermod --append --groups deployers student; \
    printf 'student ALL=(ALL) NOPASSWD: ALL\n' > /etc/sudoers.d/010-student; \
    chmod 0440 /etc/sudoers.d/010-student; \
    chmod 0755 /home/student

# Platform-owned areas.
#
# `/opt/jumptotech/seed` is root-only and transient: the provider writes a lab's
# baseline scripts here, runs them, and deletes them before the student's
# terminal exists. A troubleshooting lab's seed script describes the fault it
# injects, and the student is root in here — so a script left on disk would be
# an answer key.
RUN set -eux; \
    mkdir -p /opt/jumptotech/seed /etc/sv /var/log/jumptotech; \
    chmod 0700 /opt/jumptotech /opt/jumptotech/seed

# Start with an empty service directory.
#
# Debian's runit package enables a `default-syslog` service of its own. Nothing
# in this image logs through syslog, and a stray running service would be noise
# in exactly the lab that teaches a student to read `/etc/service` — so it is
# removed, and every service a student sees is one a lab put there.
RUN set -eux; \
    rm -rf /etc/runit/runsvdir/default/* /etc/sv/default-syslog; \
    mkdir -p /etc/runit/runsvdir/default

# Interactive shell setup for the student account.
#
# Deliberately minimal. A lab should teach the system, not this file: no
# aliases that hide what a command really does, no functions that wrap the
# tools being taught, no prompt magic beyond showing who and where you are.
RUN set -eux; \
    printf '%s\n' \
      '# JumpToTech Labs — interactive shell setup for the student account.' \
      'case $- in *i*) ;; *) return ;; esac' \
      'HISTCONTROL=ignoredups' \
      'HISTSIZE=2000' \
      'HISTFILESIZE=2000' \
      'shopt -s histappend checkwinsize' \
      "PS1='\\[\\e[32m\\]\\u@\\h\\[\\e[0m\\]:\\[\\e[34m\\]\\w\\[\\e[0m\\]\\$ '" \
      'if [ -x /usr/bin/dircolors ]; then' \
      '  eval "$(dircolors -b 2>/dev/null)"' \
      "  alias ls='ls --color=auto'" \
      "  alias grep='grep --color=auto'" \
      'fi' \
      'export EDITOR=nano' \
      'export PAGER=less' \
      > /home/student/.bashrc; \
    printf '%s\n' \
      '# Login shells read this; interactive setup lives in .bashrc, as on Debian.' \
      'if [ -n "$BASH_VERSION" ] && [ -f "$HOME/.bashrc" ]; then . "$HOME/.bashrc"; fi' \
      'PATH="$HOME/.local/bin:$HOME/bin:$PATH"' \
      'export PATH' \
      > /home/student/.profile; \
    chown student:student /home/student/.bashrc /home/student/.profile; \
    chmod 0644 /home/student/.bashrc /home/student/.profile

# Make the container's own hostname resolvable.
#
# Docker writes /etc/hosts at run time, and with `--network none` it does not
# add the hostname the sandbox was given. `sudo` resolves the host to match its
# host specification, so without this every single `sudo` in the track prints
# "unable to resolve host" before doing the right thing — noise, in a track
# whose whole point is reading what the system tells you.
#
# An entrypoint rather than a baked-in line, because /etc/hosts is generated
# per container and anything written here would be overwritten.
RUN set -eux; \
    printf '%s\n' \
      '#!/bin/sh' \
      '# Add this container'"'"'s hostname to /etc/hosts, then run what we were asked to.' \
      'set -e' \
      'name="$(cat /etc/hostname 2>/dev/null || true)"' \
      'if [ -n "$name" ] && ! grep -q "[[:space:]]$name\$" /etc/hosts 2>/dev/null; then' \
      '  printf "127.0.1.1\t%s\n" "$name" >> /etc/hosts 2>/dev/null || true' \
      'fi' \
      'exec "$@"' \
      > /usr/local/sbin/jtt-entrypoint; \
    chmod 0755 /usr/local/sbin/jtt-entrypoint

ENV HOME=/home/student

WORKDIR /home/student

ENTRYPOINT ["/usr/local/sbin/jtt-entrypoint"]

# The container's foreground process: a real supervisor, running real services,
# from the moment the sandbox starts. Student shells are `docker exec` children
# of it and die with the sandbox.
#
# It runs as root so that `sv` can supervise services that drop to their own
# accounts; the student's *shell* is exec'd as `student` by the provider, which
# passes `--user student` on every attach.
CMD ["/usr/bin/runsvdir", "-P", "/etc/service"]
