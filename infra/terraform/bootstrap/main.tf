# One-time, per AWS account: the encrypted, versioned S3 bucket that holds Terraform state
# (locking with S3's native lock file, Terraform >= 1.10). Applied by an operator only.
#   terraform init && terraform apply -var aws_account_id=... -var env=staging
terraform {
  required_version = ">= 1.11.0"
  required_providers {
    aws = { source = "hashicorp/aws", version = "6.67.0" }
  }
}

variable "aws_account_id" { type = string }
variable "env" {
  type = string
  validation {
    condition     = contains(["staging", "production"], var.env)
    error_message = "env must be staging or production."
  }
}

provider "aws" {
  region              = "ap-southeast-1"
  allowed_account_ids = [var.aws_account_id]
}

resource "aws_kms_key" "state" {
  description         = "hrvo-${var.env} Terraform state"
  enable_key_rotation = true
}

resource "aws_s3_bucket" "state" {
  bucket = "hrvo-${var.env}-tfstate-${var.aws_account_id}"
  lifecycle { prevent_destroy = true }
}

resource "aws_s3_bucket_versioning" "state" {
  bucket = aws_s3_bucket.state.id
  versioning_configuration { status = "Enabled" }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "state" {
  bucket = aws_s3_bucket.state.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm     = "aws:kms"
      kms_master_key_id = aws_kms_key.state.arn
    }
    bucket_key_enabled = true
  }
}

resource "aws_s3_bucket_public_access_block" "state" {
  bucket                  = aws_s3_bucket.state.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_policy" "state" {
  bucket = aws_s3_bucket.state.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid       = "DenyInsecureTransport"
      Effect    = "Deny"
      Principal = "*"
      Action    = "s3:*"
      Resource  = [aws_s3_bucket.state.arn, "${aws_s3_bucket.state.arn}/*"]
      Condition = { Bool = { "aws:SecureTransport" = "false" } }
    }]
  })
  depends_on = [aws_s3_bucket_public_access_block.state]
}

output "state_bucket" { value = aws_s3_bucket.state.id }
