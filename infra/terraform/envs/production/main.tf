# HRVO production (ADR 020). Separate AWS account per environment (SRS 10.3), region ap-southeast-1.
# Never applied by an agent: plan/apply only by an operator with approval (AGENTS.md).
#   terraform init -backend-config=backend.hcl
#   terraform plan -var-file=production.tfvars
terraform {
  required_version = ">= 1.11.0"
  backend "s3" {
    # bucket, key and region come from backend.hcl (see backend.hcl.example).
    encrypt      = true
    use_lockfile = true
  }
  required_providers {
    aws        = { source = "hashicorp/aws", version = "6.67.0" }
    cloudflare = { source = "cloudflare/cloudflare", version = "5.26.0" }
    random     = { source = "hashicorp/random", version = "3.9.1" }
  }
}

variable "aws_account_id" {
  description = "The production AWS account. Terraform refuses to run against any other account."
  type        = string
}
variable "domain" { type = string }
variable "cloudflare_zone_id" { type = string }
variable "alert_emails" { type = list(string) }
variable "image_tag" { type = string }
variable "livekit_url" { type = string }
variable "recording_enabled" {
  description = "ADR 024: prepare meeting recording (upload-only IAM user, secrets)."
  type        = bool
  default     = false
}

provider "aws" {
  region              = "ap-southeast-1"
  allowed_account_ids = [var.aws_account_id]
  default_tags { tags = { Project = "hrvo", Environment = "production" } }
}

# The token comes from CLOUDFLARE_API_TOKEN (DNS edit and zone settings on this zone only).
provider "cloudflare" {}

module "platform" {
  source                   = "../../modules/platform"
  env                      = "production"
  domain                   = var.domain
  cloudflare_zone_id       = var.cloudflare_zone_id
  alert_emails             = var.alert_emails
  image_tag                = var.image_tag
  livekit_url              = var.livekit_url
  recording_enabled        = var.recording_enabled
  nat_per_az               = true
  db_instance_class        = "db.m7g.large"
  db_allocated_storage_gb  = 100
  db_multi_az              = true
  db_backup_retention_days = 35
  db_deletion_protection   = true
  redis_node_type          = "cache.m7g.large"
  redis_replicas           = 1
  api_count                = 2
  web_count                = 2
  api_cpu                  = 1024
  api_memory               = 2048
  backup_retention_days    = 35
  manage_zone_settings     = true
}

output "platform" {
  value = module.platform
}
