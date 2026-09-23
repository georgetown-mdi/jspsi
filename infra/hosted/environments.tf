locals {
  service_role_arn = "arn:aws:iam::${var.aws_account_id}:role/aws-elasticbeanstalk-service-role"

  # Kept byte-for-byte as the configuration files state it: the platform
  # compares the string, and a re-encoded document with the same meaning is a
  # difference in every plan.
  health_config_document = "{\"Version\":1,\"CloudWatchMetrics\":{\"Instance\":{\"ApplicationRequests5xx\":60,\"ApplicationRequests4xx\":60},\"Environment\":{\"InstancesSevere\":60,\"InstancesDegraded\":60,\"ApplicationRequests5xx\":60,\"ApplicationRequests4xx\":60}},\"Rules\":{\"Environment\":{\"ELB\":{\"ELBRequests4xx\":{\"Enabled\":true}},\"Application\":{\"ApplicationRequests4xx\":{\"Enabled\":true}}}}}"

  # Both environments take the same settings. The options this list leaves out,
  # and why, are in the README.
  environment_settings = [
    { namespace = "aws:autoscaling:asg", name = "Availability Zones", value = "Any" },
    { namespace = "aws:autoscaling:asg", name = "Cooldown", value = "360" },
    { namespace = "aws:autoscaling:asg", name = "EnableCapacityRebalancing", value = "false" },
    { namespace = "aws:autoscaling:asg", name = "MaxSize", value = "1" },
    { namespace = "aws:autoscaling:asg", name = "MinSize", value = "1" },

    # true: the platform creates no security group of its own, so the group in
    # security_group.tf is the instance's whole inbound rule set.
    { namespace = "aws:autoscaling:launchconfiguration", name = "DisableDefaultEC2SecurityGroup", value = "true" },
    { namespace = "aws:autoscaling:launchconfiguration", name = "DisableIMDSv1", value = "true" },
    { namespace = "aws:autoscaling:launchconfiguration", name = "IamInstanceProfile", value = "aws-elasticbeanstalk-ec2-role" },
    { namespace = "aws:autoscaling:launchconfiguration", name = "InstanceType", value = "t4g.nano" },
    { namespace = "aws:autoscaling:launchconfiguration", name = "MonitoringInterval", value = "5 minute" },
    { namespace = "aws:autoscaling:launchconfiguration", name = "SecurityGroups", value = aws_security_group.origin.id },

    { namespace = "aws:autoscaling:updatepolicy:rollingupdate", name = "RollingUpdateEnabled", value = "false" },
    { namespace = "aws:autoscaling:updatepolicy:rollingupdate", name = "RollingUpdateType", value = "Time" },
    { namespace = "aws:autoscaling:updatepolicy:rollingupdate", name = "Timeout", value = "PT30M" },

    { namespace = "aws:ec2:instances", name = "EnableSpot", value = "false" },
    { namespace = "aws:ec2:instances", name = "InstanceTypes", value = "t4g.nano,t4g.micro" },
    { namespace = "aws:ec2:instances", name = "SpotAllocationStrategy", value = "capacity-optimized" },
    { namespace = "aws:ec2:instances", name = "SpotFleetOnDemandAboveBasePercentage", value = "0" },
    { namespace = "aws:ec2:instances", name = "SpotFleetOnDemandBase", value = "0" },
    { namespace = "aws:ec2:instances", name = "SupportedArchitectures", value = "arm64" },

    { namespace = "aws:ec2:vpc", name = "AssociatePublicIpAddress", value = "true" },
    { namespace = "aws:ec2:vpc", name = "ELBScheme", value = "public" },
    { namespace = "aws:ec2:vpc", name = "ELBSubnets", value = var.subnet_id },
    { namespace = "aws:ec2:vpc", name = "Subnets", value = var.subnet_id },
    { namespace = "aws:ec2:vpc", name = "VPCId", value = var.vpc_id },

    { namespace = "aws:elasticbeanstalk:application:environment", name = "LOG_LEVEL", value = "DEBUG" },
    { namespace = "aws:elasticbeanstalk:application:environment", name = "PORT", value = "8080" },

    { namespace = "aws:elasticbeanstalk:cloudwatch:logs", name = "DeleteOnTerminate", value = "false" },
    { namespace = "aws:elasticbeanstalk:cloudwatch:logs", name = "RetentionInDays", value = "90" },
    { namespace = "aws:elasticbeanstalk:cloudwatch:logs", name = "StreamLogs", value = "true" },
    { namespace = "aws:elasticbeanstalk:cloudwatch:logs:health", name = "DeleteOnTerminate", value = "false" },
    { namespace = "aws:elasticbeanstalk:cloudwatch:logs:health", name = "HealthStreamingEnabled", value = "false" },
    { namespace = "aws:elasticbeanstalk:cloudwatch:logs:health", name = "RetentionInDays", value = "7" },

    { namespace = "aws:elasticbeanstalk:command", name = "BatchSize", value = "100" },
    { namespace = "aws:elasticbeanstalk:command", name = "BatchSizeType", value = "Percentage" },
    { namespace = "aws:elasticbeanstalk:command", name = "DeploymentPolicy", value = "AllAtOnce" },
    { namespace = "aws:elasticbeanstalk:command", name = "IgnoreHealthCheck", value = "false" },
    { namespace = "aws:elasticbeanstalk:command", name = "Timeout", value = "600" },

    { namespace = "aws:elasticbeanstalk:environment", name = "EnvironmentType", value = "SingleInstance" },
    { namespace = "aws:elasticbeanstalk:environment", name = "ServiceRole", value = local.service_role_arn },
    { namespace = "aws:elasticbeanstalk:environment:proxy", name = "ProxyServer", value = "nginx" },

    { namespace = "aws:elasticbeanstalk:healthreporting:system", name = "ConfigDocument", value = local.health_config_document },
    { namespace = "aws:elasticbeanstalk:healthreporting:system", name = "EnhancedHealthAuthEnabled", value = "true" },
    { namespace = "aws:elasticbeanstalk:healthreporting:system", name = "HealthCheckSuccessThreshold", value = "Ok" },
    { namespace = "aws:elasticbeanstalk:healthreporting:system", name = "SystemType", value = "enhanced" },
    { namespace = "aws:elasticbeanstalk:hostmanager", name = "LogPublicationControl", value = "false" },

    { namespace = "aws:elasticbeanstalk:managedactions", name = "ManagedActionsEnabled", value = "false" },
    { namespace = "aws:elasticbeanstalk:managedactions", name = "PreferredStartTime", value = "SUN:13:41" },
    { namespace = "aws:elasticbeanstalk:managedactions", name = "ServiceRoleForManagedUpdates", value = local.service_role_arn },
    { namespace = "aws:elasticbeanstalk:managedactions:platformupdate", name = "InstanceRefreshEnabled", value = "false" },
    { namespace = "aws:elasticbeanstalk:managedactions:platformupdate", name = "UpdateLevel", value = "minor" },

    { namespace = "aws:elasticbeanstalk:monitoring", name = "Automatically Terminate Unhealthy Instances", value = "true" },
    { namespace = "aws:elasticbeanstalk:sns:topics", name = "Notification Endpoint", value = var.notification_endpoint },
    { namespace = "aws:elasticbeanstalk:sns:topics", name = "Notification Protocol", value = "email" },
    { namespace = "aws:elasticbeanstalk:xray", name = "XRayEnabled", value = "false" },
    { namespace = "aws:rds:dbinstance", name = "HasCoupledDatabase", value = "false" },
  ]
}

resource "aws_elastic_beanstalk_environment" "hosted" {
  for_each = var.environments

  application  = var.application_name
  name         = each.value.name
  description  = each.value.description
  tier         = "WebServer"
  platform_arn = var.platform_arn

  dynamic "setting" {
    for_each = local.environment_settings
    content {
      namespace = setting.value.namespace
      name      = setting.value.name
      value     = setting.value.value
    }
  }

  lifecycle {
    prevent_destroy = true
    # The deploy workflow sets the application version; an apply here must not
    # roll it back.
    ignore_changes = [version_label]
  }
}
