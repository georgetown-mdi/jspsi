import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  CERTIFICATE_BUCKET_PREFIX,
  CERTIFICATE_KEY,
  EXIT_AGREES,
  EXIT_DRIFTED,
  EXIT_UNCHECKED,
  certificateExpiry,
  certificateVerdict,
  checkOriginDrift,
  ingressOfGroup,
  parsePublishedRanges,
  rangeVerdict,
  recordOrigin,
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

describe("reading a published range list", () => {
  it("takes one CIDR per line and ignores blank lines", () => {
    expect(parsePublishedRanges("198.51.100.0/24\n\n2001:DB8::/32\n")).toEqual([
      "198.51.100.0/24",
      "2001:db8::/32",
    ]);
  });

  it("refuses an answer that is not a range list", () => {
    expect(() => parsePublishedRanges("<html>not this</html>")).toThrow(
      /which is no CIDR/,
    );
    expect(() => parsePublishedRanges("\n \n")).toThrow(/empty/);
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
  it("names a published range no rule admits and an admitted range that is not published", () => {
    expect(
      rangeVerdict({
        published: ["198.51.100.0/24", "203.0.113.0/24"],
        admitted: ["198.51.100.0/24", "192.0.2.0/24"],
      }),
    ).toEqual({ missing: ["203.0.113.0/24"], unpublished: ["192.0.2.0/24"] });
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
    expect(lines.join("\n")).toContain(
      "against the list Cloudflare publishes; it admits 2 range(s)",
    );
  });

  it("fails when the certificate is inside the margin", async () => {
    const { lines, exitCode } = await runCheck({
      now: new Date("2041-09-01T00:00:00Z"),
    });
    expect(exitCode).toBe(EXIT_DRIFTED);
    expect(lines.join("\n")).toContain("inside the 30-day margin");
  });

  it("fails when the deployed certificate is not the recorded one", async () => {
    const record = recordFixture();
    record.origin_certificate.not_after = "2030-01-01";
    const { lines, exitCode } = await runCheck({ record });
    expect(exitCode).toBe(EXIT_DRIFTED);
    expect(lines.join("\n")).toContain("records 2030-01-01");
  });

  it("falls back to the recorded expiry when the account is unreadable", async () => {
    const { lines, exitCode } = await runCheck({
      effects: {
        readOriginCertificate: async () => {
          throw new Error("no credentials");
        },
      },
    });
    expect(lines.join("\n")).toContain(
      "compared the expiry recorded-origin.json records, the account being unreadable (no credentials)",
    );
    expect(lines.join("\n")).toContain(`it expires ${CERTIFICATE_EXPIRY}`);
    expect(exitCode).toBe(EXIT_AGREES);
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

  it("fails when the recorded snapshot differs from the published list", async () => {
    const record = recordFixture();
    record.cloudflare_ranges.ipv4 = ["203.0.113.0/24"];
    const { lines, exitCode } = await runCheck({ record });
    expect(exitCode).toBe(EXIT_DRIFTED);
    expect(lines.join("\n")).toContain(
      "fetched 2026-09-17, differs from the published list",
    );
  });

  it("compares against the recorded snapshot when the published list is unreadable", async () => {
    const { lines, exitCode } = await runCheck({
      effects: {
        fetchText: async () => {
          throw new Error("no route to host");
        },
      },
    });
    expect(exitCode).toBe(EXIT_AGREES);
    expect(lines.join("\n")).toContain(
      "the snapshot recorded-origin.json records, fetched 2026-09-17, the published list being unreadable (no route to host)",
    );
  });

  it("reports nothing compared when neither the published list nor a snapshot is readable", async () => {
    const record = recordFixture();
    record.cloudflare_ranges.fetched = null;
    const { lines, exitCode } = await runCheck({
      record,
      effects: {
        fetchText: async () => {
          throw new Error("no route to host");
        },
      },
    });
    expect(exitCode).toBe(EXIT_UNCHECKED);
    expect(lines.join("\n")).toContain(
      "records no snapshot to compare against",
    );
  });

  it("reports nothing compared when the security group is unreadable", async () => {
    const { lines, exitCode } = await runCheck({
      effects: {
        describeSecurityGroup: async () => {
          throw new Error("not authorized");
        },
      },
    });
    expect(exitCode).toBe(EXIT_UNCHECKED);
    expect(lines.join("\n")).toContain(
      "security group sg-shared is unreadable (not authorized)",
    );
  });

  it("asks for a snapshot when the record holds none", async () => {
    const record = recordFixture();
    record.cloudflare_ranges.fetched = null;
    record.cloudflare_ranges.ipv4 = [];
    record.cloudflare_ranges.ipv6 = [];
    const { lines, exitCode } = await runCheck({ record });
    expect(exitCode).toBe(EXIT_UNCHECKED);
    expect(lines.join("\n")).toContain("--record");
  });
});

describe("recording the origin values", () => {
  it("writes the published ranges under the run's date and the deployed expiry", async () => {
    const { record } = await recordOrigin({
      record: recordFixture(),
      configurations: CONFIGURATIONS,
      effects: effectsFixture(),
      now: new Date("2026-09-21T00:00:00Z"),
    });
    expect(record.cloudflare_ranges).toMatchObject({
      fetched: "2026-09-21",
      ipv4: PUBLISHED.ipv4,
      ipv6: PUBLISHED.ipv6,
    });
    expect(record.origin_certificate).toMatchObject({
      not_after: CERTIFICATE_EXPIRY,
      recorded: "2026-09-21",
    });
  });

  it("keeps the recorded expiry when the account is unreadable", async () => {
    const { record, lines } = await recordOrigin({
      record: recordFixture(),
      configurations: CONFIGURATIONS,
      effects: effectsFixture({
        readOriginCertificate: async () => {
          throw new Error("no credentials");
        },
      }),
      now: new Date("2026-09-21T00:00:00Z"),
    });
    expect(record.origin_certificate.recorded).toBe("2026-09-17");
    expect(lines.join("\n")).toContain("Kept the recorded certificate expiry");
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
