# AWS Backup: daily recovery points of the database and the documents bucket in an encrypted,
# locked vault (on top of RDS automated backups with point-in-time recovery). Restore drill:
# docs/runbooks/restore-drill.md.
resource "aws_backup_vault" "main" {
  name        = local.name
  kms_key_arn = aws_kms_key.data.arn
  tags        = local.tags
}

# Governance-mode lock: recovery points cannot be deleted early by the application or by mistake.
resource "aws_backup_vault_lock_configuration" "main" {
  backup_vault_name  = aws_backup_vault.main.name
  min_retention_days = 7
  max_retention_days = 400
}

resource "aws_backup_plan" "main" {
  name = local.name
  rule {
    rule_name         = "daily"
    target_vault_name = aws_backup_vault.main.name
    schedule          = "cron(30 20 * * ? *)" # 02:00 Asia/Colombo
    start_window      = 60
    completion_window = 360
    lifecycle { delete_after = var.backup_retention_days }
  }
  tags = local.tags
}

resource "aws_iam_role" "backup" {
  name = "${local.name}-backup"
  assume_role_policy = jsonencode({
    Version   = "2012-10-17"
    Statement = [{ Effect = "Allow", Principal = { Service = "backup.amazonaws.com" }, Action = "sts:AssumeRole" }]
  })
  tags = local.tags
}

resource "aws_iam_role_policy_attachment" "backup" {
  for_each = toset([
    "arn:aws:iam::aws:policy/service-role/AWSBackupServiceRolePolicyForBackup",
    "arn:aws:iam::aws:policy/service-role/AWSBackupServiceRolePolicyForRestores",
    "arn:aws:iam::aws:policy/AWSBackupServiceRolePolicyForS3Backup",
    "arn:aws:iam::aws:policy/AWSBackupServiceRolePolicyForS3Restore",
  ])
  role       = aws_iam_role.backup.name
  policy_arn = each.value
}

resource "aws_backup_selection" "main" {
  name         = local.name
  plan_id      = aws_backup_plan.main.id
  iam_role_arn = aws_iam_role.backup.arn
  resources    = [aws_db_instance.main.arn, aws_s3_bucket.documents.arn]
}
