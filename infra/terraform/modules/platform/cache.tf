# ElastiCache Redis 7: BullMQ jobs, Socket.IO adapter, rate limits and session locks (ADR 020).
# TLS in transit, encrypted at rest, AUTH token from Secrets Manager.
ephemeral "random_password" "redis" {
  length  = 64
  special = false
}

resource "aws_secretsmanager_secret" "redis" {
  name       = "${local.name}/redis-auth-token"
  kms_key_id = aws_kms_key.data.arn
  tags       = local.tags
}

resource "aws_secretsmanager_secret_version" "redis" {
  secret_id                = aws_secretsmanager_secret.redis.id
  secret_string_wo         = ephemeral.random_password.redis.result
  secret_string_wo_version = 1
}

resource "aws_elasticache_subnet_group" "main" {
  name       = local.name
  subnet_ids = aws_subnet.isolated[*].id
  tags       = local.tags
}

resource "aws_security_group" "redis" {
  name        = "${local.name}-redis"
  description = "Redis from ECS tasks only"
  vpc_id      = aws_vpc.main.id
  tags        = local.tags
}

resource "aws_vpc_security_group_ingress_rule" "redis_from_tasks" {
  security_group_id            = aws_security_group.redis.id
  referenced_security_group_id = aws_security_group.tasks.id
  ip_protocol                  = "tcp"
  from_port                    = 6379
  to_port                      = 6379
}

resource "aws_elasticache_parameter_group" "redis7" {
  name   = "${local.name}-redis7"
  family = "redis7"
  # BullMQ requires keys never to be evicted.
  parameter {
    name  = "maxmemory-policy"
    value = "noeviction"
  }
  tags = local.tags
}

resource "aws_elasticache_replication_group" "main" {
  replication_group_id       = local.name
  description                = "HRVO ${var.env} Redis"
  engine                     = "redis"
  engine_version             = "7.1"
  node_type                  = var.redis_node_type
  num_cache_clusters         = 1 + var.redis_replicas
  automatic_failover_enabled = var.redis_replicas > 0
  multi_az_enabled           = var.redis_replicas > 0
  parameter_group_name       = aws_elasticache_parameter_group.redis7.name
  subnet_group_name          = aws_elasticache_subnet_group.main.name
  security_group_ids         = [aws_security_group.redis.id]
  at_rest_encryption_enabled = true
  kms_key_id                 = aws_kms_key.data.arn
  transit_encryption_enabled = true
  auth_token_wo              = ephemeral.random_password.redis.result
  auth_token_wo_version      = 1
  snapshot_retention_limit   = 3
  snapshot_window            = "19:00-20:00"
  maintenance_window         = "sun:20:30-sun:21:30"
  apply_immediately          = false
  tags                       = local.tags
}
