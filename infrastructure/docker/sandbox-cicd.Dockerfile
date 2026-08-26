# JumpToTech Labs — CI/CD sandbox image.
#
# A small project and the toolchain that builds it. Nothing more:
#
#   · Node.js, because the sample application builds and tests with it and
#     every entry in `WORKSPACE_TASKS` invokes `node`;
#   · git, because a CI lab that never mentions a repository would be teaching
#     pipelines in a vacuum;
#   · an editor and the usual shell tools, because the student writes YAML.
#
# ## What is deliberately absent
#
# **Docker.** CICD-005 teaches what a container build step looks like in a
# workflow, and is graded on the workflow and the Dockerfile the student wrote.
# No image is built here, so there is no daemon, no client, and no socket —
# and therefore nothing for a student to reach.
#
# **Jenkins, and any network client that needs one.** A Jenkinsfile is parsed,
# not executed. The sandbox runs with `--network none`.
#
# The orchestrator creates this container with `--cap-drop ALL` and adds
# nothing back, so it holds an empty capability bounding set.
#
# Build:  npm run sandbox:build
FROM alpine:3.21

RUN apk add --no-cache \
      nodejs \
      npm \
      git \
      bash \
      curl \
      vim \
      less \
      procps \
      coreutils \
      findutils \
      grep \
 && rm -rf /var/cache/apk/*

# The student account. The orchestrator starts the foreground process as this
# user and every shell, read and task attaches as it.
RUN adduser -D -u 1001 -s /bin/bash student \
 && usermod -p '*' student 2>/dev/null || true

RUN mkdir -p /home/student/project \
 && chown -R student:student /home/student

RUN printf 'export PATH=/usr/local/bin:/usr/bin:/bin\nexport PAGER=less\ncd /home/student 2>/dev/null || true\n' \
      >/home/student/.profile \
 && cp /home/student/.profile /home/student/.bashrc \
 && chown student:student /home/student/.profile /home/student/.bashrc

# `git` refuses to operate in a directory it considers owned by someone else.
# The workspace is seeded as `student` and used as `student`, so this only
# silences a warning a lab would otherwise have to explain.
RUN git config --system --add safe.directory /home/student

ENV LANG=C.UTF-8
WORKDIR /home/student
