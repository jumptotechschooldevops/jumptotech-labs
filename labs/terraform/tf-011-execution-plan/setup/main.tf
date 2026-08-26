# Seeded by the platform when this lab starts, and restored by Reset Lab.
#
# One resource, already written for you. Nothing here has been applied yet —
# planning it is the first half of the lab.

resource "local_file" "release_manifest" {
  filename = "build/release-manifest.txt"

  content = <<-EOT
    service: ledger-api
    channel: stable
  EOT
}
