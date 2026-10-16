# Alerts (SNS email) and a dashboard. Thresholds are starting points for 50-500 users (SRS 12.2).
resource "aws_sns_topic" "alerts" {
  name              = "${local.name}-alerts"
  kms_master_key_id = aws_kms_key.data.arn
  tags              = local.tags
}

resource "aws_sns_topic_subscription" "email" {
  for_each  = toset(var.alert_emails)
  topic_arn = aws_sns_topic.alerts.arn
  protocol  = "email"
  endpoint  = each.value
}

locals {
  alarm_defaults = { evaluation_periods = 3, period = 300, treat_missing_data = "notBreaching" }
  alarms = merge(
    {
      alb_5xx         = { namespace = "AWS/ApplicationELB", metric = "HTTPCode_Target_5XX_Count", stat = "Sum", threshold = 20, op = "GreaterThanThreshold", dims = { LoadBalancer = aws_lb.main.arn_suffix }, desc = "Many server errors behind the load balancer" }
      alb_latency     = { namespace = "AWS/ApplicationELB", metric = "TargetResponseTime", stat = "p95", threshold = 2, op = "GreaterThanThreshold", dims = { LoadBalancer = aws_lb.main.arn_suffix }, desc = "p95 response time above 2 s" }
      rds_cpu         = { namespace = "AWS/RDS", metric = "CPUUtilization", stat = "Average", threshold = 80, op = "GreaterThanThreshold", dims = { DBInstanceIdentifier = aws_db_instance.main.identifier }, desc = "Database CPU above 80 %" }
      rds_storage     = { namespace = "AWS/RDS", metric = "FreeStorageSpace", stat = "Minimum", threshold = var.db_allocated_storage_gb * 1073741824 * 0.15, op = "LessThanThreshold", dims = { DBInstanceIdentifier = aws_db_instance.main.identifier }, desc = "Database free storage below 15 %" }
      rds_memory      = { namespace = "AWS/RDS", metric = "FreeableMemory", stat = "Minimum", threshold = 268435456, op = "LessThanThreshold", dims = { DBInstanceIdentifier = aws_db_instance.main.identifier }, desc = "Database freeable memory below 256 MB" }
      rds_connections = { namespace = "AWS/RDS", metric = "DatabaseConnections", stat = "Maximum", threshold = 300, op = "GreaterThanThreshold", dims = { DBInstanceIdentifier = aws_db_instance.main.identifier }, desc = "Unusually many database connections" }
      redis_cpu       = { namespace = "AWS/ElastiCache", metric = "EngineCPUUtilization", stat = "Average", threshold = 75, op = "GreaterThanThreshold", dims = { ReplicationGroupId = aws_elasticache_replication_group.main.id }, desc = "Redis engine CPU above 75 %" }
      redis_memory    = { namespace = "AWS/ElastiCache", metric = "DatabaseMemoryUsagePercentage", stat = "Maximum", threshold = 80, op = "GreaterThanThreshold", dims = { ReplicationGroupId = aws_elasticache_replication_group.main.id }, desc = "Redis memory above 80 % (noeviction: BullMQ stops at 100 %)" }
      realtime_down   = { namespace = "ECS/ContainerInsights", metric = "RunningTaskCount", stat = "Minimum", threshold = 1, op = "LessThanThreshold", dims = { ClusterName = aws_ecs_cluster.main.name, ServiceName = "realtime" }, desc = "No realtime task: live presence, office and chat delivery are down", treat_missing_data = "breaching", evaluation_periods = 2, period = 60 }
      app_errors      = { namespace = "HRVO/${var.env}", metric = "ApiErrors", stat = "Sum", threshold = 25, op = "GreaterThanThreshold", dims = {}, desc = "Many ERROR log lines from the API" }
    },
    { for tg, arn in { api = aws_lb_target_group.api.arn_suffix, realtime = aws_lb_target_group.realtime.arn_suffix, web = aws_lb_target_group.web.arn_suffix } :
    "unhealthy_${tg}" => { namespace = "AWS/ApplicationELB", metric = "UnHealthyHostCount", stat = "Maximum", threshold = 0, op = "GreaterThanThreshold", dims = { TargetGroup = arn, LoadBalancer = aws_lb.main.arn_suffix }, desc = "Unhealthy ${tg} targets", evaluation_periods = 2, period = 60 } },
    { for svc in ["api", "realtime", "web"] : "cpu_${svc}" => { namespace = "AWS/ECS", metric = "CPUUtilization", stat = "Average", threshold = 85, op = "GreaterThanThreshold", dims = { ClusterName = aws_ecs_cluster.main.name, ServiceName = svc }, desc = "${svc} CPU above 85 %" } },
    { for svc in ["api", "realtime", "web"] : "memory_${svc}" => { namespace = "AWS/ECS", metric = "MemoryUtilization", stat = "Average", threshold = 85, op = "GreaterThanThreshold", dims = { ClusterName = aws_ecs_cluster.main.name, ServiceName = svc }, desc = "${svc} memory above 85 %" } },
  )
}

resource "aws_cloudwatch_metric_alarm" "main" {
  for_each            = local.alarms
  alarm_name          = "${local.name}-${each.key}"
  alarm_description   = each.value.desc
  namespace           = each.value.namespace
  metric_name         = each.value.metric
  statistic           = can(regex("^p\\d", each.value.stat)) ? null : each.value.stat
  extended_statistic  = can(regex("^p\\d", each.value.stat)) ? each.value.stat : null
  threshold           = each.value.threshold
  comparison_operator = each.value.op
  dimensions          = each.value.dims
  period              = lookup(each.value, "period", local.alarm_defaults.period)
  evaluation_periods  = lookup(each.value, "evaluation_periods", local.alarm_defaults.evaluation_periods)
  treat_missing_data  = lookup(each.value, "treat_missing_data", local.alarm_defaults.treat_missing_data)
  alarm_actions       = [aws_sns_topic.alerts.arn]
  ok_actions          = [aws_sns_topic.alerts.arn]
  tags                = local.tags
}

# ERROR lines from the API (the app never logs secrets, tokens or document content).
resource "aws_cloudwatch_log_metric_filter" "api_errors" {
  for_each       = toset(["api", "realtime"])
  name           = "${local.name}-${each.key}-errors"
  log_group_name = aws_cloudwatch_log_group.app[each.key].name
  pattern        = "ERROR"
  metric_transformation {
    name      = "ApiErrors"
    namespace = "HRVO/${var.env}"
    value     = "1"
  }
}

# Failed backup or restore jobs go to the same topic.
resource "aws_cloudwatch_event_rule" "backup_failed" {
  name = "${local.name}-backup-failed"
  event_pattern = jsonencode({
    source        = ["aws.backup"]
    "detail-type" = ["Backup Job State Change", "Restore Job State Change", "Copy Job State Change"]
    detail        = { state = ["FAILED", "ABORTED", "EXPIRED"] }
  })
  tags = local.tags
}

resource "aws_cloudwatch_event_target" "backup_failed" {
  rule = aws_cloudwatch_event_rule.backup_failed.name
  arn  = aws_sns_topic.alerts.arn
}

resource "aws_sns_topic_policy" "alerts" {
  arn = aws_sns_topic.alerts.arn
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      { Sid = "CloudWatch", Effect = "Allow", Principal = { Service = "cloudwatch.amazonaws.com" }, Action = "sns:Publish", Resource = aws_sns_topic.alerts.arn },
      { Sid = "EventBridge", Effect = "Allow", Principal = { Service = "events.amazonaws.com" }, Action = "sns:Publish", Resource = aws_sns_topic.alerts.arn },
    ]
  })
}

resource "aws_cloudwatch_dashboard" "main" {
  dashboard_name = local.name
  dashboard_body = jsonencode({
    widgets = [
      { type = "metric", x = 0, y = 0, width = 12, height = 6, properties = { title = "Requests and 5xx", region = data.aws_region.current.region, stat = "Sum", period = 60,
      metrics = [["AWS/ApplicationELB", "RequestCount", "LoadBalancer", aws_lb.main.arn_suffix], [".", "HTTPCode_Target_5XX_Count", ".", "."]] } },
      { type = "metric", x = 12, y = 0, width = 12, height = 6, properties = { title = "Response time p95", region = data.aws_region.current.region, stat = "p95", period = 60,
      metrics = [["AWS/ApplicationELB", "TargetResponseTime", "LoadBalancer", aws_lb.main.arn_suffix]] } },
      { type = "metric", x = 0, y = 6, width = 12, height = 6, properties = { title = "ECS CPU", region = data.aws_region.current.region, stat = "Average", period = 60,
      metrics = [for svc in ["api", "realtime", "web"] : ["AWS/ECS", "CPUUtilization", "ClusterName", aws_ecs_cluster.main.name, "ServiceName", svc]] } },
      { type = "metric", x = 12, y = 6, width = 12, height = 6, properties = { title = "Database and Redis", region = data.aws_region.current.region, stat = "Average", period = 60,
      metrics = [["AWS/RDS", "CPUUtilization", "DBInstanceIdentifier", aws_db_instance.main.identifier], ["AWS/ElastiCache", "EngineCPUUtilization", "ReplicationGroupId", aws_elasticache_replication_group.main.id]] } },
    ]
  })
}
