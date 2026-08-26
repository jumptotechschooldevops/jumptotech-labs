# Seeded by the platform when this lab starts, and restored by Reset Lab.
#
# This configuration already builds the release manifest. It exposes nothing:
# everything it knows is locked inside it, which is the gap this lab closes.
#
# You may restructure any of this as long as the outputs the task asks for end
# up with the right values. The names below are not part of the contract; the
# output names are.

variable "channel" {
  type        = string
  default     = "stable"
  description = "Which release channel this deployment belongs to."
}

variable "deploy_token" {
  type        = string
  default     = "not-a-real-token-placeholder"
  description = "Stands in for a credential the pipeline would inject. Deliberately fake."
}

locals {
  service = "ledger-api"
}

resource "local_file" "release_manifest" {
  filename = "build/release-manifest.txt"

  content = <<-EOT
    service: ${local.service}
    channel: ${var.channel}
  EOT
}
