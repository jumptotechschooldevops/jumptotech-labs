# The deployment identifier. It is generated once, on the first apply, and then
# it lives in state — there is nothing in this file that says what it is, and
# nothing that could work it out again. Lose the state and this name is gone.
resource "random_pet" "deployment_id" {
  length    = 2
  separator = "-"
}

resource "local_file" "inventory" {
  filename = "out/inventory.txt"
  content  = <<-EOT
    region: eu-west-1
    services: gateway, ledger, reporting
  EOT
}
