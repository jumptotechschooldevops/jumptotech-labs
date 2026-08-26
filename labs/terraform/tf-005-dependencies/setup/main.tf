# Seeded by the platform when this lab starts, and restored by Reset Lab.
#
# The service configuration, already written. This resource is the head of the
# chain you are going to build: everything else in this lab has to be derived
# from it rather than written alongside it.
#
# Leave this block as it is. The resources you add are the ones being graded.

locals {
  service  = "ledger-api"
  replicas = 3
  channel  = "stable"
}

resource "local_file" "service_config" {
  filename = "build/service.json"

  content = jsonencode({
    service  = local.service
    replicas = local.replicas
    channel  = local.channel
  })
}
