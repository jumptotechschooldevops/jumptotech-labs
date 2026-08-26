# Seeded by the platform when this lab starts, and restored by Reset Lab.
#
# The platform configuration as it stands today, including the badly named
# resource everyone has learned to ignore. Nothing has been applied yet.

resource "local_file" "legacy_report" {
  filename = "out/report.txt"

  content = <<-EOT
    quarter: Q3
    owner: platform-team
  EOT
}

resource "local_file" "metrics" {
  filename = "out/metrics.txt"
  content  = "uptime: 99.95\n"
}

resource "local_file" "scratch_notes" {
  filename = "out/scratch-notes.txt"
  content  = "temporary working notes, kept by hand from here on\n"
}
