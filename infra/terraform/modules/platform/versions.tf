terraform {
  required_version = ">= 1.11.0" # write-only arguments and ephemeral resources keep secrets out of state
  required_providers {
    aws        = { source = "hashicorp/aws", version = "6.67.0" }
    cloudflare = { source = "cloudflare/cloudflare", version = "5.26.0" }
    random     = { source = "hashicorp/random", version = "3.9.1" }
  }
}
