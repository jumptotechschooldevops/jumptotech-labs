# Seeded by the platform when this lab starts, and restored by Reset Lab.
#
# The service catalogue below is maintained and correct. The manifest under it
# is typed out by hand, and has been wrong since `reporting` was added: the
# service list is short and in the wrong order, and the replica count was never
# recalculated.
#
# Nothing here is derived from anything. That is the whole problem.

variable "environment" {
  type    = string
  default = "production"
}

variable "services" {
  type = map(object({
    tier     = string
    replicas = number
  }))

  default = {
    ledger    = { tier = "gold", replicas = 3 }
    auth      = { tier = "gold", replicas = 2 }
    reporting = { tier = "silver", replicas = 1 }
  }
}

resource "local_file" "release_manifest" {
  filename = "build/manifest.txt"

  content = <<-EOT
    environment: PRODUCTION
    services: ledger, auth
    gold: ledger, auth
    replicas: 5
  EOT
}
