# Seeded by the platform when this lab starts, and restored by Reset Lab.
#
# Only the `local` provider is declared: this lab is about the plan, not about
# how many providers a configuration can use. The version is the one the lab
# environment mirrors offline, so `terraform init` resolves without a network.

terraform {
  required_version = ">= 1.5.0"

  required_providers {
    local = {
      source  = "hashicorp/local"
      version = "2.5.2"
    }
  }
}
