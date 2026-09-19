import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

import { describe, expect, it } from "vitest";

import { redactConfigurationSettings } from "../apps/web/deploy/aws_eb_saved_configurations/redact.mjs";

const REDACT = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "apps",
  "web",
  "deploy",
  "aws_eb_saved_configurations",
  "redact.mjs",
);

const ACCOUNT_ID = "123456789012";

function exportFixture() {
  return {
    ConfigurationSettings: [
      {
        SolutionStackName: "64bit Amazon Linux 2023 v6.11.7 running Node.js 24",
        ApplicationName: "EXAMPLEAPP",
        EnvironmentName: "EXAMPLEAPP-staging",
        DeploymentStatus: "deployed",
        DateCreated: "2025-08-06T22:45:59+00:00",
        DateUpdated: "2026-09-17T19:16:30+00:00",
        OptionSettings: [
          {
            Namespace: "aws:elasticbeanstalk:sns:topics",
            OptionName: "Notification Topic ARN",
            Value: `arn:aws:sns:us-west-2:${ACCOUNT_ID}:ElasticBeanstalkNotifications-Environment-EXAMPLEAPP-staging`,
          },
          {
            Namespace: "aws:elasticbeanstalk:sns:topics",
            OptionName: "Notification Endpoint",
            Value: "operator@example.invalid",
          },
          {
            Namespace: "aws:autoscaling:launchconfiguration",
            OptionName: "SecurityGroups",
            Value: "sg-0123456789abcdef0",
          },
          {
            ResourceName: "AWSEBEC2LaunchTemplate",
            Namespace: "aws:autoscaling:launchconfiguration",
            OptionName: "EC2KeyName",
            Value: "An Example Key Pair",
          },
          {
            Namespace: "aws:elasticbeanstalk:environment",
            OptionName: "ServiceRole",
            Value: `arn:aws:iam::${ACCOUNT_ID}:role/aws-elasticbeanstalk-service-role`,
          },
        ],
      },
    ],
  };
}

function stringsIn(value) {
  if (typeof value === "string") return [value];
  if (value === null || typeof value !== "object") return [];
  return Object.values(value).flatMap(stringsIn);
}

describe("the saved-configuration redaction", () => {
  it("replaces each identifier with its placeholder", () => {
    const settings =
      redactConfigurationSettings(exportFixture()).ConfigurationSettings[0];
    expect(settings.ApplicationName).toBe("<application-name>");
    expect(settings.EnvironmentName).toBe("<environment-name>");
    const valueOf = (optionName) =>
      settings.OptionSettings.find((option) => option.OptionName === optionName)
        .Value;
    expect(valueOf("Notification Endpoint")).toBe("<notification-endpoint>");
    expect(valueOf("EC2KeyName")).toBe("<ec2-key-name>");
    expect(valueOf("Notification Topic ARN")).toBe(
      "arn:aws:sns:us-west-2:<account-id>:ElasticBeanstalkNotifications-Environment-<environment-name>",
    );
    expect(valueOf("ServiceRole")).toBe(
      "arn:aws:iam::<account-id>:role/aws-elasticbeanstalk-service-role",
    );
  });

  it("leaves the account id in no string of the output", () => {
    const redacted = redactConfigurationSettings(exportFixture());
    for (const text of stringsIn(redacted))
      expect(text).not.toContain(ACCOUNT_ID);
  });

  it("keeps the values the file is reviewed for", () => {
    const settings =
      redactConfigurationSettings(exportFixture()).ConfigurationSettings[0];
    expect(settings.SolutionStackName).toBe(
      "64bit Amazon Linux 2023 v6.11.7 running Node.js 24",
    );
    expect(
      settings.OptionSettings.find(
        (option) => option.OptionName === "SecurityGroups",
      ).Value,
    ).toBe("sg-0123456789abcdef0");
  });

  it("drops the members that change on every export", () => {
    const settings =
      redactConfigurationSettings(exportFixture()).ConfigurationSettings[0];
    expect(Object.keys(settings)).not.toContain("DateCreated");
    expect(Object.keys(settings)).not.toContain("DateUpdated");
    expect(Object.keys(settings)).not.toContain("DeploymentStatus");
  });

  it("sorts the option settings by namespace then option name", () => {
    const settings =
      redactConfigurationSettings(exportFixture()).ConfigurationSettings[0];
    expect(
      settings.OptionSettings.map(
        (option) => `${option.Namespace}/${option.OptionName}`,
      ),
    ).toEqual([
      "aws:autoscaling:launchconfiguration/EC2KeyName",
      "aws:autoscaling:launchconfiguration/SecurityGroups",
      "aws:elasticbeanstalk:environment/ServiceRole",
      "aws:elasticbeanstalk:sns:topics/Notification Endpoint",
      "aws:elasticbeanstalk:sns:topics/Notification Topic ARN",
    ]);
  });

  it("keeps an EC2KeyName entry that states no key pair", () => {
    const document = exportFixture();
    const exported = document.ConfigurationSettings[0].OptionSettings.find(
      (option) => option.OptionName === "EC2KeyName",
    );
    delete exported.Value;
    const settings =
      redactConfigurationSettings(document).ConfigurationSettings[0];
    expect(
      settings.OptionSettings.find(
        (option) => option.OptionName === "EC2KeyName",
      ),
    ).toEqual({
      ResourceName: "AWSEBEC2LaunchTemplate",
      Namespace: "aws:autoscaling:launchconfiguration",
      OptionName: "EC2KeyName",
    });
    const run = spawnSync(process.execPath, [REDACT], {
      input: JSON.stringify(document),
      encoding: "utf8",
    });
    expect(run.status).toBe(0);
    expect(run.stderr).toBe("");
  });

  it("refuses an export missing a value it must redact", () => {
    const document = exportFixture();
    delete document.ConfigurationSettings[0].EnvironmentName;
    expect(() => redactConfigurationSettings(document)).toThrow(
      /EnvironmentName/,
    );
    const run = spawnSync(process.execPath, [REDACT], {
      input: JSON.stringify(document),
      encoding: "utf8",
    });
    expect(run.status).not.toBe(0);
    expect(run.stderr).toContain("EnvironmentName");
    expect(run.stdout).toBe("");
  });

  it("refuses an export missing the notification endpoint", () => {
    const document = exportFixture();
    const exported = document.ConfigurationSettings[0].OptionSettings.find(
      (option) => option.OptionName === "Notification Endpoint",
    );
    delete exported.Value;
    expect(() => redactConfigurationSettings(document)).toThrow(
      /Notification Endpoint/,
    );
  });
});
