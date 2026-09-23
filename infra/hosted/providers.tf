# Credentials come from the operator's environment: the AWS provider's default
# chain (AWS_PROFILE or the AWS_* variables) and CLOUDFLARE_API_TOKEN. Neither
# is a variable of this root, so neither can land in a tfvars file.

provider "aws" {
  region              = var.aws_region
  allowed_account_ids = [var.aws_account_id]
}

provider "cloudflare" {}
