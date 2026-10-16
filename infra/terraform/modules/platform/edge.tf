# Cloudflare in front, then an ALB that accepts traffic ONLY from Cloudflare's IP ranges. That is
# what makes CF-Connecting-IP / CF-IPCountry trustworthy (TRUST_PROXY_HEADERS=cloudflare, ADR 019).
data "cloudflare_ip_ranges" "cf" {}

locals {
  web_host = "app.${var.domain}"
  api_host = "api.${var.domain}"
  cf_cidrs = concat(data.cloudflare_ip_ranges.cf.ipv4_cidrs, data.cloudflare_ip_ranges.cf.ipv6_cidrs)
}

resource "aws_security_group" "alb" {
  name        = "${local.name}-alb"
  description = "HTTPS from Cloudflare only"
  vpc_id      = aws_vpc.main.id
  tags        = local.tags
}

resource "aws_vpc_security_group_ingress_rule" "alb_from_cloudflare" {
  for_each          = toset(local.cf_cidrs)
  security_group_id = aws_security_group.alb.id
  cidr_ipv4         = strcontains(each.value, ":") ? null : each.value
  cidr_ipv6         = strcontains(each.value, ":") ? each.value : null
  ip_protocol       = "tcp"
  from_port         = 443
  to_port           = 443
}

resource "aws_vpc_security_group_egress_rule" "alb_to_tasks" {
  security_group_id            = aws_security_group.alb.id
  referenced_security_group_id = aws_security_group.tasks.id
  ip_protocol                  = "tcp"
  from_port                    = 3000
  to_port                      = 3001
}

resource "aws_lb" "main" {
  name                       = local.name
  load_balancer_type         = "application"
  internal                   = false
  ip_address_type            = "dualstack"
  subnets                    = aws_subnet.public[*].id
  security_groups            = [aws_security_group.alb.id]
  drop_invalid_header_fields = true
  # WebSockets: heartbeats every 30 s keep connections well inside this.
  idle_timeout               = 120
  enable_deletion_protection = var.env == "production"
  access_logs {
    bucket  = aws_s3_bucket.alb_logs.id
    prefix  = "alb"
    enabled = true
  }
  tags       = local.tags
  depends_on = [aws_s3_bucket_policy.alb_logs]
}

resource "aws_acm_certificate" "main" {
  domain_name               = local.web_host
  subject_alternative_names = [local.api_host]
  validation_method         = "DNS"
  lifecycle { create_before_destroy = true }
  tags = local.tags
}

resource "cloudflare_dns_record" "acm_validation" {
  for_each = { for o in aws_acm_certificate.main.domain_validation_options : o.domain_name => o }
  zone_id  = var.cloudflare_zone_id
  name     = trimsuffix(each.value.resource_record_name, ".")
  type     = each.value.resource_record_type
  content  = trimsuffix(each.value.resource_record_value, ".")
  ttl      = 60
  proxied  = false
}

resource "aws_acm_certificate_validation" "main" {
  certificate_arn         = aws_acm_certificate.main.arn
  validation_record_fqdns = [for r in cloudflare_dns_record.acm_validation : r.name]
}

resource "aws_lb_target_group" "web" {
  name        = "${local.name}-web"
  port        = 3000
  protocol    = "HTTP"
  target_type = "ip"
  vpc_id      = aws_vpc.main.id
  health_check {
    path    = "/login"
    matcher = "200"
  }
  deregistration_delay = 30
  tags                 = local.tags
}

resource "aws_lb_target_group" "api" {
  name        = "${local.name}-api"
  port        = 3001
  protocol    = "HTTP"
  target_type = "ip"
  vpc_id      = aws_vpc.main.id
  health_check {
    path    = "/health"
    matcher = "200"
  }
  deregistration_delay = 30
  tags                 = local.tags
}

# All Socket.IO traffic goes to the realtime service (the office world lives in one process).
resource "aws_lb_target_group" "realtime" {
  name        = "${local.name}-rt"
  port        = 3001
  protocol    = "HTTP"
  target_type = "ip"
  vpc_id      = aws_vpc.main.id
  health_check {
    path    = "/health"
    matcher = "200"
  }
  deregistration_delay = 30
  tags                 = local.tags
}

resource "aws_lb_listener" "https" {
  load_balancer_arn = aws_lb.main.arn
  port              = 443
  protocol          = "HTTPS"
  ssl_policy        = "ELBSecurityPolicy-TLS13-1-2-2021-06"
  certificate_arn   = aws_acm_certificate_validation.main.certificate_arn
  default_action {
    type = "fixed-response"
    fixed_response {
      content_type = "text/plain"
      message_body = "Not found"
      status_code  = "404"
    }
  }
}

resource "aws_lb_listener_rule" "socket" {
  listener_arn = aws_lb_listener.https.arn
  priority     = 10
  action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.realtime.arn
  }
  condition {
    host_header { values = [local.api_host] }
  }
  condition {
    path_pattern { values = ["/socket.io/*"] }
  }
}

resource "aws_lb_listener_rule" "api" {
  listener_arn = aws_lb_listener.https.arn
  priority     = 20
  action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.api.arn
  }
  condition {
    host_header { values = [local.api_host] }
  }
}

resource "aws_lb_listener_rule" "web" {
  listener_arn = aws_lb_listener.https.arn
  priority     = 30
  action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.web.arn
  }
  condition {
    host_header { values = [local.web_host] }
  }
}

# Public names, proxied through Cloudflare (TLS full strict to the ALB's ACM certificate).
resource "cloudflare_dns_record" "web" {
  zone_id = var.cloudflare_zone_id
  name    = local.web_host
  type    = "CNAME"
  content = aws_lb.main.dns_name
  ttl     = 1
  proxied = true
}

resource "cloudflare_dns_record" "api" {
  zone_id = var.cloudflare_zone_id
  name    = local.api_host
  type    = "CNAME"
  content = aws_lb.main.dns_name
  ttl     = 1
  proxied = true
}

resource "cloudflare_zone_setting" "tls" {
  for_each = var.manage_zone_settings ? {
    ssl                      = "strict"
    always_use_https         = "on"
    min_tls_version          = "1.2"
    automatic_https_rewrites = "on"
    websockets               = "on"
  } : {}
  zone_id    = var.cloudflare_zone_id
  setting_id = each.key
  value      = each.value
}
