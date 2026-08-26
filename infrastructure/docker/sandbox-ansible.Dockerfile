# JumpToTech Labs — Ansible sandbox node image.
#
# ONE image serves both roles in a session's topology, chosen at run time by
# JTT_ROLE:
#
#   control  — where the student's shell lands. Carries ansible-core and the
#              session's private key. Runs NO sshd and holds NO capability:
#              the terminal attaches with `docker exec`, the same way it does
#              for a Linux or Terraform sandbox, so nothing about a session is
#              reachable from the host.
#   node     — a machine to configure. Runs sshd on 2222 and carries python3,
#              which is all Ansible needs on a target.
#
# ## Why sshd listens on 2222 rather than 22
#
# Binding a port below 1024 needs CAP_NET_BIND_SERVICE unless the runtime has
# lowered `net.ipv4.ip_unprivileged_port_start`. Docker does lower it to 0
# inside containers, so :22 *would* work here today — and that is exactly the
# problem: the grant would be implicit, resting on a runtime default that a
# different container runtime, a rootless daemon, or a hardened host may not
# share. Listening on 2222 removes the dependency, so the capability set below
# is the whole story and does not change with the deployment.
#
# Nothing here is privileged: no Docker socket, no host mount, no systemd, and
# the orchestrator drops every capability before adding back the few a managed
# node's sshd cannot start without.
#
# Build:  npm run sandbox:build
FROM alpine:3.21

# ansible-core rather than the full `ansible` bundle: the labs teach builtin
# modules and Jinja2, which core provides, and core keeps the image small
# enough that several concurrent sessions stay cheap.
RUN apk add --no-cache \
      ansible-core \
      bash \
      openssh-server \
      openssh-client \
      # Ansible copies to a managed node over sftp first. Without the server
      # side of it every transfer falls back to `piped` and warns twice per
      # host — noise a student would reasonably read as a fault.
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

# The student account, created here rather than at run time because the control
# node's foreground process is started *as* this user by the orchestrator.
#
# `adduser -D` leaves the account locked (`!` in /etc/shadow); `*` means "no
# password will ever match", which is what we want — the account is reachable
# by `docker exec` and by nothing else.
RUN adduser -D -u 1001 -s /bin/bash student \
 && usermod -p '*' student \
 && mkdir -p /home/student/lab /home/student/.ssh \
 && chmod 0700 /home/student/.ssh \
 && chown -R student:student /home/student \
 && printf 'student ALL=(ALL) NOPASSWD: ALL\n' >/etc/sudoers.d/student \
 && chmod 0440 /etc/sudoers.d/student

# `python3` is what Ansible actually needs on a target; make the classic
# interpreter path resolve so an inventory that pins it still works.
RUN [ -e /usr/bin/python ] || ln -sf /usr/bin/python3 /usr/bin/python

COPY infrastructure/docker/sandbox-ansible-entrypoint.sh /usr/local/bin/jtt-entrypoint
RUN chmod 0755 /usr/local/bin/jtt-entrypoint

RUN printf 'export PATH=/usr/local/bin:/usr/bin:/bin\nexport ANSIBLE_HOST_KEY_CHECKING=False\nexport ANSIBLE_RETRY_FILES_ENABLED=False\ncd /home/student/lab 2>/dev/null || true\n' \
      >/home/student/.profile \
 && cp /home/student/.profile /home/student/.bashrc \
 && chown student:student /home/student/.profile /home/student/.bashrc

ENV JTT_ROLE=node \
    JTT_SSH_PORT=2222 \
    LANG=C.UTF-8 \
    ANSIBLE_HOST_KEY_CHECKING=False

WORKDIR /home/student/lab
