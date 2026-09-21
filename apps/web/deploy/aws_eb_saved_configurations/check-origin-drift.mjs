// Reports drift in the two origin values nothing else in this repository
// notices: the origin certificate's expiry, and the port-443 ingress of the
// security group both environments attach against Cloudflare's published
// ranges. The recorded values are in recorded-origin.json beside this file;
// what the run needs and how often to run it are in README.md beside it.
//
// The account is read through the `aws` CLI, as the refresh procedure and the
// prebuild certificate hook are. Nothing here prints the account id or the
// deployment bucket; an AWS CLI error passed through can name either.

import { readFileSync, writeFileSync } from "node:fs";
import { X509Certificate } from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { isIP } from "node:net";

/** Every comparison ran and agreed. */
export const EXIT_AGREES = 0;

/** A comparison ran and found a difference. */
export const EXIT_DRIFTED = 1;

/** A comparison could not run: the account, the published list, or a record. */
export const EXIT_UNCHECKED = 2;

/** How close to expiry the certificate may come before a run fails. */
export const DEFAULT_MARGIN_DAYS = 30;

const RECORD_FILE = "recorded-origin.json";

const CONFIGURATION_FILES = ["production.json", "staging.json"];

/**
 * The deployment bucket holding the origin certificate, named as the prebuild
 * hook names it
 * (apps/web/deploy/aws_eb/.platform/hooks/prebuild/download_certificates.sh):
 * reading the object that hook installs is what makes this the expiry of the
 * certificate the origin serves.
 */
export const CERTIFICATE_BUCKET_PREFIX = "elasticbeanstalk";

/** The key of the certificate object in that bucket. */
export const CERTIFICATE_KEY = "cert/public.crt";

const HTTPS_PORT = 443;

const SECURITY_GROUPS_OPTION = {
  namespace: "aws:autoscaling:launchconfiguration",
  optionName: "SecurityGroups",
};

const ARN_REGION = /arn:[^\s:]*:[^\s:]*:([^\s:]+):/g;

/** A published list longer than this is an answer that is not a range list. */
const MAXIMUM_RANGE_BODY_LENGTH = 65536;

/** How long a published range list has to answer before it counts as unread. */
const RANGE_FETCH_TIMEOUT_MS = 30_000;

/**
 * How long an aws CLI call has to answer before it counts as unread. The call
 * gets no standard input, so a prompt it waits on ends here rather than holding
 * the run open.
 */
const AWS_TIMEOUT_MS = 120_000;

const MILLISECONDS_PER_DAY = 86400000;

function utcDate(date) {
  return date.toISOString().slice(0, 10);
}

const IPV4_OCTET = /^\d{1,3}$/;

const IPV6_GROUP = /^[0-9a-f]{1,4}$/;

const PREFIX_LENGTH = /^\d{1,3}$/;

function canonicalIpv4(address) {
  const parts = address.split(".");
  if (parts.length !== 4) return undefined;
  const octets = [];
  for (const part of parts) {
    if (!IPV4_OCTET.test(part)) return undefined;
    const octet = Number(part);
    if (octet > 255) return undefined;
    octets.push(octet);
  }
  return octets.join(".");
}

function ipv6Groups(half) {
  const parts = half.length === 0 ? [] : half.split(":");
  const groups = [];
  for (const [index, part] of parts.entries()) {
    if (part.includes(".")) {
      if (index !== parts.length - 1) return undefined;
      const dotted = canonicalIpv4(part);
      if (dotted === undefined) return undefined;
      const octets = dotted.split(".").map(Number);
      groups.push(
        ((octets[0] << 8) | octets[1]).toString(16),
        ((octets[2] << 8) | octets[3]).toString(16),
      );
      continue;
    }
    if (!IPV6_GROUP.test(part)) return undefined;
    groups.push(part);
  }
  return groups;
}

function canonicalIpv6(address) {
  const halves = address.toLowerCase().split("::");
  if (halves.length > 2) return undefined;
  const head = ipv6Groups(halves[0]);
  const tail = halves.length === 2 ? ipv6Groups(halves[1]) : [];
  if (head === undefined || tail === undefined) return undefined;
  const elided = 8 - head.length - tail.length;
  if (halves.length === 2 ? elided < 1 : elided !== 0) return undefined;
  return [...head, ...Array(elided).fill("0"), ...tail]
    .map((group) => group.padStart(4, "0"))
    .join(":");
}

/**
 * Returns the one spelling two equal ranges written differently both reduce
 * to: IPv4 octets without leading zeros, IPv6 expanded, padded and lowercased.
 * Returns undefined for a value that is no CIDR, which the caller reports
 * rather than comparing as text.
 */
export function canonicalCidr(cidr) {
  const text = typeof cidr === "string" ? cidr.trim() : "";
  const slash = text.indexOf("/");
  if (slash < 0) return undefined;
  const prefix = text.slice(slash + 1);
  if (!PREFIX_LENGTH.test(prefix)) return undefined;
  const address = text.slice(0, slash);
  const canonical = address.includes(":")
    ? canonicalIpv6(address)
    : canonicalIpv4(address);
  if (canonical === undefined) return undefined;
  const family = isIP(canonical);
  if (family === 0) return undefined;
  const length = Number(prefix);
  if (length > (family === 4 ? 32 : 128)) return undefined;
  return `${canonical}/${length}`;
}

function canonicalOrThrow(cidr) {
  const canonical = canonicalCidr(cidr);
  if (canonical === undefined)
    throw new Error(`${cidr} is no CIDR this check can compare`);
  return canonical;
}

/** Returns the CIDRs a published range list states, one per line. */
export function parsePublishedRanges(body) {
  if (body.length > MAXIMUM_RANGE_BODY_LENGTH)
    throw new Error("the published list is longer than a range list can be");
  const ranges = body
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  if (ranges.length === 0) throw new Error("the published list is empty");
  for (const range of ranges)
    if (canonicalCidr(range) === undefined)
      throw new Error(`the published list states ${range}, which is no CIDR`);
  return ranges;
}

function optionValue(document, { namespace, optionName }) {
  for (const settings of document.ConfigurationSettings ?? [])
    for (const option of settings.OptionSettings ?? [])
      if (option.Namespace === namespace && option.OptionName === optionName)
        return option.Value;
  return undefined;
}

/**
 * Returns the id of the one security group every environment attaches, which
 * is the group the deployment documents record the port-443 rule on. A group
 * only one environment attaches is that environment's own, created by the
 * platform and carrying no inbound rule.
 */
export function sharedSecurityGroupId(documents) {
  let shared;
  for (const document of documents) {
    const value = optionValue(document, SECURITY_GROUPS_OPTION);
    if (typeof value !== "string" || value.length === 0)
      throw new Error("a configuration file states no SecurityGroups value");
    const attached = new Set(value.split(",").map((id) => id.trim()));
    shared =
      shared === undefined
        ? attached
        : new Set([...shared].filter((id) => attached.has(id)));
  }
  if (shared === undefined || shared.size !== 1)
    throw new Error(
      `the configuration files attach ${shared?.size ?? 0} group(s) in common, not one`,
    );
  return [...shared][0];
}

/** Returns the region every ARN in the configuration files states. */
export function regionOf(documents) {
  const regions = new Set();
  for (const document of documents)
    for (const match of JSON.stringify(document).matchAll(ARN_REGION))
      if (match[1].length > 0) regions.add(match[1]);
  if (regions.size !== 1)
    throw new Error(
      `the configuration files state ${regions.size} regions, not one`,
    );
  return [...regions][0];
}

function describePermission(permission) {
  const protocol =
    permission.IpProtocol === "-1" ? "every protocol" : permission.IpProtocol;
  const ports =
    permission.FromPort === undefined
      ? "every port"
      : permission.FromPort === permission.ToPort
        ? `port ${permission.FromPort}`
        : `ports ${permission.FromPort}-${permission.ToPort}`;
  const sources = [
    ...(permission.IpRanges ?? []).map((range) => range.CidrIp),
    ...(permission.Ipv6Ranges ?? []).map((range) => range.CidrIpv6),
    ...(permission.UserIdGroupPairs ?? []).map(
      (pair) => `security group ${pair.GroupId}`,
    ),
    ...(permission.PrefixListIds ?? []).map(
      (list) => `prefix list ${list.PrefixListId}`,
    ),
  ];
  return `${protocol} ${ports} from ${sources.join(", ") || "no source"}`;
}

/**
 * Splits a security group's inbound rules into the CIDRs admitted on port 443,
 * the rules that admit anything else, which the recorded posture has none of,
 * and the port-443 sources that are no CIDR this check can compare.
 */
export function ingressOfGroup(group) {
  const admitted = [];
  const unexpected = [];
  const unreadable = [];
  for (const permission of group.IpPermissions ?? []) {
    if (
      permission.IpProtocol !== "tcp" ||
      permission.FromPort !== HTTPS_PORT ||
      permission.ToPort !== HTTPS_PORT
    ) {
      unexpected.push(describePermission(permission));
      continue;
    }
    const sources = [
      ...(permission.IpRanges ?? []).map((range) => range.CidrIp),
      ...(permission.Ipv6Ranges ?? []).map((range) => range.CidrIpv6),
    ];
    for (const source of sources)
      if (canonicalCidr(source) === undefined) unreadable.push(String(source));
      else admitted.push(source.trim());
    for (const pair of permission.UserIdGroupPairs ?? [])
      unexpected.push(`tcp port 443 from security group ${pair.GroupId}`);
    for (const list of permission.PrefixListIds ?? [])
      unexpected.push(`tcp port 443 from prefix list ${list.PrefixListId}`);
  }
  return { admitted, unexpected, unreadable };
}

/**
 * Returns the published ranges no rule admits, and the reverse, comparing the
 * ranges as addresses and naming each one as the side that states it spells it.
 */
export function rangeVerdict({ published, admitted }) {
  const byAddress = (cidrs) => {
    const ranges = new Map();
    for (const cidr of cidrs) ranges.set(canonicalOrThrow(cidr), cidr);
    return ranges;
  };
  const publishedRanges = byAddress(published);
  const admittedRanges = byAddress(admitted);
  const statedBy = (ranges, other) =>
    [...ranges]
      .filter(([address]) => !other.has(address))
      .map(([, cidr]) => cidr)
      .sort();
  return {
    missing: statedBy(publishedRanges, admittedRanges),
    unpublished: statedBy(admittedRanges, publishedRanges),
  };
}

/** Returns how far the certificate is from expiry, against the margin. */
export function certificateVerdict({ notAfter, now, marginDays }) {
  const daysRemaining = Math.floor(
    (notAfter.getTime() - now.getTime()) / MILLISECONDS_PER_DAY,
  );
  return { daysRemaining, withinMargin: daysRemaining < marginDays };
}

/** Returns the expiry stated by a PEM origin certificate. */
export function certificateExpiry(pem) {
  const notAfter = new Date(new X509Certificate(pem).validTo);
  if (Number.isNaN(notAfter.getTime()))
    throw new Error("the certificate states no readable expiry");
  return notAfter;
}

function recordedExpiry(record) {
  const stated = record.origin_certificate?.not_after;
  const notAfter =
    typeof stated === "string" ? new Date(`${stated}T00:00:00Z`) : undefined;
  if (notAfter === undefined || Number.isNaN(notAfter.getTime()))
    throw new Error(`${RECORD_FILE} records no origin certificate expiry`);
  return notAfter;
}

function recordedRanges(record) {
  const ranges = record.cloudflare_ranges ?? {};
  if (typeof ranges.fetched !== "string") return undefined;
  const published = [...(ranges.ipv4 ?? []), ...(ranges.ipv6 ?? [])];
  for (const cidr of published)
    if (canonicalCidr(cidr) === undefined)
      throw new Error(`${RECORD_FILE} records ${cidr}, which is no CIDR`);
  return { fetched: ranges.fetched, published };
}

function sameRanges(left, right) {
  const sorted = (ranges) => ranges.map(canonicalOrThrow).sort().join(" ");
  return sorted(left) === sorted(right);
}

async function fetchPublishedRanges(record, effects) {
  const sources = record.cloudflare_ranges?.source ?? {};
  const published = [];
  for (const family of ["ipv4", "ipv6"]) {
    const url = sources[family];
    if (typeof url !== "string")
      throw new Error(`${RECORD_FILE} records no ${family} source`);
    published.push(...parsePublishedRanges(await effects.fetchText(url)));
  }
  return published;
}

async function certificateLeg({ record, effects, region, now, marginDays }) {
  const lines = [];
  let notAfter;
  let readLive = true;
  let read = "the certificate the deployment bucket holds";
  try {
    notAfter = certificateExpiry(
      await effects.readOriginCertificate({ region }),
    );
  } catch (error) {
    readLive = false;
    notAfter = recordedExpiry(record);
    read = `the expiry ${RECORD_FILE} records, the account being unreadable (${error.message})`;
  }
  const { daysRemaining, withinMargin } = certificateVerdict({
    notAfter,
    now,
    marginDays,
  });
  lines.push(
    `origin certificate: compared ${read}; it expires ${utcDate(notAfter)}, ${daysRemaining} day(s) away.`,
  );
  if (!readLive)
    lines.push(
      "origin certificate: the deployed certificate itself was not read, so the recorded expiry alone was checked.",
    );
  let drifted = withinMargin;
  if (withinMargin)
    lines.push(
      `origin certificate: inside the ${marginDays}-day margin. Issue a replacement and install it -- docs/DEPLOYMENT.md, "Reinstalling the origin certificate".`,
    );
  if (readLive) {
    const recorded = utcDate(recordedExpiry(record));
    if (recorded !== utcDate(notAfter)) {
      drifted = true;
      lines.push(
        `origin certificate: ${RECORD_FILE} records ${recorded}. Record the deployed expiry and commit it.`,
      );
    }
  }
  return { lines, drifted, unchecked: !readLive };
}

async function rangeLeg({ record, effects, region, groupId }) {
  const lines = [];
  let drifted = false;
  let unchecked = false;
  let snapshot;
  try {
    snapshot = recordedRanges(record);
  } catch (error) {
    lines.push(
      `port-443 ingress: ${error.message}, so no snapshot was compared. Run this script with --record and commit the result.`,
    );
    return { lines, drifted, unchecked: true };
  }
  let published;
  let read;
  try {
    published = await fetchPublishedRanges(record, effects);
    read = "the list Cloudflare publishes";
    if (snapshot === undefined) {
      unchecked = true;
      lines.push(
        `port-443 ingress: ${RECORD_FILE} records no range snapshot to compare the published list against. Run this script with --record and commit the result.`,
      );
    } else if (!sameRanges(snapshot.published, published)) {
      drifted = true;
      lines.push(
        `port-443 ingress: the snapshot ${RECORD_FILE} records, fetched ${snapshot.fetched}, differs from the published list. Run this script with --record and commit the result.`,
      );
    }
  } catch (error) {
    if (snapshot === undefined) {
      lines.push(
        `port-443 ingress: the published list is unreadable (${error.message}) and ${RECORD_FILE} records no snapshot to compare against instead.`,
      );
      return { lines, drifted, unchecked: true };
    }
    unchecked = true;
    published = snapshot.published;
    read = `the snapshot ${RECORD_FILE} records, fetched ${snapshot.fetched}, the published list being unreadable (${error.message})`;
  }

  let group;
  try {
    group = await effects.describeSecurityGroup({ region, groupId });
  } catch (error) {
    lines.push(
      `port-443 ingress: security group ${groupId} is unreadable (${error.message}), so no rule was compared.`,
    );
    return { lines, drifted, unchecked: true };
  }

  const { admitted, unexpected, unreadable } = ingressOfGroup(group);
  const { missing, unpublished } = rangeVerdict({ published, admitted });
  lines.push(
    `port-443 ingress: compared security group ${groupId} against ${read}; it admits ${admitted.length} range(s) on port 443.`,
  );
  for (const source of unreadable) {
    unchecked = true;
    lines.push(
      `port-443 ingress: the group admits ${source}, which is no CIDR this check can compare.`,
    );
  }
  for (const cidr of missing) {
    drifted = true;
    lines.push(
      `port-443 ingress: ${cidr} is published and not admitted. Requests forwarded from it are dropped at the origin.`,
    );
  }
  for (const cidr of unpublished) {
    drifted = true;
    lines.push(
      `port-443 ingress: ${cidr} is admitted and not published. It reaches the origin past the edge.`,
    );
  }
  for (const rule of unexpected) {
    drifted = true;
    lines.push(
      `port-443 ingress: the group admits ${rule}, which the recorded posture has none of.`,
    );
  }
  return { lines, drifted, unchecked };
}

/**
 * Runs both comparisons and returns the lines to print and the exit code:
 * a difference found outranks a comparison that could not run.
 */
export async function checkOriginDrift({
  record,
  configurations,
  effects,
  now,
  marginDays = DEFAULT_MARGIN_DAYS,
}) {
  const region = regionOf(configurations);
  const groupId = sharedSecurityGroupId(configurations);
  const legs = [
    await certificateLeg({ record, effects, region, now, marginDays }),
    await rangeLeg({ record, effects, region, groupId }),
  ];
  const lines = legs.flatMap((leg) => leg.lines);
  const drifted = legs.some((leg) => leg.drifted);
  const unchecked = legs.some((leg) => leg.unchecked);
  if (drifted && unchecked)
    lines.push("A comparison found a difference, and another could not run.");
  else if (unchecked)
    lines.push(
      "A comparison could not run, so this run does not state that the values agree.",
    );
  else if (!drifted)
    lines.push("Both comparisons ran and agreed with the recorded values.");
  return {
    lines,
    exitCode: drifted ? EXIT_DRIFTED : unchecked ? EXIT_UNCHECKED : EXIT_AGREES,
  };
}

/**
 * Returns the record with the values this run could read -- the published
 * ranges under today's date, and the deployed certificate's expiry when the
 * account answers -- along with which of those reads succeeded. What it could
 * not read it leaves as recorded.
 */
export async function recordOrigin({ record, configurations, effects, now }) {
  const updated = structuredClone(record);
  const lines = [];
  const reads = { publishedRanges: false, originCertificate: false };
  const published = { ipv4: [], ipv6: [] };
  const sources = record.cloudflare_ranges?.source ?? {};
  for (const family of ["ipv4", "ipv6"]) {
    const url = sources[family];
    if (typeof url !== "string")
      throw new Error(`${RECORD_FILE} records no ${family} source`);
    published[family] = parsePublishedRanges(await effects.fetchText(url));
  }
  reads.publishedRanges = true;
  updated.cloudflare_ranges = {
    ...updated.cloudflare_ranges,
    fetched: utcDate(now),
    ipv4: published.ipv4,
    ipv6: published.ipv6,
  };
  lines.push(
    `Recorded ${published.ipv4.length} IPv4 and ${published.ipv6.length} IPv6 published ranges, fetched ${utcDate(now)}.`,
  );
  try {
    const region = regionOf(configurations);
    const notAfter = certificateExpiry(
      await effects.readOriginCertificate({ region }),
    );
    updated.origin_certificate = {
      not_after: utcDate(notAfter),
      recorded: utcDate(now),
      source: `read from the deployment bucket's ${CERTIFICATE_KEY}`,
    };
    reads.originCertificate = true;
    lines.push(
      `Recorded the deployed certificate's expiry, ${utcDate(notAfter)}.`,
    );
  } catch (error) {
    lines.push(
      `Kept the recorded certificate expiry: the account is unreadable (${error.message}).`,
    );
  }
  return { record: updated, lines, reads };
}

function awsFailure(error) {
  const stderr = typeof error.stderr === "string" ? error.stderr.trim() : "";
  return stderr.length > 0 ? stderr.split("\n")[0] : error.message;
}

function aws(args) {
  try {
    return execFileSync("aws", args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: AWS_TIMEOUT_MS,
      maxBuffer: 8 * 1024 * 1024,
    });
  } catch (error) {
    if (error.code === "ENOENT")
      throw new Error("the aws CLI is not installed");
    if (error.code === "ETIMEDOUT")
      throw new Error(
        `the aws CLI did not answer within ${AWS_TIMEOUT_MS / 1000} seconds`,
      );
    throw new Error(awsFailure(error));
  }
}

const awsEffects = {
  async fetchText(url) {
    let response;
    try {
      response = await fetch(url, {
        signal: AbortSignal.timeout(RANGE_FETCH_TIMEOUT_MS),
      });
    } catch (error) {
      if (error.name === "TimeoutError")
        throw new Error(
          `${url} did not answer within ${RANGE_FETCH_TIMEOUT_MS / 1000} seconds`,
        );
      throw new Error(`${url} is unreachable (${error.message})`);
    }
    if (!response.ok) throw new Error(`${url} answered ${response.status}`);
    return await response.text();
  },
  async readOriginCertificate({ region }) {
    const accountId = aws([
      "sts",
      "get-caller-identity",
      "--query",
      "Account",
      "--output",
      "text",
    ]).trim();
    const bucket = `${CERTIFICATE_BUCKET_PREFIX}-${region}-${accountId}`;
    return aws(["s3", "cp", `s3://${bucket}/${CERTIFICATE_KEY}`, "-"]);
  },
  async describeSecurityGroup({ region, groupId }) {
    const described = JSON.parse(
      aws([
        "ec2",
        "describe-security-groups",
        "--group-ids",
        groupId,
        "--region",
        region,
        "--output",
        "json",
      ]),
    );
    const group = described.SecurityGroups?.[0];
    if (group === undefined)
      throw new Error("the account describes no such group");
    return group;
  },
};

function readJson(url) {
  return JSON.parse(readFileSync(url, "utf8"));
}

function parseArguments(argv) {
  const options = { record: false, marginDays: DEFAULT_MARGIN_DAYS };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--record") options.record = true;
    else if (argv[index] === "--margin-days") {
      const days = Number(argv[index + 1]);
      if (!Number.isInteger(days) || days < 0)
        throw new Error("--margin-days takes a whole number of days");
      options.marginDays = days;
      index += 1;
    } else throw new Error(`unknown argument ${argv[index]}`);
  }
  return options;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const here = new URL(".", import.meta.url);
  const recordUrl = new URL(RECORD_FILE, here);
  try {
    const options = parseArguments(process.argv.slice(2));
    const record = readJson(recordUrl);
    const configurations = CONFIGURATION_FILES.map((file) =>
      readJson(new URL(file, here)),
    );
    const now = new Date();
    if (options.record) {
      const recorded = await recordOrigin({
        record,
        configurations,
        effects: awsEffects,
        now,
      });
      writeFileSync(
        recordUrl,
        `${JSON.stringify(recorded.record, null, 2)}\n`,
        "utf8",
      );
      process.stdout.write(`${recorded.lines.join("\n")}\n`);
      if (Object.values(recorded.reads).some((succeeded) => !succeeded))
        process.exitCode = EXIT_UNCHECKED;
    } else {
      const { lines, exitCode } = await checkOriginDrift({
        record,
        configurations,
        effects: awsEffects,
        now,
        marginDays: options.marginDays,
      });
      process.stdout.write(`${lines.join("\n")}\n`);
      process.exitCode = exitCode;
    }
  } catch (error) {
    process.stderr.write(`check-origin-drift.mjs: ${error.message}\n`);
    process.exitCode = EXIT_UNCHECKED;
  }
}
