# PostgreSQL 16, Multi-AZ in production, encrypted, TLS only, automated backups with PITR.
# The master password is managed by RDS in Secrets Manager (never in Terraform state).
resource "aws_db_subnet_group" "main" {
  name       = local.name
  subnet_ids = aws_subnet.isolated[*].id
  tags       = local.tags
}

resource "aws_security_group" "db" {
  name        = "${local.name}-db"
  description = "PostgreSQL from ECS tasks only"
  vpc_id      = aws_vpc.main.id
  tags        = local.tags
}

resource "aws_vpc_security_group_ingress_rule" "db_from_tasks" {
  security_group_id            = aws_security_group.db.id
  referenced_security_group_id = aws_security_group.tasks.id
  ip_protocol                  = "tcp"
  from_port                    = 5432
  to_port                      = 5432
}

resource "aws_db_parameter_group" "pg16" {
  name   = "${local.name}-pg16"
  family = "postgres16"
  parameter {
    name  = "rds.force_ssl"
    value = "1"
  }
  parameter {
    name  = "log_min_duration_statement"
    value = "1000"
  }
  # Statements are logged by duration only; never with parameter values (no data in logs).
  parameter {
    name  = "log_parameter_max_length"
    value = "0"
  }
  tags = local.tags
}

resource "aws_db_instance" "main" {
  identifier                            = local.name
  engine                                = "postgres"
  engine_version                        = "16"
  instance_class                        = var.db_instance_class
  allocated_storage                     = var.db_allocated_storage_gb
  max_allocated_storage                 = var.db_allocated_storage_gb * 4
  storage_type                          = "gp3"
  storage_encrypted                     = true
  kms_key_id                            = aws_kms_key.data.arn
  db_name                               = "hrvo"
  username                              = "hrvo_admin"
  manage_master_user_password           = true
  master_user_secret_kms_key_id         = aws_kms_key.data.arn
  multi_az                              = var.db_multi_az
  db_subnet_group_name                  = aws_db_subnet_group.main.name
  vpc_security_group_ids                = [aws_security_group.db.id]
  parameter_group_name                  = aws_db_parameter_group.pg16.name
  publicly_accessible                   = false
  backup_retention_period               = var.db_backup_retention_days
  backup_window                         = "18:00-19:00" # 23:30-00:30 Asia/Colombo
  maintenance_window                    = "sun:19:30-sun:20:30"
  copy_tags_to_snapshot                 = true
  deletion_protection                   = var.db_deletion_protection
  skip_final_snapshot                   = false
  final_snapshot_identifier             = "${local.name}-final"
  auto_minor_version_upgrade            = true
  performance_insights_enabled          = true
  performance_insights_kms_key_id       = aws_kms_key.data.arn
  performance_insights_retention_period = 7
  enabled_cloudwatch_logs_exports       = ["postgresql"]
  iam_database_authentication_enabled   = false
  tags                                  = local.tags
}
