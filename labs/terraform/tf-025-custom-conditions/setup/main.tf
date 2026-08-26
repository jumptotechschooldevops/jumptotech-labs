# Seeded by the platform when this lab starts, and restored by Reset Lab.
#
# This configuration is correct today and states none of the reasons why.
#
# `environment` will accept any string at all. The settings file is trusted to
# contain what we expect. Nothing anywhere says a replica count must be a
# positive number, or that the manifest should end up with something in it.
#
# Every one of those is an assumption. None of them is written down, so none of
# them can fail early — they fail later, somewhere else, as something stranger.

variable "environment" {
  type    = string
  default = "production"
}

data "local_file" "platform" {
  filename = "platform.json"
}

locals {
  settings = jsondecode(data.local_file.platform.content)
}

resource "local_file" "release_manifest" {
  filename = "build/${var.environment}.json"

  content = jsonencode({
    environment = var.environment
    region      = local.settings.region
    replicas    = local.settings.replicas
  })
}
