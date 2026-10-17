# Two customer-managed keys (SRS 10.1):
#  - documents: wraps the per-file data keys (envelope encryption; the KeyProvider adapter, item 4).
#    Only the API task role may use it, and only with an org_id/document_id encryption context.
#  - data: RDS, ElastiCache, S3 buckets, Secrets Manager, logs and backups.
resource "aws_kms_key" "documents" {
  description             = "${local.name} document data keys (envelope encryption)"
  enable_key_rotation     = true
  deletion_window_in_days = 30
  policy                  = data.aws_iam_policy_document.documents_key.json
  tags                    = local.tags
}

resource "aws_kms_alias" "documents" {
  name          = "alias/${local.name}-documents"
  target_key_id = aws_kms_key.documents.key_id
}

data "aws_iam_policy_document" "documents_key" {
  statement {
    sid       = "AccountAdministration"
    actions   = ["kms:*"]
    resources = ["*"]
    principals {
      type        = "AWS"
      identifiers = ["arn:aws:iam::${data.aws_caller_identity.current.account_id}:root"]
    }
  }
  statement {
    sid       = "ApiWrapAndUnwrapWithContext"
    actions   = ["kms:GenerateDataKey", "kms:Decrypt", "kms:Encrypt"]
    resources = ["*"]
    principals {
      type        = "AWS"
      identifiers = [aws_iam_role.api_task.arn]
    }
    # SRS 10.1: every wrap/unwrap is bound to its organisation and document.
    condition {
      test     = "Null"
      variable = "kms:EncryptionContext:org_id"
      values   = ["false"]
    }
    condition {
      test     = "Null"
      variable = "kms:EncryptionContext:document_id"
      values   = ["false"]
    }
  }
}

# SRS 10.1 step 5: password-recovery escrow under its own key, so access to one key does not imply
# the other (separate grants and audit trail in CloudTrail). Same context-bound policy.
resource "aws_kms_key" "recovery" {
  description             = "${local.name} document recovery escrow"
  enable_key_rotation     = true
  deletion_window_in_days = 30
  policy                  = data.aws_iam_policy_document.documents_key.json
  tags                    = local.tags
}

resource "aws_kms_alias" "recovery" {
  name          = "alias/${local.name}-recovery"
  target_key_id = aws_kms_key.recovery.key_id
}

resource "aws_kms_key" "data" {
  description             = "${local.name} data at rest (RDS, Redis, S3, secrets, logs, backups)"
  enable_key_rotation     = true
  deletion_window_in_days = 30
  policy                  = data.aws_iam_policy_document.data_key.json
  tags                    = local.tags
}

resource "aws_kms_alias" "data" {
  name          = "alias/${local.name}-data"
  target_key_id = aws_kms_key.data.key_id
}

data "aws_iam_policy_document" "data_key" {
  statement {
    sid       = "AccountAdministration"
    actions   = ["kms:*"]
    resources = ["*"]
    principals {
      type        = "AWS"
      identifiers = ["arn:aws:iam::${data.aws_caller_identity.current.account_id}:root"]
    }
  }
  # Encrypted alert topic: CloudWatch alarms and EventBridge must be able to publish to it.
  statement {
    sid       = "AlertPublishers"
    actions   = ["kms:GenerateDataKey*", "kms:Decrypt"]
    resources = ["*"]
    principals {
      type        = "Service"
      identifiers = ["cloudwatch.amazonaws.com", "events.amazonaws.com", "backup.amazonaws.com"]
    }
  }
  statement {
    sid       = "CloudWatchLogs"
    actions   = ["kms:Encrypt*", "kms:Decrypt*", "kms:ReEncrypt*", "kms:GenerateDataKey*", "kms:Describe*"]
    resources = ["*"]
    principals {
      type        = "Service"
      identifiers = ["logs.${data.aws_region.current.region}.amazonaws.com"]
    }
  }
}
