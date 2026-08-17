# Seeded by the platform when this lab starts, and restored by Reset Lab.
#
# `required_providers` is how a Terraform configuration states which providers
# it needs and which versions it accepts. Every provider below is available
# offline inside this lab environment, so `terraform init` works without any
# network access and without any cloud credentials.

terraform {
  required_version = ">= 1.9.0"

  required_providers {
    local = {
      source  = "hashicorp/local"
      version = "2.5.2"
    }
  }
}
