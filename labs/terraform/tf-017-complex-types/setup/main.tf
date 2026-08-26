# Seeded by the platform when this lab starts, and restored by Reset Lab.
#
# The manifest builder as it stands: one environment's settings, spread across
# loose variables with defaults baked in. It plans and applies quite happily —
# and it ignores every value the platform team now supplies, because it has
# nowhere to put them. The region and replica count below were right once.

variable "target" {
  type    = string
  default = "production"
}

variable "env_region" {
  type    = string
  default = "us-east-1"
}

variable "env_replicas" {
  type    = number
  default = 3
}

resource "local_file" "environment_manifest" {
  filename = "build/${var.target}.json"

  content = jsonencode({
    region   = var.env_region
    replicas = var.env_replicas
  })
}
