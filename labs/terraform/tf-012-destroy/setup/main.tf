# Seeded by the platform when this lab starts, and restored by Reset Lab.
#
# The reporting stack, already written for you. Nothing here has been applied
# yet — creating it is the first step, and taking it apart again is the lab.

resource "local_file" "draft_report" {
  filename = "out/draft-report.txt"
  content  = "quarter: Q3\nstatus: draft\n"
}

resource "local_file" "summary_report" {
  filename = "out/summary-report.txt"
  content  = "quarter: Q3\nstatus: published\n"
}

resource "local_file" "audit_log" {
  filename = "out/audit-log.txt"
  content  = "quarter: Q3\nreviewed_by: platform-team\n"
}
