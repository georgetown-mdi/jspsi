terraform {
  # 1.10 for the S3 backend's use_lockfile, which backend.hcl.example sets.
  required_version = ">= 1.10.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.7"
    }
    cloudflare = {
      source  = "cloudflare/cloudflare"
      version = "~> 5.0"
    }
  }

  # Partial configuration: the bucket, key and region come from a gitignored
  # backend.hcl at `tofu init -backend-config=backend.hcl`, so no state location
  # is written into the repository.
  backend "s3" {}
}
