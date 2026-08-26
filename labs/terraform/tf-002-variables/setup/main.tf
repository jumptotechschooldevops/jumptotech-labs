# Seeded by the platform when this lab starts, and restored by Reset Lab.
#
# The staging copy of the platform configuration, exactly as it is today: every
# value that differs between environments is written into the file itself.
#
# There is a production copy of this file in another repository. It is identical
# apart from four of these values, and it has drifted twice this quarter.

resource "local_file" "service_config" {
  filename = "build/staging.json"

  content = jsonencode({
    service     = "ledger-api"
    environment = "staging"
    replicas    = 2
    debug       = true
  })
}
