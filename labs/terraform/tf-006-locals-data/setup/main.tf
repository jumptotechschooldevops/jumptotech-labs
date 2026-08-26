# Seeded by the platform when this lab starts, and restored by Reset Lab.
#
# The manifest builder as it stands. Two things are wrong with it, and both are
# the kind of wrong that only shows up months later:
#
#   1. the service slug is spelled out by hand everywhere it is needed, so
#      changing the environment means finding every copy;
#   2. the region and tier are transcribed from `platform.json` — a file this
#      configuration does not own — so they are correct only until that file
#      changes and nobody notices.

resource "local_file" "service_manifest" {
  filename = "build/jumptotech-ledger-prod.json"

  content = jsonencode({
    slug   = "jumptotech-ledger-prod"
    region = "eu-west-1"
    tier   = "gold"
  })
}
