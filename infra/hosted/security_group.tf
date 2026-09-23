data "cloudflare_ip_ranges" "edge" {}

# The only security group either instance attaches: environments.tf turns the
# platform's own group off. Inline rules make both lists exclusive, so a rule
# added outside this root is a difference in the next plan and an apply
# removes it.
resource "aws_security_group" "origin" {
  name        = var.origin_security_group.name
  description = var.origin_security_group.description
  vpc_id      = var.vpc_id

  ingress {
    # The live rule's text: a different description replaces the rule on apply.
    description      = "Cloudflare edge, fetched 2026-09-17"
    protocol         = "tcp"
    from_port        = 443
    to_port          = 443
    cidr_blocks      = data.cloudflare_ip_ranges.edge.ipv4_cidrs
    ipv6_cidr_blocks = data.cloudflare_ip_ranges.edge.ipv6_cidrs
  }

  # The instance reaches Elastic Beanstalk, S3, CloudWatch Logs and Session
  # Manager outbound; with no platform group attached, this is its only egress.
  egress {
    protocol    = "-1"
    from_port   = 0
    to_port     = 0
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = {
    Name = "jspsi-webserver"
  }

  lifecycle {
    prevent_destroy = true
  }
}
