// Reports drift in the two origin values nothing else in this repository
// notices: the origin certificate's expiry, and the port-443 ingress of the
// security group both environments attach against Cloudflare's published
// ranges. The recorded values are in recorded-origin.json beside this file;
// what the run needs and how often to run it are in README.md beside it.
//
// The account is read through the `aws` CLI, as the refresh procedure and the
// prebuild certificate hook are. Nothing here prints the account id or the
// deployment bucket; an AWS CLI error passed through can name either.
//
// Nothing here writes: a run that finds a difference prints the record to
// paste, and the operator commits it.

import { X509Certificate } from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { isIP } from "node:net";
import { readFileSync } from "node:fs";

/** Every comparison ran and agreed. */
export const EXIT_AGREES = 0;

/** A comparison ran and found a difference. */
export const EXIT_DRIFTED = 1;

/** A comparison could not run: the account or a published list was unread. */
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
 * Returns the expected ranges no rule admits, and the admitted ranges the
 * expected list does not state, comparing the ranges as addresses and naming
 * each one as the side that states it spells it.
 */
export function rangeVerdict({ expected, admitted }) {
  const byAddress = (cidrs) => {
    const ranges = new Map();
    for (const cidr of cidrs) ranges.set(canonicalOrThrow(cidr), cidr);
    return ranges;
  };
  const expectedRanges = byAddress(expected);
  const admittedRanges = byAddress(admitted);
  const statedBy = (ranges, other) =>
    [...ranges]
      .filter(([address]) => !other.has(address))
      .map(([, cidr]) => cidr)
      .sort();
  return {
    unadmitted: statedBy(expectedRanges, admittedRanges),
    unstated: statedBy(admittedRanges, expectedRanges),
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

/**
 * Returns the expiry the record states, or undefined when it states none: a
 * record the check cannot read is a difference from the account to report,
 * not a comparison that could not run.
 */
function recordedExpiry(record) {
  const stated = record.origin_certificate?.not_after;
  const notAfter =
    typeof stated === "string" ? new Date(`${stated}T00:00:00Z`) : undefined;
  if (notAfter === undefined || Number.isNaN(notAfter.getTime()))
    return undefined;
  return notAfter;
}

/**
 * Returns the range snapshot the record states: the date it was fetched, the
 * ranges it holds, and the first of them that is no CIDR.
 */
function recordedSnapshot(record) {
  const ranges = record.cloudflare_ranges ?? {};
  const stated = [...(ranges.ipv4 ?? []), ...(ranges.ipv6 ?? [])];
  return {
    fetched: typeof ranges.fetched === "string" ? ranges.fetched : undefined,
    stated,
    unreadable: stated.find((cidr) => canonicalCidr(cidr) === undefined),
  };
}

function sameRanges(left, right) {
  const sorted = (ranges) => ranges.map(canonicalOrThrow).sort().join(" ");
  return sorted(left) === sorted(right);
}

async function fetchPublishedRanges(record, effects) {
  const sources = record.cloudflare_ranges?.source ?? {};
  const published = { ipv4: [], ipv6: [] };
  for (const family of ["ipv4", "ipv6"]) {
    const url = sources[family];
    if (typeof url !== "string")
      throw new Error(`${RECORD_FILE} records no ${family} source`);
    published[family] = parsePublishedRanges(await effects.fetchText(url));
  }
  return { ...published, all: [...published.ipv4, ...published.ipv6] };
}

function describeExpiry(notAfter, daysRemaining) {
  return daysRemaining < 0
    ? `it expired ${utcDate(notAfter)}, ${-daysRemaining} day(s) ago`
    : `it expires ${utcDate(notAfter)}, ${daysRemaining} day(s) away`;
}

async function certificateLeg({ record, effects, region, now, marginDays }) {
  const lines = [];
  let notAfter;
  try {
    notAfter = certificateExpiry(
      await effects.readOriginCertificate({ region }),
    );
  } catch (error) {
    lines.push(
      `origin certificate: the certificate the deployment bucket holds could not be read (${error.message}), so nothing was compared.`,
    );
    return { lines, drifted: false, unchecked: true };
  }
  const { daysRemaining, withinMargin } = certificateVerdict({
    notAfter,
    now,
    marginDays,
  });
  lines.push(
    `origin certificate: compared the certificate the deployment bucket holds; ${describeExpiry(notAfter, daysRemaining)}.`,
  );
  if (withinMargin)
    lines.push(
      `origin certificate: ${daysRemaining < 0 ? "it has expired" : `inside the ${marginDays}-day margin`}. Issue a replacement and install it -- docs/DEPLOYMENT.md, "Reinstalling the origin certificate".`,
    );
  const recorded = recordedExpiry(record);
  const differs =
    recorded === undefined || utcDate(recorded) !== utcDate(notAfter);
  if (recorded === undefined)
    lines.push(`origin certificate: ${RECORD_FILE} records no expiry.`);
  else if (differs)
    lines.push(
      `origin certificate: ${RECORD_FILE} records ${utcDate(recorded)}, not the expiry the deployment bucket holds.`,
    );
  return {
    lines,
    drifted: withinMargin || differs,
    unchecked: false,
    notAfter,
    differs,
  };
}

async function rangeLeg({ record, effects, region, groupId }) {
  const lines = [];
  let published;
  try {
    published = await fetchPublishedRanges(record, effects);
  } catch (error) {
    lines.push(
      `port-443 ingress: the published ranges could not be read (${error.message}), so nothing was compared.`,
    );
    return { lines, drifted: false, unchecked: true };
  }
  let group;
  try {
    group = await effects.describeSecurityGroup({ region, groupId });
  } catch (error) {
    lines.push(
      `port-443 ingress: security group ${groupId} could not be read (${error.message}), so no rule was compared.`,
    );
    return { lines, drifted: false, unchecked: true };
  }
  const { admitted, unexpected, unreadable } = ingressOfGroup(group);
  let drifted = false;
  let unchecked = false;
  lines.push(
    `port-443 ingress: compared security group ${groupId} against the list Cloudflare publishes and against ${RECORD_FILE}; it admits ${admitted.length} range(s) on port 443.`,
  );
  for (const source of unreadable) {
    unchecked = true;
    lines.push(
      `port-443 ingress: the group admits ${source}, which is no CIDR this check can compare.`,
    );
  }
  const againstPublished = rangeVerdict({ expected: published.all, admitted });
  for (const cidr of againstPublished.unadmitted) {
    drifted = true;
    lines.push(
      `port-443 ingress: ${cidr} is published and not admitted. Requests forwarded from it are dropped at the origin.`,
    );
  }
  for (const cidr of againstPublished.unstated) {
    drifted = true;
    lines.push(
      `port-443 ingress: ${cidr} is admitted and not published. It reaches the origin past the edge.`,
    );
  }
  const snapshot = recordedSnapshot(record);
  let differs = true;
  if (snapshot.fetched === undefined || snapshot.stated.length === 0)
    lines.push(`port-443 ingress: ${RECORD_FILE} records no range snapshot.`);
  else if (snapshot.unreadable !== undefined)
    lines.push(
      `port-443 ingress: ${RECORD_FILE} records ${snapshot.unreadable}, which is no CIDR this check can compare.`,
    );
  else {
    const againstRecord = rangeVerdict({ expected: snapshot.stated, admitted });
    for (const cidr of againstRecord.unadmitted) {
      drifted = true;
      lines.push(`port-443 ingress: ${cidr} is recorded and not admitted.`);
    }
    for (const cidr of againstRecord.unstated) {
      drifted = true;
      lines.push(`port-443 ingress: ${cidr} is admitted and not recorded.`);
    }
    differs = !sameRanges(snapshot.stated, published.all);
    if (differs)
      lines.push(
        `port-443 ingress: the snapshot ${RECORD_FILE} records, fetched ${snapshot.fetched}, is not the list Cloudflare publishes now.`,
      );
  }
  for (const rule of unexpected) {
    drifted = true;
    lines.push(
      `port-443 ingress: the group admits ${rule}, which the recorded posture has none of.`,
    );
  }
  return {
    lines,
    drifted: drifted || differs,
    unchecked,
    published,
    differs,
  };
}

/**
 * Returns the record as the run would have it: the values it read from the
 * account and from Cloudflare, under today's date, with the sources the
 * record already states.
 */
function recordToPaste({ record, notAfter, published, now }) {
  return JSON.stringify(
    {
      origin_certificate: {
        not_after: utcDate(notAfter),
        recorded: utcDate(now),
        source: `read from the deployment bucket's ${CERTIFICATE_KEY}`,
      },
      cloudflare_ranges: {
        fetched: utcDate(now),
        source: record.cloudflare_ranges?.source ?? {},
        ipv4: published.ipv4,
        ipv6: published.ipv6,
      },
    },
    null,
    2,
  );
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
  const certificate = await certificateLeg({
    record,
    effects,
    region,
    now,
    marginDays,
  });
  const range = await rangeLeg({ record, effects, region, groupId });
  const lines = [...certificate.lines, ...range.lines];
  const drifted = certificate.drifted || range.drifted;
  const unchecked = certificate.unchecked || range.unchecked;
  if (
    (certificate.differs || range.differs) &&
    certificate.notAfter !== undefined &&
    range.published !== undefined
  )
    lines.push(
      `Paste this into ${RECORD_FILE} and commit it:`,
      recordToPaste({
        record,
        notAfter: certificate.notAfter,
        published: range.published,
        now,
      }),
    );
  if (drifted) lines.push("A comparison found a difference.");
  else if (unchecked)
    lines.push(
      "A comparison could not run, so this run does not state that the values agree.",
    );
  else lines.push("Both comparisons ran and agreed with the recorded values.");
  return {
    lines,
    exitCode: drifted ? EXIT_DRIFTED : unchecked ? EXIT_UNCHECKED : EXIT_AGREES,
  };
}

function awsFailure(error) {
  const stderr = typeof error.stderr === "string" ? error.stderr.trim() : "";
  return stderr.length > 0 ? stderr.split("\n")[0] : error.message;
}

/**
 * Runs one `aws` call and returns its standard output, mapping every way the
 * call can fail onto a reason a printed line can state. Exported so a test can
 * drive it against a stub executable under a timeout short enough to wait for.
 */
export function aws(args, { timeoutMs = AWS_TIMEOUT_MS } = {}) {
  try {
    return execFileSync("aws", args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: timeoutMs,
      maxBuffer: 8 * 1024 * 1024,
    });
  } catch (error) {
    if (error.code === "ENOENT")
      throw new Error("the aws CLI is not installed");
    if (error.code === "ETIMEDOUT")
      throw new Error(
        `the aws CLI did not answer within ${timeoutMs / 1000} seconds`,
      );
    throw new Error(awsFailure(error));
  }
}

/** Reads the account and the published lists the check compares against. */
export const awsEffects = {
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
  const options = { marginDays: DEFAULT_MARGIN_DAYS };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--margin-days") {
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
  try {
    const options = parseArguments(process.argv.slice(2));
    const record = readJson(new URL(RECORD_FILE, here));
    const configurations = CONFIGURATION_FILES.map((file) =>
      readJson(new URL(file, here)),
    );
    const { lines, exitCode } = await checkOriginDrift({
      record,
      configurations,
      effects: awsEffects,
      now: new Date(),
      marginDays: options.marginDays,
    });
    process.stdout.write(`${lines.join("\n")}\n`);
    process.exitCode = exitCode;
  } catch (error) {
    process.stderr.write(`check-origin-drift.mjs: ${error.message}\n`);
    process.exitCode = EXIT_UNCHECKED;
  }
}
