variable "project" {
  type        = string
  description = "Project name"
}

variable "vpc_cidr_block" {
  type        = cidr_block
  description = "IP range for VPC"
}

variable "public_subnet_cidr_block" {
  type        = cidr_block
  description = "Publicly reachable subnet of VPC"
}

variable "notification_email" {
  type        = email
  description = "Destination for notifications"
}

variable "ssh_key" {
  type        = ssh_key
  description = "Name of EC2 ssh key for connecting to provisioned instances."
}