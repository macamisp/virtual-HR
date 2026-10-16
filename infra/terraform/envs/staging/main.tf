# HRVO staging (ADR 020). Separate AWS account per environment (SRS 10.3), region ap-southeast-1.
# Never applied by an agent: plan/apply only by an operator with approval (AGENTS.md).
#   terraform init -backend-config=backend.hcl
#   terraform plan -var-file=staging.tfvars
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
  description = "The staging AWS account. Terraform refuses to run against any other account."
  type        = string
}
variable "domain" { type = string }
variable "cloudflare_zone_id" { type = string }
variable "alert_emails" { type = list(string) }
variable "image_tag" { type = string }
variable "livekit_url" { type = string }

provider "aws" {
  region              = "ap-southeast-1"
  allowed_account_ids = [var.aws_account_id]
  default_tags { tags = { Project = "hrvo", Environment = "staging" } }
}

# The token comes from CLOUDFLARE_API_TOKEN (DNS edit and zone settings on this zone only).
provider "cloudflare" {}

module "platform" {
  source                   = "../../modules/platform"
  env                      = "staging"
  domain                   = var.domain
  cloudflare_zone_id       = var.cloudflare_zone_id
  alert_emails             = var.alert_emails
  image_tag                = var.image_tag
  livekit_url              = var.livekit_url
  nat_per_az               = false
  db_instance_class        = "db.t4g.medium"
  db_allocated_storage_gb  = 50
  db_multi_az              = false
  db_backup_retention_days = 7
  db_deletion_protection   = false
  redis_node_type          = "cache.t4g.small"
  redis_replicas           = 0
  api_count                = 1
  web_count                = 1
  api_cpu                  = 512
  api_memory               = 1024
  backup_retention_days    = 14
  manage_zone_settings     = false
}

output "platform" {
  value = module.platform
}
