resource "local_file" "settings" {
  filename = "settings.json"
  content = jsonencode({
    service     = var.service_name
    environment = var.enviroment
  })
}

resource "local_file" "runbook" {
    filename = "runbook.md"
      content = "Runbook for ${local_file.setting.filename}\n"
}

module "audit" {
  source = "./modules/audit"

  environment = var.environment
}
