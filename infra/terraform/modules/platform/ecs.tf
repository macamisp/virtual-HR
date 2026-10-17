# ECS Fargate (SRS 12.2 "Growth"): web, api (REST + jobs), realtime (all Socket.IO traffic: the office
# world lives in one process, ADR 015/020), clamav (internal), and a one-off migrate task.
resource "aws_ecr_repository" "app" {
  for_each             = toset(["api", "web"])
  name                 = "${local.name}/${each.key}"
  image_tag_mutability = "IMMUTABLE"
  image_scanning_configuration { scan_on_push = true }
  encryption_configuration {
    encryption_type = "KMS"
    kms_key         = aws_kms_key.data.arn
  }
  tags = local.tags
}

resource "aws_ecr_lifecycle_policy" "app" {
  for_each   = aws_ecr_repository.app
  repository = each.value.name
  policy = jsonencode({
    rules = [{ rulePriority = 1, description = "keep the last 30 images", selection = { tagStatus = "any", countType = "imageCountMoreThan", countNumber = 30 }, action = { type = "expire" } }]
  })
}

resource "aws_ecs_cluster" "main" {
  name = local.name
  setting {
    name  = "containerInsights"
    value = "enabled"
  }
  tags = local.tags
}

resource "aws_security_group" "tasks" {
  name        = "${local.name}-tasks"
  description = "ECS tasks: from the ALB; out to AWS APIs, LiveKit Cloud, SMTP"
  vpc_id      = aws_vpc.main.id
  tags        = local.tags
}

resource "aws_vpc_security_group_ingress_rule" "tasks_from_alb" {
  security_group_id            = aws_security_group.tasks.id
  referenced_security_group_id = aws_security_group.alb.id
  ip_protocol                  = "tcp"
  from_port                    = 3000
  to_port                      = 3001
}

resource "aws_vpc_security_group_ingress_rule" "clamav_from_tasks" {
  security_group_id            = aws_security_group.tasks.id
  referenced_security_group_id = aws_security_group.tasks.id
  ip_protocol                  = "tcp"
  from_port                    = 3310
  to_port                      = 3310
}

resource "aws_vpc_security_group_egress_rule" "tasks_out" {
  security_group_id = aws_security_group.tasks.id
  cidr_ipv4         = "0.0.0.0/0"
  ip_protocol       = "-1"
}

# ---------------------------------------------------------------- IAM

data "aws_iam_policy_document" "ecs_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["ecs-tasks.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "execution" {
  name               = "${local.name}-ecs-execution"
  assume_role_policy = data.aws_iam_policy_document.ecs_assume.json
  tags               = local.tags
}

resource "aws_iam_role_policy_attachment" "execution" {
  role       = aws_iam_role.execution.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

locals {
  injected_secrets = concat(
    [aws_secretsmanager_secret.jwt.arn, aws_secretsmanager_secret.db_app.arn, aws_secretsmanager_secret.db_retention.arn, aws_secretsmanager_secret.redis.arn],
    [for s in aws_secretsmanager_secret.external : s.arn],
    [aws_db_instance.main.master_user_secret[0].secret_arn],
    [for s in aws_secretsmanager_secret.oauth : s.arn],
  )
}

# The execution role reads exactly these secrets (never "*").
resource "aws_iam_role_policy" "execution_secrets" {
  role = aws_iam_role.execution.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      { Effect = "Allow", Action = ["secretsmanager:GetSecretValue"], Resource = local.injected_secrets },
      { Effect = "Allow", Action = ["kms:Decrypt"], Resource = aws_kms_key.data.arn },
    ]
  })
}

resource "aws_iam_role" "api_task" {
  name               = "${local.name}-api-task"
  assume_role_policy = data.aws_iam_policy_document.ecs_assume.json
  tags               = local.tags
}

resource "aws_iam_role_policy" "api_task" {
  role = aws_iam_role.api_task.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      { Effect = "Allow", Action = ["s3:GetObject", "s3:PutObject", "s3:DeleteObject", "s3:GetObjectVersion"], Resource = "${aws_s3_bucket.documents.arn}/*" },
      { Effect = "Allow", Action = ["s3:ListBucket"], Resource = aws_s3_bucket.documents.arn },
      # Bucket encryption uses the data key.
      { Effect = "Allow", Action = ["kms:GenerateDataKey", "kms:Decrypt"], Resource = aws_kms_key.data.arn },
      # Document envelope keys; the key policy additionally requires the org/document context.
      { Effect = "Allow", Action = ["kms:GenerateDataKey", "kms:Decrypt", "kms:Encrypt"], Resource = [aws_kms_key.documents.arn, aws_kms_key.recovery.arn] },
    ]
  })
}

# ---------------------------------------------------------------- task definitions

resource "aws_cloudwatch_log_group" "app" {
  for_each          = toset(["api", "realtime", "web", "clamav", "migrate"])
  name              = "/hrvo/${var.env}/${each.key}"
  retention_in_days = var.log_retention_days
  kms_key_id        = aws_kms_key.data.arn
  tags              = local.tags
}

resource "aws_service_discovery_private_dns_namespace" "internal" {
  name = "${var.env}.hrvo.internal"
  vpc  = aws_vpc.main.id
  tags = local.tags
}

resource "aws_service_discovery_service" "clamav" {
  name = "clamav"
  dns_config {
    namespace_id = aws_service_discovery_private_dns_namespace.internal.id
    dns_records {
      ttl  = 10
      type = "A"
    }
  }
  tags = local.tags
}

locals {
  image_api = "${aws_ecr_repository.app["api"].repository_url}:${var.image_tag}"
  image_web = "${aws_ecr_repository.app["web"].repository_url}:${var.image_tag}"
  log = { for k, g in aws_cloudwatch_log_group.app : k => {
    logDriver = "awslogs"
    options   = { "awslogs-group" = g.name, "awslogs-region" = data.aws_region.current.region, "awslogs-stream-prefix" = k }
  } }
  livekit_http = replace(replace(var.livekit_url, "wss://", "https://"), "ws://", "http://")

  # Configuration only; credentials arrive through `secrets` below (never as plain environment).
  api_env = [for k, v in {
    NODE_ENV                     = "production"
    PORT                         = "3001"
    APP_WEB_URL                  = "https://${local.web_host}"
    CORS_ORIGINS                 = "https://${local.web_host}"
    PGHOST                       = aws_db_instance.main.address
    PGPORT                       = "5432"
    PGDATABASE                   = "hrvo"
    PGUSER                       = "hrvo_app"
    PGRETENTION_USER             = "hrvo_retention"
    PGSSLMODE                    = "verify-full"
    REDIS_HOST                   = aws_elasticache_replication_group.main.primary_endpoint_address
    REDIS_PORT                   = "6379"
    REDIS_TLS                    = "true"
    COORDINATION                 = "redis"
    TRUST_PROXY                  = "2" # Cloudflare, then the ALB
    TRUST_PROXY_HEADERS          = "cloudflare"
    S3_BUCKET                    = aws_s3_bucket.documents.id
    S3_REGION                    = data.aws_region.current.region
    CLAMAV_HOST                  = "clamav.${aws_service_discovery_private_dns_namespace.internal.name}"
    CLAMAV_PORT                  = "3310"
    LIVEKIT_URL                  = var.livekit_url
    LIVEKIT_HTTP_URL             = local.livekit_http
    MAIL_TRANSPORT               = "smtp"
    API_PUBLIC_URL               = "https://${local.api_host}"
    CALENDAR_OAUTH_REDIRECT_URL  = "https://${local.api_host}/calendar/oauth/callback"
    GOOGLE_OAUTH_CLIENT_ID       = var.google_oauth_client_id
    MICROSOFT_OAUTH_CLIENT_ID    = var.microsoft_oauth_client_id
    DOCUMENT_KMS_PROVIDER        = "aws"
    DOCUMENT_KMS_KEY_ID          = aws_kms_key.documents.arn
    DOCUMENT_KMS_RECOVERY_KEY_ID = aws_kms_key.recovery.arn
  } : { name = k, value = v }]

  api_secrets = concat([
    { name = "JWT_SECRET", valueFrom = aws_secretsmanager_secret.jwt.arn },
    { name = "PGPASSWORD", valueFrom = aws_secretsmanager_secret.db_app.arn },
    { name = "PGRETENTION_PASSWORD", valueFrom = aws_secretsmanager_secret.db_retention.arn },
    { name = "REDIS_PASSWORD", valueFrom = aws_secretsmanager_secret.redis.arn },
    { name = "LIVEKIT_API_KEY", valueFrom = aws_secretsmanager_secret.external["livekit-api-key"].arn },
    { name = "LIVEKIT_API_SECRET", valueFrom = aws_secretsmanager_secret.external["livekit-api-secret"].arn },
    ], [for k, s in aws_secretsmanager_secret.oauth : { name = "${upper(k)}_OAUTH_CLIENT_SECRET", valueFrom = s.arn }],
  )
}

resource "aws_ecs_task_definition" "api" {
  for_each                 = { api = "true", realtime = "false" } # jobs run on the REST tasks only
  family                   = "${local.name}-${each.key}"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = var.api_cpu
  memory                   = var.api_memory
  execution_role_arn       = aws_iam_role.execution.arn
  task_role_arn            = aws_iam_role.api_task.arn
  runtime_platform {
    operating_system_family = "LINUX"
    cpu_architecture        = "X86_64"
  }
  container_definitions = jsonencode([{
    name                   = each.key
    image                  = local.image_api
    essential              = true
    readonlyRootFilesystem = true
    portMappings           = [{ containerPort = 3001, protocol = "tcp" }]
    environment            = concat(local.api_env, [{ name = "JOBS_ENABLED", value = each.value }])
    secrets                = local.api_secrets
    logConfiguration       = local.log[each.key]
    stopTimeout            = 30
    mountPoints            = [{ sourceVolume = "tmp", containerPath = "/tmp" }]
  }])
  volume { name = "tmp" }
  tags = local.tags
}

resource "aws_ecs_task_definition" "migrate" {
  family                   = "${local.name}-migrate"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = 512
  memory                   = 1024
  execution_role_arn       = aws_iam_role.execution.arn
  task_role_arn            = aws_iam_role.api_task.arn
  container_definitions = jsonencode([{
    name      = "migrate"
    image     = replace(local.image_api, ":${var.image_tag}", ":${var.image_tag}-migrate")
    essential = true
    environment = [
      { name = "PGHOST", value = aws_db_instance.main.address },
      { name = "PGPORT", value = "5432" },
      { name = "PGDATABASE", value = "hrvo" },
    ]
    secrets = [
      { name = "PGADMIN_USER", valueFrom = "${aws_db_instance.main.master_user_secret[0].secret_arn}:username::" },
      { name = "PGADMIN_PASSWORD", valueFrom = "${aws_db_instance.main.master_user_secret[0].secret_arn}:password::" },
      { name = "PGPASSWORD", valueFrom = aws_secretsmanager_secret.db_app.arn },
      { name = "PGRETENTION_PASSWORD", valueFrom = aws_secretsmanager_secret.db_retention.arn },
    ]
    logConfiguration = local.log["migrate"]
  }])
  tags = local.tags
}

resource "aws_ecs_task_definition" "web" {
  family                   = "${local.name}-web"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = 512
  memory                   = 1024
  execution_role_arn       = aws_iam_role.execution.arn
  container_definitions = jsonencode([{
    name             = "web"
    image            = local.image_web
    essential        = true
    portMappings     = [{ containerPort = 3000, protocol = "tcp" }]
    environment      = [{ name = "NODE_ENV", value = "production" }]
    logConfiguration = local.log["web"]
    stopTimeout      = 30
  }])
  tags = local.tags
}

resource "aws_ecs_task_definition" "clamav" {
  family                   = "${local.name}-clamav"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = 1024
  memory                   = 3072 # signature database needs ~2 GB
  execution_role_arn       = aws_iam_role.execution.arn
  container_definitions = jsonencode([{
    name             = "clamav"
    image            = "clamav/clamav:1.4"
    essential        = true
    portMappings     = [{ containerPort = 3310, protocol = "tcp" }]
    logConfiguration = local.log["clamav"]
  }])
  tags = local.tags
}

# ---------------------------------------------------------------- services

resource "aws_ecs_service" "api" {
  name                               = "api"
  cluster                            = aws_ecs_cluster.main.id
  task_definition                    = aws_ecs_task_definition.api["api"].arn
  desired_count                      = var.api_count
  launch_type                        = "FARGATE"
  deployment_minimum_healthy_percent = 100
  deployment_maximum_percent         = 200
  health_check_grace_period_seconds  = 60
  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }
  network_configuration {
    subnets         = aws_subnet.private[*].id
    security_groups = [aws_security_group.tasks.id]
  }
  load_balancer {
    target_group_arn = aws_lb_target_group.api.arn
    container_name   = "api"
    container_port   = 3001
  }
  depends_on = [aws_lb_listener.https]
  tags       = local.tags
  lifecycle { ignore_changes = [desired_count] } # autoscaling owns it
}

# One task: Socket.IO clients reconnect to it after a deploy (grace window 120 s, ADR 005).
resource "aws_ecs_service" "realtime" {
  name                               = "realtime"
  cluster                            = aws_ecs_cluster.main.id
  task_definition                    = aws_ecs_task_definition.api["realtime"].arn
  desired_count                      = 1
  launch_type                        = "FARGATE"
  deployment_minimum_healthy_percent = 0
  deployment_maximum_percent         = 100
  health_check_grace_period_seconds  = 60
  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }
  network_configuration {
    subnets         = aws_subnet.private[*].id
    security_groups = [aws_security_group.tasks.id]
  }
  load_balancer {
    target_group_arn = aws_lb_target_group.realtime.arn
    container_name   = "realtime"
    container_port   = 3001
  }
  depends_on = [aws_lb_listener.https]
  tags       = local.tags
}

resource "aws_ecs_service" "web" {
  name                               = "web"
  cluster                            = aws_ecs_cluster.main.id
  task_definition                    = aws_ecs_task_definition.web.arn
  desired_count                      = var.web_count
  launch_type                        = "FARGATE"
  deployment_minimum_healthy_percent = 100
  deployment_maximum_percent         = 200
  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }
  network_configuration {
    subnets         = aws_subnet.private[*].id
    security_groups = [aws_security_group.tasks.id]
  }
  load_balancer {
    target_group_arn = aws_lb_target_group.web.arn
    container_name   = "web"
    container_port   = 3000
  }
  depends_on = [aws_lb_listener.https]
  tags       = local.tags
  lifecycle { ignore_changes = [desired_count] }
}

resource "aws_ecs_service" "clamav" {
  name            = "clamav"
  cluster         = aws_ecs_cluster.main.id
  task_definition = aws_ecs_task_definition.clamav.arn
  desired_count   = 1
  launch_type     = "FARGATE"
  network_configuration {
    subnets         = aws_subnet.private[*].id
    security_groups = [aws_security_group.tasks.id]
  }
  service_registries { registry_arn = aws_service_discovery_service.clamav.arn }
  tags = local.tags
}

# ---------------------------------------------------------------- autoscaling (api, web)

resource "aws_appautoscaling_target" "svc" {
  for_each           = { api = var.api_count, web = var.web_count }
  service_namespace  = "ecs"
  resource_id        = "service/${aws_ecs_cluster.main.name}/${each.key}"
  scalable_dimension = "ecs:service:DesiredCount"
  min_capacity       = each.value
  max_capacity       = each.value * 4
  depends_on         = [aws_ecs_service.api, aws_ecs_service.web]
}

resource "aws_appautoscaling_policy" "cpu" {
  for_each           = aws_appautoscaling_target.svc
  name               = "${local.name}-${each.key}-cpu"
  policy_type        = "TargetTrackingScaling"
  service_namespace  = each.value.service_namespace
  resource_id        = each.value.resource_id
  scalable_dimension = each.value.scalable_dimension
  target_tracking_scaling_policy_configuration {
    target_value       = 60
    scale_in_cooldown  = 300
    scale_out_cooldown = 60
    predefined_metric_specification { predefined_metric_type = "ECSServiceAverageCPUUtilization" }
  }
}
