output "policy_path" {
  description = "Where the audit policy was written."
  value       = local_file.audit_policy.filename
}
