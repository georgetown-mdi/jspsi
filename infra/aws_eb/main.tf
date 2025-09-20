terraform {
  required_providers {
    aws = {
      source = "hashicorp/aws"
      version = "6.7.0"
    }
  }
}

provider "aws" {
}

resource "aws_vpc" "vpc" {
  cidr_block = var.vpc_cidr_block
  // enable_dns_hostnames = true
  
  tags = {
    Name = "${var.project}-vpc"
  }
}

resource "aws_subnet" "public_subnet" {
  vpc_id              = aws_vpc.vpc.id
  cidr_block          = var.public_subnet_cidr_block
  map_public_ip_on_launch = true  # Ensure instances get a public IP
  tags = {
    Name = "${var.project}-public-sb"
  }
}

resource "aws_internet_gateway" "ig" {
  vpc_id = aws_vpc.vpc.id
  tags = {
    Name = "${var.project}-ig"
  }
}

resource "aws_route_table" "app_rt" {
  vpc_id = aws_vpc.vpc.id
  route {
    cidr_block = "0.0.0.0/0"
    gateway_id = aws_internet_gateway.ig.id
  }
  tags = {
    Name = "${var.project}-public-rt"
  }
}

resource "aws_security_group" "allow_https" {
  name        = "${var.project}-allow-https-sg"
  vpc_id      = aws_vpc.vpc.id
  description = "Allow HTTPS access"
  ingress {
    cidr_blocks = ["0.0.0.0/0"]
    from_port   = 80
    to_port     = 80
    protocol    = "tcp"
    description = "Allow HTTP traffic from anywhere"
  }
  ingress {
    cidr_blocks = ["0.0.0.0/0"]
    from_port   = 443
    to_port     = 443
    protocol    = "tcp"
    description = "Allow HTTPS traffic from anywhere"
  }
  egress {
    cidr_blocks = ["0.0.0.0/0"]
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    description = "Allow all outbound traffic"
  }
}


// see https://raw.githubusercontent.com/awslabs/elastic-beanstalk-samples/master/cfn-templates/servicerole.yaml
// for a different service role
resource "aws_iam_role" "eb_service_role" {
  name = "${var.project}-eb-service-role"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Principal = {
          Service = "elasticbeanstalk.amazonaws.com"
        }
        Action = "sts:AssumeRole"
      }
    ]
  })
}

resource "aws_iam_role_policy_attachment" "eb_service_role_health_monitoring_policy" {
  role       = aws_iam_role.eb_service_role.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSElasticBeanstalkEnhancedHealth"
}

resource "aws_iam_role_policy_attachment" "eb_service_role_environment_management_policy" {
  role       = aws_iam_role.eb_service_role.name
  policy_arn = "arn:aws:iam::aws:policy/AWSElasticBeanstalkManagedUpdatesCustomerRolePolicy"
}

resource "aws_iam_role" "eb_instance_role" {
  name = "${var.project}-ec2-role"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Principal = {
          Service = "ec2.amazonaws.com"
        }
        Action = "sts:AssumeRole"
      }
    ]
  })
}

// arn:aws:iam::aws:policy/AWSElasticBeanstalkWorkerTier

// If you use the AWS SDK to access other services from your instances, add policies for those
// services to the list of managed policies attached to the role. For example-
// arn:aws:iam::aws:policy/AmazonDynamoDBFullAccess
// arn:aws:iam::aws:policy/AmazonSNSFullAccess
// arn:aws:iam::aws:policy/CloudWatchLogsFullAccess

// If you use the Multicontainer Docker platform, add ECS and ECR permissions with these policies
// arn:aws:iam::aws:policy/AWSElasticBeanstalkMulticontainerDocker
// arn:aws:iam::aws:policy/AmazonEC2ContainerRegistryReadOnly

resource "aws_iam_role_policy_attachment" "eb_instance_role_web_tier_role" {
  role       = aws_iam_role.eb_instance_role.name
  policy_arn = "arn:aws:iam::aws:policy/AWSElasticBeanstalkWebTier"
}

resource "aws_iam_instance_profile" "eb_instance_profile" {
  name = "${var.project}-ec2-instance-profile"
  role = aws_iam_role.eb_instance_role.name
}

resource "aws_sns_topic" "env_updates_topic" {
  name   = "${var.project}-env-topic"
}

resource "aws_sns_topic_subscription" "user_subscription" {
  topic_arn = aws_sns_topic.env_updates_topic.arn
  protocol  = "email"
  endpoint = var.notification_email
}

resource "aws_elastic_beanstalk_application" "eb_app" {
  name        = "${var.project}"
  description = "My application deployed on Elastic Beanstalk"
}

data "aws_elastic_beanstalk_solution_stack" "node_js_ss" {
  most_recent = true

  name_regex = "^64bit Amazon Linux (.*) running Node.js (.*)$"
}

resource "aws_elastic_beanstalk_environment" "eb_app_env" {
  application         = var.project
  name                = "${var.project}-env"
  solution_stack_name = node_js_ss
  tier                = "WebServer"

  setting {
    namespace = "aws:autoscaling:asg"
    name      = "MaxSize"
    value     = "1"
  }
  setting {
    namespace = "aws:autoscaling:launchconfiguration"
    name      = "EC2KeyName"
    value     = var.ssh_key
  }
  setting {
    namespace = "aws:autoscaling:launchconfiguration"
    name      = "IamInstanceProfile"
    value     = aws_iam_instance_profile.eb_instance_profile.name
  }
  setting {
    namespace = "aws:ec2:instances"
    name      = "InstanceTypes"
    value     = "tg4.nano"
  }
  setting {
    namespace = "aws:ec2:vpc"
    name      = "VPCId"
    value     = vpc.id
  }
  setting {
    namespace = "aws:ec2:vpc"
    name      = "Subnets"
    value     = aws_subnet.public_subnet.id
  }
  setting {
    namespace = "aws:ec2:vpc"
    name      = "AssociatePublicIpAddress"
    value     = true
  }
  setting {
    namespace = "aws:elasticbeanstalk:command"
    name      = "BatchSize"
    value     = "100"
  }
  setting {
    namespace = "aws:elasticbeanstalk:command"
    name      = "BatchSizeType"
    value     = "Percentage"
  }
  setting {
    namespace = "aws:elasticbeanstalk:environment"
    name      = "EnvironmentType"
    value     = "SingleInstance"
  }
  setting {
    namespace = "aws:elasticbeanstalk:healthreporting:system"
    name      = "ConfigDocument"
    value = jsonencode({
      CloudWatchMetrics = {
        Environment = {
          ApplicationRequests4xx = 60
          ApplicationRequests5xx = 60
          InstancesDegraded      = 60
          InstancesSevere        = 60
        }
        Instance = {
          ApplicationRequests4xx = 60
          ApplicationRequests5xx = 60
        }
      }
      Rules = {
        Environment = {
          Application = {
            ApplicationRequests4xx = {
              Enabled = true
            }
          }
          ELB = {
            ELBRequests4xx = {
              Enabled = true
            }
          }
        }
      }
      Version = 1
    })
  }
  setting {
    namespace = "aws:elasticbeanstalk:healthreporting:system"
    name      = "SystemType"
    value     = "enhanced"
  }
  setting {
    namespace = "aws:elasticbeanstalk:healthreporting:system"
    name      = "EnhancedHealthAuthEnabled"
    value     = "true"
  }
  setting {
    namespace = "aws:elasticbeanstalk:sns:topics"
    name      = "Notification Endpoint"
    value     = var.notification_email
  }
  setting {
    namespace = "aws:elasticbeanstalk:sns:topics"
    name      = "Notification Protocol"
    value     = "email"
  }
  setting {
    namespace = "aws:elasticbeanstalk:sns:topics"
    name      = "Notification Topic ARN"
    value     =  aws_sns_topic.env_updates_topic.arn
  }
}