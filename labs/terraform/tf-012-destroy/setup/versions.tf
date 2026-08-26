# Seeded by the platform when this lab starts, and restored by Reset Lab.
#
# The `local` provider, at the version mirrored offline inside this
# environment, so `terraform init` resolves with no network.

terraform {
  required_version = ">= 1.5.0"

  required_providers {
    local = {
      source  = "hashicorp/local"
      version = "2.5.2"
    }
  }
}
