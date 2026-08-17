variable "environment" {
  type        = string
  description = "Environment the audit policy applies to."
}

variable "retention_days" {
  type        = number
  description = "How long audit records are retained, in days."
}
