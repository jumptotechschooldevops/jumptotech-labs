# Configuration inherited from the previous platform engineer.
#
# Three services were described here. One of them — the legacy statement
# printer — was decommissioned last quarter, but nobody updated this file.

resource "local_file" "accounts_config" {
  filename = "accounts.json"
  content = jsonencode({
    service = "accounts"
    port    = 8080
  })
}

resource "local_file" "ledger_config" {
  filename = "ledger.json"
  content = jsonencode({
    service = "ledger"
    port    = 8081
  })
}

resource "local_file" "legacy_config" {
  filename = "legacy-config.txt"
  content  = "statement-printer: decommissioned 2026-Q1\n"
}
