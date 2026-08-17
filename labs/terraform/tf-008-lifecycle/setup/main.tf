# The compliance environment, as it stands today.
#
# Three resources, none of which yet says anything about how Terraform should
# treat it when things change. That is what this lab is about.

variable "release_channel" {
  type        = string
  description = "Release channel this environment tracks."
  default     = "stable"
}

# The audit log must survive. Regulators require it to be retained for the life
# of the environment, and a `terraform destroy` here would take it with them.
resource "local_file" "audit_log" {
  filename = "audit.log"
  content  = "audit trail opened for the compliance environment\n"
}

# The release identifier is referenced elsewhere. Replacing it by destroying the
# old one first leaves a window with no valid identifier at all.
resource "random_pet" "release" {
  length    = 2
  separator = "-"
}

# An external process rewrites this watcher's trigger during incident drills.
# Terraform keeps trying to put it back, and the drill keeps showing up as a
# pending change nobody wants to apply.
resource "null_resource" "config_watch" {
  triggers = {
    channel = var.release_channel
  }
}
