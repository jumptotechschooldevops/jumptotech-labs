output "settings_path" {
  description = "Where the service settings were written."
  value       = local_file.settings.filename
}

output "audit_policy_path" {
  description = "Where the audit policy was written."
  value       = module.audit.policy_path
