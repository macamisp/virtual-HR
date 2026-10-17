# Secrets Manager. Generated values are ephemeral and written with write-only arguments, so they
# never appear in Terraform state or plans. Bump *_version to rotate. External values (LiveKit,
# SMTP) are created empty here and filled once by an operator (see the runbook).
ephemeral "random_password" "jwt" {
  length  = 64
  special = false
}

ephemeral "random_password" "db_app" {
  length  = 40
  special = false
}

ephemeral "random_password" "db_retention" {
  length  = 40
  special = false
}

variable "secret_versions" {
  description = "Increase a number to rotate that generated secret on the next apply."
  type        = object({ jwt = number, db_app = number, db_retention = number })
  default     = { jwt = 1, db_app = 1, db_retention = 1 }
}

resource "aws_secretsmanager_secret" "jwt" {
  name       = "${local.name}/jwt-secret"
  kms_key_id = aws_kms_key.data.arn
  tags       = local.tags
}

resource "aws_secretsmanager_secret_version" "jwt" {
  secret_id                = aws_secretsmanager_secret.jwt.id
  secret_string_wo         = ephemeral.random_password.jwt.result
  secret_string_wo_version = var.secret_versions.jwt
}

resource "aws_secretsmanager_secret" "db_app" {
  name       = "${local.name}/db-app-password"
  kms_key_id = aws_kms_key.data.arn
  tags       = local.tags
}

resource "aws_secretsmanager_secret_version" "db_app" {
  secret_id                = aws_secretsmanager_secret.db_app.id
  secret_string_wo         = ephemeral.random_password.db_app.result
  secret_string_wo_version = var.secret_versions.db_app
}

resource "aws_secretsmanager_secret" "db_retention" {
  name       = "${local.name}/db-retention-password"
  kms_key_id = aws_kms_key.data.arn
  tags       = local.tags
}

resource "aws_secretsmanager_secret_version" "db_retention" {
  secret_id                = aws_secretsmanager_secret.db_retention.id
  secret_string_wo         = ephemeral.random_password.db_retention.result
  secret_string_wo_version = var.secret_versions.db_retention
}

# Filled by an operator after the first apply (values never pass through Terraform).
resource "aws_secretsmanager_secret" "external" {
  for_each   = toset(["livekit-api-key", "livekit-api-secret", "smtp-password"])
  name       = "${local.name}/${each.key}"
  kms_key_id = aws_kms_key.data.arn
  tags       = local.tags
}

# ADR 023: OAuth client secrets, only for the calendar providers that are switched on (an empty
# secret would stop the tasks from starting).
locals {
  calendar_providers = { for k, v in { google = var.google_oauth_client_id, microsoft = var.microsoft_oauth_client_id } : k => v if v != "" }
}

resource "aws_secretsmanager_secret" "oauth" {
  for_each   = local.calendar_providers
  name       = "${local.name}/${each.key}-oauth-client-secret"
  kms_key_id = aws_kms_key.data.arn
  tags       = local.tags
}

# ADR 024: the access key of the recording upload user, created by an operator in IAM and pasted
# here (never through Terraform, so it is not in the state).
resource "aws_secretsmanager_secret" "recording" {
  for_each   = var.recording_enabled ? toset(["recording-s3-access-key", "recording-s3-secret-key"]) : toset([]) # gitleaks:allow (secret names, no values)
  name       = "${local.name}/${each.key}"
  kms_key_id = aws_kms_key.data.arn
  tags       = local.tags
}
