# JumpToTech Labs — Ansible sandbox node image (development).
#
# No `# syntax=` directive on purpose: this image is built on developer laptops
# and in CI where pulling an external Dockerfile frontend is one more network
# dependency that can fail. Nothing here needs a newer frontend than the one
# BuildKit already has.
#
# ONE image serves both roles in the per-session topology:
#
#   control  — where the student's shell lands; carries ansible-core and the
#              session's private key
#   node     — a managed node; carries only python3 + sshd, which is exactly
#              what Ansible needs on a target
#
# The role is chosen at run time by JTT_ROLE, so a session needs one image
# pull, not two. Nothing in here is privileged: no Docker socket, no host
# mount, no systemd, and the container runs with dropped capabilities and a
# PID/CPU/memory ceiling supplied by the orchestrator.
#
# Build:  bash scripts/ansible-image-build.sh
FROM alpine:3.21

# ansible-core (not the full `ansible` bundle) is deliberate: the labs teach
# builtin modules and Jinja2, which core provides, and core keeps the image
# small enough that five concurrent sessions are cheap.
RUN apk add --no-cache \
      ansible-core \
      bash \
      openssh-server \
      openssh-client \
      # Ansible copies files to a managed node over sftp first. Without the
      # server side of it every transfer falls back to `piped` and warns twice
      # per host — noise a student would reasonably read as a fault.
      openssh-sftp-server \
      # A real daemon for the deployment labs to manage. Nothing supervises it:
      # the student starts and reloads it with Ansible, which is the exercise.
      nginx \
      python3 \
      sudo \
      shadow \
      tini \
      curl \
      vim \
      less \
      procps \
 && rm -rf /var/cache/apk/*

COPY infrastructure/docker/ansible-lab-entrypoint.sh /usr/local/bin/jtt-entrypoint
COPY infrastructure/docker/ansible-lab-install-key.sh /usr/local/bin/jtt-install-key
COPY infrastructure/docker/ansible-lab-callback.py /opt/jumptotech/callbacks/jtt_stats.py
RUN chmod 0755 /usr/local/bin/jtt-entrypoint /usr/local/bin/jtt-install-key \
 && chmod 0644 /opt/jumptotech/callbacks/jtt_stats.py

ENV JTT_ROLE=node \
    LANG=C.UTF-8 \
    ANSIBLE_HOST_KEY_CHECKING=False

ENTRYPOINT ["/sbin/tini", "--", "/usr/local/bin/jtt-entrypoint"]
