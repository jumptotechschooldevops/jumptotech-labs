# Seeded by the platform when this lab starts, and restored by Reset Lab.
#
# Two resources that must happen in a particular order, and a configuration
# that says nothing about it.
#
# Both read `local.release`, which is worth looking at closely: sharing a value
# does not make one depend on the other. Each depends on the local. Neither
# depends on its neighbour, and Terraform is free to create them in either
# order.

locals {
  release = "2026.08"
}

resource "local_file" "migration_marker" {
  filename = "build/migrations/applied.txt"

  content = <<-EOT
    release: ${local.release}
    status: complete
  EOT
}

resource "local_file" "app_manifest" {
  filename = "build/app/manifest.json"

  content = jsonencode({
    service = "ledger-api"
    release = local.release
  })
}
