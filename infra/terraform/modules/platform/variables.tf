variable "env" {
  description = "Environment name: staging or production."
  type        = string
  validation {
    condition     = contains(["staging", "production"], var.env)
    error_message = "env must be staging or production."
  }
}

variable "domain" {
  description = "Apex domain on Cloudflare, e.g. hrvo.example.com. Web at app.<domain>, API at api.<domain>."
  type        = string
}

variable "cloudflare_zone_id" {
  description = "Cloudflare zone id of the domain."
  type        = string
}

variable "alert_emails" {
  description = "Who receives monitoring alerts (SNS email subscriptions, confirmed by each recipient)."
  type        = list(string)
}

variable "az_count" {
  description = "Availability zones (subnets, NAT gateways when nat_per_az)."
  type        = number
  default     = 3
}

variable "vpc_cidr" {
  type    = string
  default = "10.40.0.0/16"
}

variable "nat_per_az" {
  description = "One NAT gateway per AZ (production) or a single one (staging, cheaper)."
  type        = bool
}

variable "db_instance_class" { type = string }
variable "db_allocated_storage_gb" { type = number }
variable "db_multi_az" { type = bool }
variable "db_backup_retention_days" { type = number }
variable "db_deletion_protection" { type = bool }

variable "redis_node_type" { type = string }
variable "redis_replicas" {
  description = "Read replicas next to the primary (>= 1 enables automatic failover and Multi-AZ)."
  type        = number
}

variable "image_tag" {
  description = "Container image tag (git SHA) for api, web and migrate."
  type        = string
}

variable "api_count" { type = number }
variable "web_count" { type = number }
variable "api_cpu" { type = number }
variable "api_memory" { type = number }

variable "livekit_url" {
  description = "LiveKit Cloud project URL (wss://...). Key and secret are set in Secrets Manager after apply."
  type        = string
}

variable "log_retention_days" {
  type    = number
  default = 90
}

variable "backup_retention_days" {
  description = "How long AWS Backup keeps daily recovery points (RDS and documents)."
  type        = number
}

variable "manage_zone_settings" {
  description = "Zone-wide Cloudflare settings (TLS strict, HTTPS only). Exactly one environment owns them."
  type        = bool
  default     = false
}

variable "google_oauth_client_id" {
  description = "Google OAuth client id for calendar sync (ADR 023); empty = Google sync off. The client secret goes in Secrets Manager."
  type        = string
  default     = ""
}

variable "microsoft_oauth_client_id" {
  description = "Microsoft (Entra) app id for Outlook calendar sync (ADR 023); empty = Outlook sync off."
  type        = string
  default     = ""
}

variable "recording_enabled" {
  description = "ADR 024: create the upload-only IAM user and secrets LiveKit Cloud Egress needs for meeting recordings. Organisations still switch recording on themselves."
  type        = bool
  default     = false
}
