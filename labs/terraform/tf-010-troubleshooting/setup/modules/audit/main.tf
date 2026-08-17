resource "local_file" "audit_policy" {
  filename = "audit-${var.environment}.json"
  content = jsonencode({
    environment    = var.environment
    retention_days = var.retention_days
  })
}
