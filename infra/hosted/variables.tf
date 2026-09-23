# Every account-specific value is a variable with no default, so a missing
# terraform.tfvars fails the plan rather than falling back to a guess.

variable "aws_account_id" {
  type        = string
  description = "The AWS account that holds both environments. The AWS provider refuses to run against any other account."

  validation {
    condition     = can(regex("^[0-9]{12}$", var.aws_account_id))
    error_message = "aws_account_id must be the 12-digit account id."
  }
}

variable "aws_region" {
  type        = string
  description = "The region both environments run in, as their platform ARN states it."
}

variable "application_name" {
  type        = string
  description = "The Elastic Beanstalk application both environments belong to: the deploy workflow's EB_APPLICATION_NAME variable."
}

variable "platform_arn" {
  type        = string
  description = "The platform version ARN both environments run, as the committed configuration files state it. Changing it is a platform update."
}

variable "vpc_id" {
  type        = string
  description = "The VPC the environments and the origin security group are in (aws:ec2:vpc VPCId)."
}

variable "subnet_id" {
  type        = string
  description = "The public subnet each single instance is launched in (aws:ec2:vpc Subnets)."
}

variable "notification_endpoint" {
  type        = string
  description = "The address environment health notifications are sent to (aws:elasticbeanstalk:sns:topics Notification Endpoint)."
}

variable "origin_security_group" {
  type = object({
    name        = string
    description = string
  })
  description = "The one security group both instances attach. When adopting a live group, name and description must be its own: changing either replaces the group."
}

variable "cloudflare_zone_id" {
  type        = string
  description = "The Cloudflare zone both public names are in. Its settings apply to every name in the zone, not only these two."
}

variable "environments" {
  type = map(object({
    name        = string
    description = optional(string)
    public_name = string
  }))
  description = <<-EOT
    One entry per environment, keyed production and staging like the committed
    configuration files. name is the deploy workflow's EB_ENVIRONMENT_NAME for
    that environment; public_name is the fully qualified name Cloudflare serves
    it on.
  EOT

  validation {
    condition     = toset(keys(var.environments)) == toset(["production", "staging"])
    error_message = "environments must have exactly the keys production and staging."
  }
}
