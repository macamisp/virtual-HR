output "alb_dns_name" { value = aws_lb.main.dns_name }
output "web_url" { value = "https://${local.web_host}" }
output "api_url" { value = "https://${local.api_host}" }
output "ecr_repositories" { value = { for k, r in aws_ecr_repository.app : k => r.repository_url } }
output "cluster" { value = aws_ecs_cluster.main.name }
output "migrate_task_definition" { value = aws_ecs_task_definition.migrate.family }
output "private_subnets" { value = aws_subnet.private[*].id }
output "task_security_group" { value = aws_security_group.tasks.id }
output "documents_kms_key_arn" { value = aws_kms_key.documents.arn }
output "recovery_kms_key_arn" { value = aws_kms_key.recovery.arn }
output "documents_bucket" { value = aws_s3_bucket.documents.id }
output "db_identifier" { value = aws_db_instance.main.identifier }
output "secrets_to_fill" {
  description = "Secrets an operator sets once after the first apply (values never pass through Terraform)."
  value       = { for k, s in aws_secretsmanager_secret.external : k => s.name }
}
output "alerts_topic" { value = aws_sns_topic.alerts.arn }
