#
# JumpToTech Labs — Terraform sandbox image.
#
# Deliberately no `# syntax=` directive: this image needs nothing from the
# external Dockerfile frontend, and the built-in one is one fewer moving part
# (and one fewer network fetch) between a developer and a working sandbox.
#
# The Linux sandbox plus the Terraform CLI and an offline provider mirror.
#
# ## Why a mirror
#
# Terraform labs at this level teach the language and the workflow — variables,
# locals, outputs, `init` / `plan` / `apply`, reading state. None of that needs
# a cloud account, and none of it needs the public registry at lab time.
#
# Baking a filesystem mirror of the providers the labs use, and pointing
# `TF_CLI_CONFIG_FILE` at it, buys three things at once:
#
#   1. the sandbox can run with `--network none`, so a Terraform lab has no
#      egress at all;
#   2. `terraform init` is deterministic and fast, and a registry outage cannot
#      break a student's lab;
#   3. no credential is ever needed, so no credential can ever leak.
#
# `direct { exclude = ... }` is what makes it a genuine offline install rather
# than a cache: a provider that is not in the mirror fails to install instead of
# silently reaching for the network.

ARG SANDBOX_LINUX_IMAGE=jumptotech/lab-linux:latest

# --- build stage: fetch the CLI and mirror the providers --------------------
FROM debian:bookworm-slim AS tools

ARG TERRAFORM_VERSION=1.9.8
ARG LOCAL_PROVIDER_VERSION=2.5.2
ARG RANDOM_PROVIDER_VERSION=3.6.3

RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends ca-certificates curl unzip; \
    rm -rf /var/lib/apt/lists/*

RUN set -eux; \
    arch="$(dpkg --print-architecture)"; \
    case "$arch" in \
      amd64) tfarch=amd64 ;; \
      arm64) tfarch=arm64 ;; \
      *) echo "unsupported architecture: $arch" >&2; exit 1 ;; \
    esac; \
    curl -fsSLo /tmp/terraform.zip \
      "https://releases.hashicorp.com/terraform/${TERRAFORM_VERSION}/terraform_${TERRAFORM_VERSION}_linux_${tfarch}.zip"; \
    unzip -q /tmp/terraform.zip -d /usr/local/bin; \
    rm /tmp/terraform.zip; \
    chmod 0755 /usr/local/bin/terraform; \
    terraform version

# Mirror exactly the providers the shipped labs declare. Adding a provider to a
# lab means adding it here too — which is the point: the set of things a student
# can reach is a decision, not a default.
RUN set -eux; \
    arch="$(dpkg --print-architecture)"; \
    case "$arch" in \
      amd64) platform=linux_amd64 ;; \
      arm64) platform=linux_arm64 ;; \
    esac; \
    mkdir -p /tmp/mirror-src /opt/terraform/mirror; \
    printf 'terraform {\n  required_providers {\n    local  = { source = "hashicorp/local",  version = "%s" }\n    random = { source = "hashicorp/random", version = "%s" }\n  }\n}\n' \
      "${LOCAL_PROVIDER_VERSION}" "${RANDOM_PROVIDER_VERSION}" > /tmp/mirror-src/providers.tf; \
    cd /tmp/mirror-src; \
    terraform providers mirror -platform="${platform}" /opt/terraform/mirror; \
    rm -rf /tmp/mirror-src

# --- runtime stage ----------------------------------------------------------
FROM ${SANDBOX_LINUX_IMAGE}

USER root

COPY --from=tools /usr/local/bin/terraform /usr/local/bin/terraform
COPY --from=tools /opt/terraform/mirror /opt/terraform/mirror

RUN set -eux; \
    mkdir -p /etc/terraform; \
    printf 'provider_installation {\n  filesystem_mirror {\n    path    = "/opt/terraform/mirror"\n    include = ["registry.terraform.io/*/*"]\n  }\n  direct {\n    exclude = ["registry.terraform.io/*/*"]\n  }\n}\n' \
      > /etc/terraform/cli.tfrc; \
    chmod 0644 /etc/terraform/cli.tfrc; \
    chmod -R a+rX /opt/terraform/mirror; \
    terraform version

ENV TF_CLI_CONFIG_FILE=/etc/terraform/cli.tfrc \
    TF_IN_AUTOMATION=1 \
    CHECKPOINT_DISABLE=1

USER student
WORKDIR /home/student

CMD ["sleep", "infinity"]
