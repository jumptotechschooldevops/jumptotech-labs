#
# JumpToTech Labs — Linux sandbox image.
#
# Deliberately no `# syntax=` directive: this image needs nothing from the
# external Dockerfile frontend, and the built-in one is one fewer moving part
# (and one fewer network fetch) between a developer and a working sandbox.
#
# One container built from this image is one student's Linux lab environment.
# It is not a service: it has no listening port, no network (`--network none`
# at run time), and no credential of any kind. Its whole job is to be a small,
# ordinary Debian userland that a student can be given a shell in and that the
# verifier can read the filesystem of afterwards.
#
# Things this image deliberately does NOT contain:
#   · no Docker client and no socket — a Linux lab has no business reaching a
#     container runtime, and a sandbox that could would be a host escape;
#   · no sudo, no setuid helpers beyond the Debian defaults, and the container
#     runs with `--cap-drop ALL --security-opt no-new-privileges`;
#   · no secrets, no kubeconfig, nothing belonging to the platform.
#
# Build it on the host: `npm run sandbox:build`. The orchestrator never builds
# images — that needs the Docker socket, and the same rule that keeps kind
# cluster creation out of the API applies here.

FROM debian:bookworm-slim

# A small, honest Linux userland. `coreutils` and `findutils` come with the base
# image; the rest is what makes a permissions lab teachable — being able to
# read a manual page, page a file, and see the tree you just built.
RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends \
      procps \
      less \
      tree \
      file \
      nano \
      man-db \
      manpages \
      ca-certificates; \
    rm -rf /var/lib/apt/lists/*

# The unprivileged student, and a second group they are a *member* of.
#
# The membership matters pedagogically: without CAP_CHOWN a student cannot give
# a file away to another user, but they can change a file's group to any group
# they belong to. That is real, documented Linux behaviour (chown(2)), and it is
# what lets LINUX-001 teach group ownership without the sandbox needing
# privilege it must not have.
RUN set -eux; \
    groupadd --gid 2001 deployers; \
    useradd --create-home --home-dir /home/student --shell /bin/bash \
            --uid 1001 --user-group student; \
    usermod --append --groups deployers student; \
    chmod 0755 /home/student

# A login-shell-free, colourless-by-default prompt is set by the terminal
# service per session; nothing here writes a dotfile, so a Reset genuinely
# returns the student to this image's state and not to someone's leftovers.
ENV HOME=/home/student \
    LANG=C.UTF-8

USER student
WORKDIR /home/student

# The container's foreground process. Student shells are `docker exec` children
# of it; when the sandbox is deleted, they die with it.
CMD ["sleep", "infinity"]
