import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  CERTIFICATE_BUCKET_PREFIX,
  CERTIFICATE_KEY,
  EXIT_AGREES,
  EXIT_DRIFTED,
  EXIT_UNCHECKED,
  aws,
  awsEffects,
  canonicalCidr,
  certificateExpiry,
  certificateVerdict,
  checkOriginDrift,
  ingressOfGroup,
  parsePublishedRanges,
  rangeVerdict,
  regionOf,
  sharedSecurityGroupId,
} from "../apps/web/deploy/aws_eb_saved_configurations/check-origin-drift.mjs";

const REPOSITORY = join(dirname(fileURLToPath(import.meta.url)), "..");
const SAVED_CONFIGURATIONS = join(
  REPOSITORY,
  "apps",
  "web",
  "deploy",
  "aws_eb_saved_configurations",
);

function repositoryFile(...parts) {
  return readFileSync(join(REPOSITORY, ...parts), "utf8");
}

function savedConfiguration(file) {
  return JSON.parse(readFileSync(join(SAVED_CONFIGURATIONS, file), "utf8"));
}

// Self-signed, expiring 2041-09-16, generated for this test alone: nothing
// verifies it, only its expiry is read.
const CERTIFICATE_PEM = `-----BEGIN CERTIFICATE-----
MIIDHTCCAgWgAwIBAgIUBsdMaVJAGOWC0SXWkXhqlBgElXAwDQYJKoZIhvcNAQEL
BQAwHjEcMBoGA1UEAwwTcHNpbGluayB0ZXN0IG9yaWdpbjAeFw0yNjA5MjExMjM4
MTNaFw00MTA5MTYxMjM4MTNaMB4xHDAaBgNVBAMME3BzaWxpbmsgdGVzdCBvcmln
aW4wggEiMA0GCSqGSIb3DQEBAQUAA4IBDwAwggEKAoIBAQC6wGP3jEeh6Ahef10o
6PyMxtGDfuka8H3JbvZEir3r4HcfJwWD54pgeIyHnU9lNBbQ/SmyhiLyGAg381tj
qIjrGzq9Il5ukxAjBfaYnjfbIzBXR0DkY5kcxzrriv+2UC65RvzbxnMkFlFZswM1
AUhPlj8Fj/lMItOc2DY83vJ/B9SEYkRL9yMIItS4zURWel79YvG1SAIIkRrV93XB
uC93vGmIMgRh/vNpSl8bMD0qWozi0A0PzASE/3I+SOwa4c9pD3wC2XGQ4nn+dMcm
y6MMrpIrf+z2xnZB/KXCP0fc7pUP4DBhBP8MatN0/18HEgqD36agwTblrG4gDhZr
B0dBAgMBAAGjUzBRMB0GA1UdDgQWBBRnh3KvUPskBNsIsy71vcGW5siRZDAfBgNV
HSMEGDAWgBRnh3KvUPskBNsIsy71vcGW5siRZDAPBgNVHRMBAf8EBTADAQH/MA0G
CSqGSIb3DQEBCwUAA4IBAQAcxNapRbcwCHUH+XO1BOFbuUz6ixUfnzGFCDogupN3
rNdwI9Bu+Uo58rlqgMojZydXiVKm2ufwwUkx8ZQRl37DjKzifnq2tPXutTl16Ay5
lhj84KA5eIjqloWVB4ZFglCaD5JqgT0FExJzYNtRwp8mrVvCd8VJY6ybWuUeT2vK
wY4a2l3rGyGEllubyFP5NEA1ueo0iKRiTT/Sf3cwHOPy69hkc5v9s9fx/iQ3JbYY
Kl5ga/XwEn3YvvAK+vENMie3xz5w0FMBV9d5zPxVAjVBrlBO1R+K1+hSHF26E7fB
RQ3/NEdd6Kd5EW43VkYml/IwtQaClvCVyti9OR2B82rw
-----END CERTIFICATE-----
`;

const CERTIFICATE_EXPIRY = "2041-09-16";

const PUBLISHED = { ipv4: ["198.51.100.0/24"], ipv6: ["2001:db8::/32"] };

function configurationFixture(groups) {
  return {
    ConfigurationSettings: [
      {
        OptionSettings: [
          {
            Namespace: "aws:elasticbeanstalk:sns:topics",
            OptionName: "Notification Topic ARN",
            Value: "arn:aws:sns:us-west-2:<account-id>:Notifications",
          },
          {
            Namespace: "aws:autoscaling:launchconfiguration",
            OptionName: "SecurityGroups",
            Value: groups,
          },
        ],
      },
    ],
  };
}

const CONFIGURATIONS = [
  configurationFixture("sg-shared,sg-production"),
  configurationFixture("sg-shared,sg-staging"),
];

function recordFixture(overrides = {}) {
  return {
    origin_certificate: {
      not_after: CERTIFICATE_EXPIRY,
      recorded: "2026-09-17",
      source: "a measurement pass",
    },
    cloudflare_ranges: {
      fetched: "2026-09-17",
      source: {
        ipv4: "https://example.invalid/ips-v4",
        ipv6: "https://example.invalid/ips-v6",
      },
      ipv4: PUBLISHED.ipv4,
      ipv6: PUBLISHED.ipv6,
    },
    ...overrides,
  };
}

function groupFixture(permissions) {
  return { GroupId: "sg-shared", IpPermissions: permissions };
}

function httpsPermission({ ipv4 = [], ipv6 = [] }) {
  return {
    IpProtocol: "tcp",
    FromPort: 443,
    ToPort: 443,
    IpRanges: ipv4.map((cidr) => ({ CidrIp: cidr })),
    Ipv6Ranges: ipv6.map((cidr) => ({ CidrIpv6: cidr })),
  };
}

function effectsFixture(overrides = {}) {
  return {
    fetchText: async (url) =>
      `${(url.endsWith("ips-v6") ? PUBLISHED.ipv6 : PUBLISHED.ipv4).join("\n")}\n`,
    readOriginCertificate: async () => CERTIFICATE_PEM,
    describeSecurityGroup: async () =>
      groupFixture([httpsPermission(PUBLISHED)]),
    ...overrides,
  };
}

function runCheck(overrides = {}) {
  return checkOriginDrift({
    record: recordFixture(),
    configurations: CONFIGURATIONS,
    now: new Date("2026-09-21T00:00:00Z"),
    ...overrides,
    effects: effectsFixture(overrides.effects),
  });
}

const PASTE_HEADING = "Paste this into recorded-origin.json and commit it:";

function pastedRecord(lines) {
  const heading = lines.indexOf(PASTE_HEADING);
  return heading < 0 ? undefined : JSON.parse(lines[heading + 1]);
}

describe("reading a published range list", () => {
  it("takes one CIDR per line and ignores blank lines", () => {
    expect(parsePublishedRanges("198.51.100.0/24\n\n2001:DB8::/32\n")).toEqual([
      "198.51.100.0/24",
      "2001:DB8::/32",
    ]);
  });

  it("refuses an answer that is not a range list", () => {
    expect(() => parsePublishedRanges("<html>not this</html>")).toThrow(
      /which is no CIDR/,
    );
    expect(() => parsePublishedRanges("\n \n")).toThrow(/empty/);
  });
});

describe("reading a range as an address", () => {
  it("reduces two spellings of one range to one", () => {
    expect(canonicalCidr("2001:DB8::/32")).toBe(
      canonicalCidr("2001:0db8:0000:0000:0000:0000:0000:0000/32"),
    );
    expect(canonicalCidr("::ffff:192.0.2.0/120")).toBe(
      canonicalCidr("0:0:0:0:0:FFFF:C000:0200/120"),
    );
    expect(canonicalCidr("198.051.100.000/24")).toBe(
      canonicalCidr("198.51.100.0/24"),
    );
  });

  it("keeps ranges that differ apart", () => {
    expect(canonicalCidr("2001:db8::/32")).not.toBe(
      canonicalCidr("2001:db9::/32"),
    );
    expect(canonicalCidr("198.51.100.0/24")).not.toBe(
      canonicalCidr("198.51.100.0/25"),
    );
  });

  it("reads nothing out of a value that is no CIDR", () => {
    for (const value of [
      "198.51.100.0",
      "198.51.100.0/",
      "198.51.100.0/33",
      "198.51.100.256/24",
      "198.51.100/24",
      "2001:db8::/129",
      "2001:db8:::1/32",
      "2001:zz8::/32",
      "2001:db8:1:2:3:4:5:6:7/32",
      "192.0.2.0:1/24",
      "",
    ])
      expect(canonicalCidr(value)).toBeUndefined();
  });
});

describe("reading a security group", () => {
  it("collects the CIDRs admitted on port 443", () => {
    const { admitted, unexpected } = ingressOfGroup(
      groupFixture([httpsPermission(PUBLISHED)]),
    );
    expect(admitted).toEqual(["198.51.100.0/24", "2001:db8::/32"]);
    expect(unexpected).toEqual([]);
  });

  it("reports a rule admitting anything other than port 443", () => {
    const { unexpected } = ingressOfGroup(
      groupFixture([
        {
          IpProtocol: "tcp",
          FromPort: 22,
          ToPort: 22,
          IpRanges: [{ CidrIp: "0.0.0.0/0" }],
        },
        {
          IpProtocol: "-1",
          IpRanges: [{ CidrIp: "0.0.0.0/0" }],
        },
      ]),
    );
    expect(unexpected).toEqual([
      "tcp port 22 from 0.0.0.0/0",
      "every protocol every port from 0.0.0.0/0",
    ]);
  });

  it("reports a port-443 source that is not a range", () => {
    const { admitted, unexpected } = ingressOfGroup(
      groupFixture([
        {
          IpProtocol: "tcp",
          FromPort: 443,
          ToPort: 443,
          UserIdGroupPairs: [{ GroupId: "sg-elsewhere" }],
          PrefixListIds: [{ PrefixListId: "pl-elsewhere" }],
        },
      ]),
    );
    expect(admitted).toEqual([]);
    expect(unexpected).toEqual([
      "tcp port 443 from security group sg-elsewhere",
      "tcp port 443 from prefix list pl-elsewhere",
    ]);
  });
});

describe("comparing ranges against rules", () => {
  it("names an expected range no rule admits and an admitted range that is not expected", () => {
    expect(
      rangeVerdict({
        expected: ["198.51.100.0/24", "203.0.113.0/24"],
        admitted: ["198.51.100.0/24", "192.0.2.0/24"],
      }),
    ).toEqual({ unadmitted: ["203.0.113.0/24"], unstated: ["192.0.2.0/24"] });
  });
});

describe("reading a certificate", () => {
  it("takes the expiry the certificate states", () => {
    expect(certificateExpiry(CERTIFICATE_PEM).toISOString()).toMatch(
      /^2041-09-16/,
    );
  });

  it("counts a certificate inside the margin as expiring", () => {
    const notAfter = new Date("2026-10-01T00:00:00Z");
    const now = new Date("2026-09-21T00:00:00Z");
    expect(certificateVerdict({ notAfter, now, marginDays: 30 })).toEqual({
      daysRemaining: 10,
      withinMargin: true,
    });
    expect(certificateVerdict({ notAfter, now, marginDays: 7 })).toEqual({
      daysRemaining: 10,
      withinMargin: false,
    });
  });
});

describe("reading the committed configuration files", () => {
  it("takes the group both environments attach as the shared one", () => {
    expect(sharedSecurityGroupId(CONFIGURATIONS)).toBe("sg-shared");
  });

  it("refuses configuration files with no group in common", () => {
    expect(() =>
      sharedSecurityGroupId([
        configurationFixture("sg-production"),
        configurationFixture("sg-staging"),
      ]),
    ).toThrow(/not one/);
  });

  it("resolves one shared group and one region in the committed files", () => {
    const committed = ["production.json", "staging.json"].map(
      savedConfiguration,
    );
    expect(sharedSecurityGroupId(committed)).toMatch(/^sg-[0-9a-f]+$/);
    expect(regionOf(committed)).toMatch(/^[a-z]{2}-[a-z]+-\d$/);
  });

  it("refuses configuration files stating more than one region", () => {
    expect(() =>
      regionOf([
        configurationFixture("sg-shared"),
        {
          ConfigurationSettings: [
            {
              OptionSettings: [
                {
                  Namespace: "aws:elasticbeanstalk:sns:topics",
                  OptionName: "Notification Topic ARN",
                  Value: "arn:aws:sns:eu-west-1:<account-id>:Notifications",
                },
              ],
            },
          ],
        },
      ]),
    ).toThrow(/2 regions/);
  });
});

describe("the drift check", () => {
  it("agrees when the certificate, the rules and the record all match", async () => {
    const { lines, exitCode } = await runCheck();
    expect(exitCode).toBe(EXIT_AGREES);
    expect(lines.join("\n")).toContain(
      "compared the certificate the deployment bucket holds",
    );
    expect(lines.join("\n")).toContain("it admits 2 range(s) on port 443");
    expect(pastedRecord(lines)).toBeUndefined();
    expect(lines.at(-1)).toBe(
      "Both comparisons ran and agreed with the recorded values.",
    );
  });

  it("fails when the certificate is inside the margin", async () => {
    const { lines, exitCode } = await runCheck({
      now: new Date("2041-09-01T00:00:00Z"),
    });
    expect(exitCode).toBe(EXIT_DRIFTED);
    expect(lines.join("\n")).toContain("it expires 2041-09-16, 15 day(s) away");
    expect(lines.join("\n")).toContain("inside the 30-day margin");
    expect(lines.at(-1)).toBe("A comparison found a difference.");
    expect(pastedRecord(lines)).toBeUndefined();
  });

  it("says an expired certificate expired rather than counting down past zero", async () => {
    const { lines, exitCode } = await runCheck({
      now: new Date("2041-09-30T00:00:00Z"),
    });
    expect(exitCode).toBe(EXIT_DRIFTED);
    expect(lines.join("\n")).toContain("it expired 2041-09-16, 14 day(s) ago");
    expect(lines.join("\n")).toContain("it has expired. Issue a replacement");
    expect(lines.join("\n")).not.toMatch(/-\d+ day/);
  });

  it("fails when the deployed certificate is not the recorded one", async () => {
    const record = recordFixture();
    record.origin_certificate.not_after = "2030-01-01";
    const { lines, exitCode } = await runCheck({ record });
    expect(exitCode).toBe(EXIT_DRIFTED);
    expect(lines.join("\n")).toContain(
      "recorded-origin.json records 2030-01-01, not the expiry the deployment bucket holds",
    );
    expect(pastedRecord(lines)).toEqual({
      origin_certificate: {
        not_after: CERTIFICATE_EXPIRY,
        recorded: "2026-09-21",
        source: `read from the deployment bucket's ${CERTIFICATE_KEY}`,
      },
      cloudflare_ranges: {
        fetched: "2026-09-21",
        source: recordFixture().cloudflare_ranges.source,
        ipv4: PUBLISHED.ipv4,
        ipv6: PUBLISHED.ipv6,
      },
    });
  });

  it("reports no recorded expiry when the record states none readable", async () => {
    const noCertificate = recordFixture();
    delete noCertificate.origin_certificate;
    const notADate = recordFixture();
    notADate.origin_certificate.not_after = "not-a-date";
    for (const record of [noCertificate, notADate]) {
      const { lines, exitCode } = await runCheck({ record });
      expect(exitCode).toBe(EXIT_DRIFTED);
      expect(lines.join("\n")).toContain(
        "origin certificate: recorded-origin.json records no expiry.",
      );
      expect(pastedRecord(lines).origin_certificate.not_after).toBe(
        CERTIFICATE_EXPIRY,
      );
    }
  });

  it("compares nothing when the deployed certificate is unreadable", async () => {
    const { lines, exitCode } = await runCheck({
      effects: {
        readOriginCertificate: async () => {
          throw new Error("no credentials");
        },
      },
    });
    expect(exitCode).toBe(EXIT_UNCHECKED);
    expect(lines.join("\n")).toContain(
      "the certificate the deployment bucket holds could not be read (no credentials), so nothing was compared",
    );
    expect(lines.join("\n")).not.toContain("expires");
    expect(lines.join("\n")).not.toContain("records 2041");
    expect(pastedRecord(lines)).toBeUndefined();
    expect(lines.at(-1)).toBe(
      "A comparison could not run, so this run does not state that the values agree.",
    );
  });

  it("compares nothing when the published list is unreadable", async () => {
    const { lines, exitCode } = await runCheck({
      effects: {
        fetchText: async () => {
          throw new Error("no route to host");
        },
      },
    });
    expect(exitCode).toBe(EXIT_UNCHECKED);
    expect(lines.join("\n")).toContain(
      "the published ranges could not be read (no route to host), so nothing was compared",
    );
    expect(lines.join("\n")).not.toContain("port 443");
    expect(pastedRecord(lines)).toBeUndefined();
  });

  it("compares nothing when the security group is unreadable", async () => {
    const { lines, exitCode } = await runCheck({
      effects: {
        describeSecurityGroup: async () => {
          throw new Error("not authorized");
        },
      },
    });
    expect(exitCode).toBe(EXIT_UNCHECKED);
    expect(lines.join("\n")).toContain(
      "security group sg-shared could not be read (not authorized), so no rule was compared",
    );
    expect(lines.join("\n")).not.toContain("is admitted and not recorded");
    expect(pastedRecord(lines)).toBeUndefined();
  });

  it("fails when a published range is not admitted", async () => {
    const { lines, exitCode } = await runCheck({
      effects: {
        describeSecurityGroup: async () =>
          groupFixture([httpsPermission({ ipv4: PUBLISHED.ipv4 })]),
      },
    });
    expect(exitCode).toBe(EXIT_DRIFTED);
    expect(lines.join("\n")).toContain(
      "2001:db8::/32 is published and not admitted",
    );
    expect(lines.join("\n")).toContain(
      "2001:db8::/32 is recorded and not admitted",
    );
    expect(pastedRecord(lines)).toBeUndefined();
  });

  it("fails when an admitted range is not published", async () => {
    const { lines, exitCode } = await runCheck({
      effects: {
        describeSecurityGroup: async () =>
          groupFixture([
            httpsPermission({
              ipv4: [...PUBLISHED.ipv4, "192.0.2.0/24"],
              ipv6: PUBLISHED.ipv6,
            }),
          ]),
      },
    });
    expect(exitCode).toBe(EXIT_DRIFTED);
    expect(lines.join("\n")).toContain(
      "192.0.2.0/24 is admitted and not published",
    );
  });

  it("fails when the recorded snapshot is not the published list", async () => {
    const record = recordFixture();
    record.cloudflare_ranges.ipv4 = ["203.0.113.0/24"];
    const { lines, exitCode } = await runCheck({ record });
    expect(exitCode).toBe(EXIT_DRIFTED);
    expect(lines.join("\n")).toContain(
      "203.0.113.0/24 is recorded and not admitted",
    );
    expect(lines.join("\n")).toContain(
      "the snapshot recorded-origin.json records, fetched 2026-09-17, is not the list Cloudflare publishes now",
    );
    expect(pastedRecord(lines).cloudflare_ranges).toEqual({
      fetched: "2026-09-21",
      source: record.cloudflare_ranges.source,
      ipv4: PUBLISHED.ipv4,
      ipv6: PUBLISHED.ipv6,
    });
  });

  it("agrees when a rule spells an admitted range differently", async () => {
    const { exitCode } = await runCheck({
      effects: {
        describeSecurityGroup: async () =>
          groupFixture([
            httpsPermission({
              ipv4: ["198.051.100.000/24"],
              ipv6: ["2001:0DB8:0000:0000:0000:0000:0000:0000/32"],
            }),
          ]),
      },
    });
    expect(exitCode).toBe(EXIT_AGREES);
  });

  it("reports a port-443 source that is no CIDR", async () => {
    const { lines, exitCode } = await runCheck({
      effects: {
        describeSecurityGroup: async () =>
          groupFixture([
            httpsPermission({
              ...PUBLISHED,
              ipv4: [...PUBLISHED.ipv4, "198.51.100/24"],
            }),
          ]),
      },
    });
    expect(exitCode).toBe(EXIT_UNCHECKED);
    expect(lines.join("\n")).toContain(
      "the group admits 198.51.100/24, which is no CIDR this check can compare",
    );
  });

  it("reports a recorded range that is no CIDR", async () => {
    const record = recordFixture();
    record.cloudflare_ranges.ipv4 = ["198.51.100/24"];
    const { lines, exitCode } = await runCheck({ record });
    expect(exitCode).toBe(EXIT_DRIFTED);
    expect(lines.join("\n")).toContain(
      "recorded-origin.json records 198.51.100/24, which is no CIDR",
    );
    expect(pastedRecord(lines).cloudflare_ranges.ipv4).toEqual(PUBLISHED.ipv4);
  });

  it("prints the record to paste when none has been taken", async () => {
    const record = recordFixture();
    record.cloudflare_ranges.fetched = null;
    record.cloudflare_ranges.ipv4 = [];
    record.cloudflare_ranges.ipv6 = [];
    const { lines, exitCode } = await runCheck({ record });
    expect(exitCode).toBe(EXIT_DRIFTED);
    expect(lines.join("\n")).toContain(
      "recorded-origin.json records no range snapshot",
    );
    expect(pastedRecord(lines).cloudflare_ranges.fetched).toBe("2026-09-21");
  });
});

describe("the aws boundary", () => {
  const inheritedPath = process.env.PATH;
  let stubDirectory;

  beforeEach(() => {
    stubDirectory = mkdtempSync(join(tmpdir(), "alcove-aws-stub-"));
  });

  afterEach(() => {
    process.env.PATH = inheritedPath;
    rmSync(stubDirectory, { recursive: true, force: true });
  });

  function stubAws(script) {
    const executable = join(stubDirectory, "aws");
    writeFileSync(executable, script, "utf8");
    chmodSync(executable, 0o755);
    process.env.PATH = `${stubDirectory}:${inheritedPath}`;
  }

  it("states the first line of a failing call's standard error", () => {
    stubAws(
      "#!/bin/sh\necho 'An error occurred (AccessDenied)' >&2\necho 'call the administrator' >&2\nexit 254\n",
    );
    expect(() => aws(["sts", "get-caller-identity"])).toThrow(
      "An error occurred (AccessDenied)",
    );
  });

  it("states what failed when a failing call writes no standard error", () => {
    stubAws("#!/bin/sh\nexit 1\n");
    expect(() => aws(["s3", "cp", "-"])).toThrow(/Command failed/);
  });

  it("states the bound when the call does not answer within it", () => {
    stubAws("#!/bin/sh\nsleep 2\n");
    expect(() =>
      aws(["ec2", "describe-security-groups"], { timeoutMs: 250 }),
    ).toThrow("the aws CLI did not answer within 0.25 seconds");
  });

  it("states that the CLI is not installed when the PATH holds none", () => {
    process.env.PATH = stubDirectory;
    expect(() => aws(["sts", "get-caller-identity"])).toThrow(
      "the aws CLI is not installed",
    );
  });

  it("reads the certificate from the bucket the account and region name", async () => {
    stubAws(
      '#!/bin/sh\ncase "$1" in\n  sts) echo 123456789012 ;;\n  s3) echo "$3" ;;\nesac\n',
    );
    expect(
      await awsEffects.readOriginCertificate({ region: "us-west-2" }),
    ).toBe(
      `s3://${CERTIFICATE_BUCKET_PREFIX}-us-west-2-123456789012/${CERTIFICATE_KEY}\n`,
    );
  });

  it("takes the described group, and refuses an answer describing none", async () => {
    stubAws(
      '#!/bin/sh\necho \'{"SecurityGroups":[{"GroupId":"sg-shared"}]}\'\n',
    );
    expect(
      await awsEffects.describeSecurityGroup({
        region: "us-west-2",
        groupId: "sg-shared",
      }),
    ).toEqual({ GroupId: "sg-shared" });
    stubAws("#!/bin/sh\necho '{\"SecurityGroups\":[]}'\n");
    await expect(
      awsEffects.describeSecurityGroup({
        region: "us-west-2",
        groupId: "sg-shared",
      }),
    ).rejects.toThrow("the account describes no such group");
  });

  it("names the DNS failure cause when a URL is unreachable", async () => {
    await expect(
      awsEffects.fetchText("https://no-such-host.invalid/"),
    ).rejects.toThrow(/is unreachable.*ENOTFOUND/);
  });
});

describe("the recorded values", () => {
  it("reads the certificate object the prebuild hook installs", () => {
    const hook = repositoryFile(
      "apps",
      "web",
      "deploy",
      "aws_eb",
      ".platform",
      "hooks",
      "prebuild",
      "download_certificates.sh",
    );
    expect(hook).toContain(
      `BUCKET_NAME="${CERTIFICATE_BUCKET_PREFIX}-\${AWS_REGION}-\${AWS_ACCOUNT_ID}"`,
    );
    expect(hook).toContain(`s3://\${BUCKET_NAME}/${CERTIFICATE_KEY}`);
  });

  it("states the expiry the deployment document records", () => {
    const row = repositoryFile("docs", "DEPLOYMENT.md")
      .split("\n")
      .find((line) => line.startsWith("| Origin certificate"));
    const recorded = JSON.parse(
      readFileSync(join(SAVED_CONFIGURATIONS, "recorded-origin.json"), "utf8"),
    );
    expect(row).toContain(`to ${recorded.origin_certificate.not_after}`);
  });

  it("states the source of each published range list", () => {
    const recorded = JSON.parse(
      readFileSync(join(SAVED_CONFIGURATIONS, "recorded-origin.json"), "utf8"),
    );
    expect(recorded.cloudflare_ranges.source).toEqual({
      ipv4: "https://www.cloudflare.com/ips-v4",
      ipv6: "https://www.cloudflare.com/ips-v6",
    });
  });
});
