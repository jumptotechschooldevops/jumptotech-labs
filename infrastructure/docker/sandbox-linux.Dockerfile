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
#   cron                                LINUX-018 scheduled jobs. The package
#                                       only; nothing starts it here. Every
#                                       service a student sees is one a lab
#                                       put there, so LINUX-018's seed defines
#                                       and enables it under runit like any
#                                       other supervised service.
#   less tree file nano                 reading and identifying what is there
#   man-db manpages                     the labs cite man pages; they must exist
#   gawk diffutils sed grep findutils   the analysis labs' toolset
#   tar gzip                            LINUX-008 archives
#   tzdata ca-certificates              sane log timestamps, TLS roots
# `coreutils` comes with the base image. Nothing else is added.
#
# --- why the dpkg drop-in below exists --------------------------------------
#
# `debian:bookworm-slim` ships /etc/dpkg/dpkg.cfg.d/docker containing
# `path-exclude /usr/share/man/*`, so every package installs *without* its
# manual pages. Installing `man-db` and `manpages` does not undo that: they are
# subject to the same exclusion, which is why this image previously answered
# "No manual entry" for every one of the ~27 pages the labs' hints tell students
# to read — `man find`, `man chmod`, `man ps`, and even `environ(7)`, which
# LINUX-014 cites directly.
#
# A `path-include` in a drop-in that sorts *after* `docker` re-includes them.
# Config files in /etc/dpkg/dpkg.cfg.d are read in alphabetical order and the
# later directive wins, so the name matters — `zz-` is not decoration.
#
# The exclusion is only consulted at unpack time, so re-including it is not
# enough on its own: the packages that came with the base image were already
# unpacked without their pages and have to be reinstalled. That is the
# `--reinstall` list, and it holds exactly the packages that own a page the
# curriculum cites (coreutils covers mkdir/mv/touch/chmod/stat/df/du/head/tail/
# test/ln/env, passwd covers useradd/usermod/groupadd, `dpkg` covers
# dpkg/dpkg-deb/dpkg-query for LINUX-019, and `bash` is there because a student
# who reaches for documentation reaches for `man bash` first).
# Everything installed below gets its pages from the drop-in alone.
RUN set -eux; \
    printf '%s\n' \
      '# Manual pages are curriculum content in this image: LINUX-001 onward' \
      '# send students to `man` from their hints. The slim base image excludes' \
      '# them; this drop-in sorts after that exclusion and re-includes them.' \
      'path-include /usr/share/man/*' \
      > /etc/dpkg/dpkg.cfg.d/zz-jumptotech-manpages; \
    apt-get update; \
    apt-get install -y --no-install-recommends --reinstall \
      bash \
      coreutils \
      dpkg \
      findutils \
      grep \
      hostname \
      passwd \
      sed; \
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
      cron \
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
      ca-certificates; \
    rm -rf /var/lib/apt/lists/* /var/cache/apt/archives/*

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
