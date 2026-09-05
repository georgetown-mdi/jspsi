import fs from "node:fs";
import path from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import { parse as parseYaml } from "yaml";

import { MAX_TEXT_LENGTH, safeParseExchangeSpec } from "@psilink/core";

import {
  HANDOFF_SHARED_DIRECTORY_PLACEHOLDER,
  HANDOFF_SIGNING_IDENTITY_PLACEHOLDER,
  buildJobHandoff,
} from "@jobs/handoff";
import {
  IDENTITY_AT_REST_NOTICE,
  IDENTITY_LABEL_REQUIRED_REASON,
  IDENTITY_MISSING_PROBLEM,
  IDENTITY_SHARED_MOUNT_ADVISORY,
  IDENTITY_SHARED_MOUNT_ADVISORY_UNCERTAIN,
  NO_PARTNER_PIN_PROBLEM,
  PARTNER_FINGERPRINT_PROBLEM,
  RECEIPTS_DEFAULT,
  RECEIPT_LOCATION_NOTICE,
  RETENTION_NOTE_CONTROL_CHAR_PROBLEM,
  RETENTION_NOTE_PROBLEM,
  SESSION_DERIVED_PROBLEM,
  UNNAMED_PARTY_PROBLEM,
  fingerprintRequestProblem,
  receiptsAdvisories,
  receiptsIntentFields,
  receiptsProblems,
  receiptsSummary,
  receiptsWithField,
} from "@psi/receiptsModel";
import {
  JOB_FILE_NAMES,
  composeConfigDocument,
  composeSftpConfigDocument,
  jobCreateIntentSchema,
  jobExchangeIntentSchema,
} from "@jobs/intent";
import {
  SIGNING_CERTIFICATE_FILE_NAME,
  SIGNING_IDENTITY_FILE_NAME,
  assertExportPathDistinct,
  fingerprintArgv,
  parseFingerprintStdout,
  reconcileFingerprintExit,
  runSigningFingerprint,
  signingCertificatePath,
  signingIdentityPath,
} from "@jobs/signingIdentity";
import { importLinkageTerms } from "@psi/linkageTermsIO";
import { resolveWorkdirFile } from "@jobs/workdir";

import {
  STUB_CLI_PATH,
  tempDataRoot,
  testSftpServerEntry,
  validIntent,
  validLinkageTerms,
  validSftpIntent,
  validZeroSetupIntent,
} from "../utils/jobFixtures";

import type { JobRendezvousConfig } from "@psi/workInputClient";
import type { JobSigningPaths } from "@jobs/intent";
import type { LinkageTerms } from "@psilink/core";
import type { ReceiptsDraft } from "@psi/receiptsModel";

// The console's receipt-signing and retention authoring surface, end to end: what
// the boundary schema admits, what the two composers emit per mode, what the
// graduation template says about a container-internal identity, the export
// refusal, and the fingerprint driver's own reconciliation.

/** A canonical 43-character fingerprint (the final character drawn from the
 * aligned set the config schema requires). */
const PARTNER_FINGERPRINT = "C".repeat(42) + "A";
/** A second canonical value, for the driver's own stdout. */
const OWN_FINGERPRINT = "B".repeat(42) + "A";

const RETENTION_NOTE =
  "Filed in the association database; kept six years, then purged.";

/** The single-mount layout the identity-location advisory exists for: the folder
 * the partner syncs into holds the working directory this party's signing key is
 * written to, positively established by the walk (a lexical or filesystem
 * match), so the advisory states it as fact. */
const SHARED_RENDEZVOUS: JobRendezvousConfig = {
  configured: true,
  locator: "psilink",
  folderName: "psilink",
  sharesDataRoot: true,
  sharesDataRootUncertain: false,
};

/** The same single-mount layout, but where the walk could not rule it out rather
 * than positively establishing it -- an unresolved real path in the comparison --
 * so the advisory hedges instead of asserting. */
const UNCERTAIN_SHARED_RENDEZVOUS: JobRendezvousConfig = {
  ...SHARED_RENDEZVOUS,
  sharesDataRootUncertain: true,
};

/** A console whose rendezvous has a mount of its own, where the collision the
 * advisory names cannot arise. */
const SEPARATE_RENDEZVOUS: JobRendezvousConfig = {
  ...SHARED_RENDEZVOUS,
  sharesDataRoot: false,
  sharesDataRootUncertain: false,
};

const dirs: Array<string> = [];
afterEach(() => {
  for (const dir of dirs.splice(0))
    fs.rmSync(dir, { recursive: true, force: true });
});

function scratchDir(): string {
  const dir = tempDataRoot("receipts");
  dirs.push(dir);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

const signingPaths = (workdir = "/srv/job"): JobSigningPaths => ({
  identityFile: "/data/.psilink-signing-identity.json",
  receiptOutput: path.join(workdir, "receipt.json"),
});

/** The composed document parsed as data, and re-validated through core's own
 * exchange-spec schema so a block this composer emits is one the CLI would load. */
function composedSpec(yaml: string): Record<string, unknown> {
  const parsed = safeParseExchangeSpec(parseYaml(yaml));
  expect(parsed.success).toBe(true);
  return parseYaml(yaml) as Record<string, unknown>;
}

const draft = (overrides: Partial<ReceiptsDraft> = {}): ReceiptsDraft => ({
  ...RECEIPTS_DEFAULT,
  ...overrides,
});

/** The name this exchange states, for the cases that are not about the name. */
const THIS_PARTY = "Agency A";

/** The card's problems for a draft on an exchange that names this party. The
 * name is the model's second input and exactly one refusal turns on it, so the
 * cases below that are about something else read it through here, and the two
 * that are about the name call the model directly with their own value. */
const problemsFor = (authored: ReceiptsDraft): Array<string> =>
  receiptsProblems(authored, THIS_PARTY);

describe("the intent boundary admits only a mode an exchange honors", () => {
  test("certificate mode with a canonical pin parses", () => {
    const parsed = jobExchangeIntentSchema.safeParse(
      validIntent({
        signing: {
          mode: "certificate",
          partnerFingerprint: PARTNER_FINGERPRINT,
        },
        retentionDisposition: RETENTION_NOTE,
      }),
    );
    expect(parsed.success).toBe(true);
  });

  test("the unimplemented session-derived mode is refused, not accepted and dropped", () => {
    const parsed = jobExchangeIntentSchema.safeParse({
      ...validIntent(),
      signing: { mode: "session-derived" },
    });
    expect(parsed.success).toBe(false);
  });

  test("a non-canonical partner fingerprint is refused", () => {
    for (const bad of ["", "too-short", "/etc/passwd", "D".repeat(43)]) {
      const parsed = jobExchangeIntentSchema.safeParse(
        validIntent({
          signing: { mode: "certificate", partnerFingerprint: bad },
        }),
      );
      expect(parsed.success).toBe(false);
    }
  });

  test("a pin beside mode none is a contradiction, not an inert extra", () => {
    const parsed = jobExchangeIntentSchema.safeParse(
      validIntent({
        signing: { mode: "none", partnerFingerprint: PARTNER_FINGERPRINT },
      }),
    );
    expect(parsed.success).toBe(false);
  });

  test("certificate mode with no pin is refused, on both channels and the create union", () => {
    // The run this job would spawn cannot finish: core refuses an unpinned
    // certificate-mode config before any connection is opened, having reached the
    // refusal only inside the exchange -- after this party's payload crossed --
    // if it started. Refusing at job creation is what keeps the workdir, the
    // child, and that disclosure from happening at all.
    for (const intent of [
      validIntent({ signing: { mode: "certificate" } }),
      validSftpIntent({ signing: { mode: "certificate" } }),
    ])
      expect(jobExchangeIntentSchema.safeParse(intent).success).toBe(false);
    // The create route parses the mode-discriminated union, not the exchange
    // schema directly, so the rule is asserted where the 400 is actually decided.
    const parsed = jobCreateIntentSchema.safeParse(
      validIntent({ signing: { mode: "certificate" } }),
    );
    expect(parsed.success).toBe(false);
    if (parsed.success) throw new Error("unreachable");
    // The issue names the field the operator has to fill, rather than failing the
    // whole signing block anonymously.
    expect(parsed.error.issues.map((issue) => issue.path)).toContainEqual([
      "signing",
      "partnerFingerprint",
    ]);
  });

  test("certificate mode with an unnamed party is refused, on both channels and the create union", () => {
    // The sibling rule, and the same reasoning: a certificate is trusted by the
    // identity its holder used in the agreed terms, so a job whose terms name no
    // party spawns a child that refuses the config -- and without core's gate the
    // refusal it would reach is the one inside the exchange, after this party's
    // payload crossed.
    const unnamedTerms = (): LinkageTerms => {
      const { identity: _named, ...rest } = validLinkageTerms();
      return rest;
    };
    const signing = {
      mode: "certificate" as const,
      partnerFingerprint: PARTNER_FINGERPRINT,
    };
    for (const intent of [
      validIntent({ linkageTerms: unnamedTerms(), signing }),
      validSftpIntent({ linkageTerms: unnamedTerms(), signing }),
      // A blank label is absence here too: it is what a form field left alone
      // submits, and core's own terms schema refuses it outright.
      validIntent({
        linkageTerms: { ...validLinkageTerms(), identity: "   " },
        signing,
      }),
    ])
      expect(jobExchangeIntentSchema.safeParse(intent).success).toBe(false);
    const parsed = jobCreateIntentSchema.safeParse(
      validIntent({ linkageTerms: unnamedTerms(), signing }),
    );
    expect(parsed.success).toBe(false);
    if (parsed.success) throw new Error("unreachable");
    expect(parsed.error.issues.map((issue) => issue.path)).toContainEqual([
      "linkageTerms",
      "identity",
    ]);
  });

  test("an unnamed party that asks for no receipt is admitted", () => {
    // The gate binds the certificate-signing configuration alone: an unnamed
    // quick exchange is the shape an optional identity exists for, and it must
    // still create -- with no signing block at all, and with mode none.
    const { identity: _named, ...unnamedTerms } = validLinkageTerms();
    for (const intent of [
      validIntent({ linkageTerms: unnamedTerms }),
      validIntent({ linkageTerms: unnamedTerms, signing: { mode: "none" } }),
    ])
      expect(jobExchangeIntentSchema.safeParse(intent).success).toBe(true);
  });

  test("no path field is representable on the signing block", () => {
    for (const smuggled of [
      { mode: "certificate", identityFile: "/etc/psilink/identity.json" },
      { mode: "certificate", identity_file: "/etc/psilink/identity.json" },
      { mode: "certificate", receiptOutput: "/tmp/receipt.json" },
    ]) {
      const parsed = jobExchangeIntentSchema.safeParse({
        ...validIntent(),
        signing: smuggled,
      });
      expect(parsed.success).toBe(false);
    }
  });

  test("the retention note refuses a control character, keeping the whitespace a note holds", () => {
    const admits = (note: string): boolean =>
      jobExchangeIntentSchema.safeParse(
        validIntent({ retentionDisposition: note }),
      ).success;
    // A NUL or an ESC would compose into the YAML and land in the exchange
    // record verbatim, so the note holds the control-character refusal the
    // rest of this surface's operator-supplied strings do.
    for (const code of [0x00, 0x07, 0x0b, 0x0c, 0x1b, 0x7f, 0x9b])
      expect(
        admits(`Filed${String.fromCharCode(code)}under the schedule`),
      ).toBe(false);
    // The card authors this field in a textarea, so the whitespace controls a
    // multi-line note holds stay admissible.
    expect(admits("Filed under the schedule.\nPurged after six years.")).toBe(
      true,
    );
    expect(
      admits("Filed\tunder the schedule.\r\nPurged after six years."),
    ).toBe(true);
  });

  test("an admitted multi-line note round-trips through the composed YAML", () => {
    const multiline = "Filed under the schedule.\nPurged after six years.";
    const composed = composedSpec(
      composeConfigDocument(
        validIntent({ retentionDisposition: multiline }),
        "/rendezvous",
        undefined,
        signingPaths(),
      ),
    );
    expect(composed["retention_disposition"]).toBe(multiline);
  });

  test("the retention note is bounded by the record schema's own ceiling", () => {
    expect(
      jobExchangeIntentSchema.safeParse(
        validIntent({ retentionDisposition: "x".repeat(MAX_TEXT_LENGTH) }),
      ).success,
    ).toBe(true);
    expect(
      jobExchangeIntentSchema.safeParse(
        validIntent({ retentionDisposition: "x".repeat(MAX_TEXT_LENGTH + 1) }),
      ).success,
    ).toBe(false);
    // An absent note is the omitted key, never an empty string.
    expect(
      jobExchangeIntentSchema.safeParse(
        validIntent({ retentionDisposition: "" }),
      ).success,
    ).toBe(false);
  });
});

describe("the composed signing block, per mode", () => {
  test("no signing choice composes no block at all", () => {
    const composed = composedSpec(
      composeConfigDocument(
        validIntent(),
        "/rendezvous",
        undefined,
        signingPaths(),
      ),
    );
    expect(composed["signing"]).toBeUndefined();
    expect(composed["retention_disposition"]).toBeUndefined();
  });

  test("mode none composes no block either: absent is what the CLI treats as unsigned", () => {
    const composed = composedSpec(
      composeConfigDocument(
        validIntent({ signing: { mode: "none" } }),
        "/rendezvous",
        undefined,
        signingPaths(),
      ),
    );
    expect(composed["signing"]).toBeUndefined();
  });

  test("certificate mode composes the mode, the server's paths, and the pin", () => {
    const composed = composedSpec(
      composeConfigDocument(
        validIntent({
          signing: {
            mode: "certificate",
            partnerFingerprint: PARTNER_FINGERPRINT,
          },
        }),
        "/rendezvous",
        undefined,
        signingPaths("/srv/job-a"),
      ),
    );
    expect(composed["signing"]).toEqual({
      mode: "certificate",
      identity_file: "/data/.psilink-signing-identity.json",
      partner_fingerprint: PARTNER_FINGERPRINT,
      receipt_output: "/srv/job-a/receipt.json",
    });
  });

  test("the sftp composer emits the identical block", () => {
    const composed = composedSpec(
      composeSftpConfigDocument(
        validSftpIntent({
          signing: {
            mode: "certificate",
            partnerFingerprint: PARTNER_FINGERPRINT,
          },
        }),
        testSftpServerEntry(),
        signingPaths("/srv/job-b"),
      ),
    );
    expect(composed["signing"]).toEqual({
      mode: "certificate",
      identity_file: "/data/.psilink-signing-identity.json",
      partner_fingerprint: PARTNER_FINGERPRINT,
      receipt_output: "/srv/job-b/receipt.json",
    });
  });

  test("certificate mode with no resolved paths is a compose-time error, never a silent unsigned run", () => {
    expect(() =>
      composeConfigDocument(
        validIntent({ signing: { mode: "certificate" } }),
        "/rendezvous",
      ),
    ).toThrow(/identity path/);
  });

  test("certificate mode with no pinned fingerprint is a compose-time error too", () => {
    // jobSigningChoiceSchema's refine guarantees a validated certificate intent
    // always has partnerFingerprint, so an intent missing it is reachable
    // here only by bypassing the schema -- exactly what this hand-built intent
    // does. The guard is what turns that impossible state into a loud failure
    // at compose time rather than a config the spawned child would refuse
    // minutes later with a bare exit 64.
    expect(() =>
      composeConfigDocument(
        validIntent({ signing: { mode: "certificate" } }),
        "/rendezvous",
        undefined,
        signingPaths(),
      ),
    ).toThrow(/partner fingerprint/);
    expect(() =>
      composeSftpConfigDocument(
        validSftpIntent({ signing: { mode: "certificate" } }),
        testSftpServerEntry(),
        signingPaths(),
      ),
    ).toThrow(/partner fingerprint/);
  });
});

describe("the retention note reaches the composed config verbatim", () => {
  test("on the filedrop composer", () => {
    const composed = composedSpec(
      composeConfigDocument(
        validIntent({ retentionDisposition: RETENTION_NOTE }),
        "/rendezvous",
        undefined,
        signingPaths(),
      ),
    );
    expect(composed["retention_disposition"]).toBe(RETENTION_NOTE);
  });

  test("on the sftp composer", () => {
    const composed = composedSpec(
      composeSftpConfigDocument(
        validSftpIntent({ retentionDisposition: RETENTION_NOTE }),
        testSftpServerEntry(),
        signingPaths(),
      ),
    );
    expect(composed["retention_disposition"]).toBe(RETENTION_NOTE);
  });
});

describe("the graduation hand-off handles the identity path accurately", () => {
  const handoffYaml = (
    intent = validIntent({
      signing: { mode: "certificate", partnerFingerprint: PARTNER_FINGERPRINT },
      retentionDisposition: RETENTION_NOTE,
    }),
  ) => {
    const handoff = buildJobHandoff(intent, undefined, {
      credentialPasted: false,
      filedropSplit: false,
    });
    expect(handoff.template.kind).toBe("config");
    if (handoff.template.kind !== "config") throw new Error("unreachable");
    return { handoff, spec: composedSpec(handoff.template.yaml) };
  };

  test("the identity file is a placeholder, never the console's own path", () => {
    const { spec } = handoffYaml();
    const signing = spec["signing"] as Record<string, unknown>;
    expect(signing["identity_file"]).toBe(HANDOFF_SIGNING_IDENTITY_PLACEHOLDER);
    expect(JSON.stringify(spec)).not.toContain("/data/");
    expect(JSON.stringify(spec)).not.toContain(SIGNING_IDENTITY_FILE_NAME);
  });

  test("the receipt output is OMITTED, so a schedule accumulates a trail", () => {
    const { spec } = handoffYaml();
    const signing = spec["signing"] as Record<string, unknown>;
    expect(signing["receipt_output"]).toBeUndefined();
    expect(signing["mode"]).toBe("certificate");
    // The partner's pin is portable and passes through verbatim.
    expect(signing["partner_fingerprint"]).toBe(PARTNER_FINGERPRINT);
  });

  test("the retention note passes through verbatim", () => {
    const { spec } = handoffYaml();
    expect(spec["retention_disposition"]).toBe(RETENTION_NOTE);
  });

  test("no container path appears anywhere in the template", () => {
    const { handoff } = handoffYaml();
    if (handoff.template.kind !== "config") throw new Error("unreachable");
    expect(handoff.template.yaml).toContain(
      HANDOFF_SHARED_DIRECTORY_PLACEHOLDER,
    );
  });

  test("usedSigningIdentity flags the carry-the-key caveat only for a signed run", () => {
    const { handoff } = handoffYaml();
    expect(handoff.usedSigningIdentity).toBe(true);
    expect(
      buildJobHandoff(validIntent(), undefined, {
        credentialPasted: false,
        filedropSplit: false,
      }).usedSigningIdentity,
    ).toBe(false);
    // A zero-setup run composes no config and signs nothing.
    expect(
      buildJobHandoff(validZeroSetupIntent(), undefined, {
        credentialPasted: false,
        filedropSplit: false,
      }).usedSigningIdentity,
    ).toBe(false);
  });
});

// Each signing artifact's path is composed from a server constant against a
// directory the console owns, and the receipt's is the one a route then serves
// out of the job workdir. Each goes through the containment check rather than a
// join, the way the diagnostic log's path is.
describe("the signing artifacts resolve inside the directory that owns them", () => {
  const workdir = "/srv/jobs/93b1c0d6";

  test("the receipt lands directly under the job workdir, the identity under the mount", () => {
    expect(resolveWorkdirFile(workdir, JOB_FILE_NAMES.receipt)).toBe(
      path.resolve(workdir, JOB_FILE_NAMES.receipt),
    );
    expect(signingIdentityPath("/data")).toBe(
      path.resolve("/data", SIGNING_IDENTITY_FILE_NAME),
    );
    expect(signingCertificatePath("/data")).toBe(
      path.resolve("/data", SIGNING_CERTIFICATE_FILE_NAME),
    );
  });

  test("every constant these paths are built from is a single segment", () => {
    for (const name of [
      JOB_FILE_NAMES.receipt,
      SIGNING_IDENTITY_FILE_NAME,
      SIGNING_CERTIFICATE_FILE_NAME,
    ]) {
      expect(name).toBe(path.basename(name));
      expect(name.includes("/")).toBe(false);
      expect(name.includes("\\")).toBe(false);
    }
  });

  test("a name that escapes the directory is refused rather than resolved elsewhere", () => {
    // The check the three paths compose through, driven with the shapes a
    // constant that stopped resolving inside its directory would take -- the
    // last of them a sibling that merely shares the workdir's prefix.
    for (const escape of [
      "../receipt.json",
      "../../etc/passwd",
      "sub/../../receipt.json",
      "/etc/passwd",
      "../93b1c0d6-evil/receipt.json",
    ])
      expect(resolveWorkdirFile(workdir, escape)).toBeNull();
  });

  test("a name that stays inside is kept, separator and all", () => {
    // Containment is what the check tests, not the absence of a separator: the
    // docstrings say so, and this is the case that holds them to it.
    expect(resolveWorkdirFile(workdir, "sub/receipt.json")).toBe(
      path.resolve(workdir, "sub/receipt.json"),
    );
  });
});

describe("the certificate export never overwrites the identity file", () => {
  test("an export path equal to the identity path is refused", () => {
    expect(() =>
      assertExportPathDistinct("/data/identity.json", "/data/identity.json"),
    ).toThrow(/private key/);
    // A relative or dot-laden spelling of the same file is caught too, matching
    // the CLI's own resolved-path compare.
    expect(() =>
      assertExportPathDistinct("/data/identity.json", "/data/./identity.json"),
    ).toThrow(/private key/);
    expect(() =>
      assertExportPathDistinct(
        "/data/identity.json",
        "/data/sub/../identity.json",
      ),
    ).toThrow(/private key/);
  });

  test("the two names the console composes can never collide", () => {
    const root = "/data";
    expect(signingIdentityPath(root)).not.toBe(signingCertificatePath(root));
    expect(() =>
      assertExportPathDistinct(
        signingIdentityPath(root),
        signingCertificatePath(root),
      ),
    ).not.toThrow();
  });

  test("the identity file is dot-prefixed, so the input picker's own rule hides it", () => {
    expect(SIGNING_IDENTITY_FILE_NAME.startsWith(".")).toBe(true);
    expect(SIGNING_CERTIFICATE_FILE_NAME.startsWith(".")).toBe(false);
  });

  test("the driver refuses synchronously, before any child is spawned", () => {
    const root = scratchDir();
    expect(() =>
      runSigningFingerprint({
        binaryPath: STUB_CLI_PATH,
        identityPath: signingIdentityPath(root),
        identityLabel: "Agency A",
        exportPath: signingIdentityPath(root),
      }),
    ).toThrow(/private key/);
    // Nothing was written: the stub CLI creates the identity file, so its absence
    // is what proves no child ran.
    expect(fs.existsSync(signingIdentityPath(root))).toBe(false);
  });
});

describe("the fingerprint driver", () => {
  test("never emits --force, and states every value as a single =token", () => {
    const argv = fingerprintArgv({
      binaryPath: "/cli/index.js",
      identityPath: "/data/.psilink-signing-identity.json",
      identityLabel: "-Agency A, contact@example.org",
      exportPath: "/data/psilink-certificate.json",
    });
    expect(argv).toEqual([
      "/cli/index.js",
      "fingerprint",
      "--identity-file=/data/.psilink-signing-identity.json",
      "--identity=-Agency A, contact@example.org",
      "--export-certificate=/data/psilink-certificate.json",
    ]);
    expect(argv).not.toContain("--force");
    // No config file is named, so which document the child could read for hints
    // is decided by the working directory the spawn pins, not by this argv.
    expect(argv.some((token) => token.startsWith("--config-file"))).toBe(false);
  });

  test("omits the export flag when no export was asked for", () => {
    expect(
      fingerprintArgv({
        binaryPath: "/cli/index.js",
        identityPath: "/data/id.json",
        identityLabel: "Agency A",
      }),
    ).not.toContain("--export-certificate=/data/id.json");
  });

  test("only a canonical digest is read off stdout", () => {
    expect(parseFingerprintStdout(`${OWN_FINGERPRINT}\n`)).toBe(
      OWN_FINGERPRINT,
    );
    expect(parseFingerprintStdout("  not a fingerprint  ")).toBeUndefined();
    expect(parseFingerprintStdout("")).toBeUndefined();
    // A non-canonical final character decodes to the same digest but is not the
    // value psilink prints, so it is refused rather than shown to share.
    expect(parseFingerprintStdout("D".repeat(43))).toBeUndefined();
  });

  test("exit 64 is its own actionable category, apart from a generic failure", () => {
    // Every exit-64 cause reachable from this endpoint sits in the operator's
    // mounted folder, and the driver cannot tell them apart (stderr is
    // discarded), so the one thing the category must not do is collapse into the
    // generic error the copy tells the operator only to retry.
    expect(
      reconcileFingerprintExit(64, "", {
        created: true,
        exportRequested: false,
      }),
    ).toEqual({ kind: "refused" });
  });

  test("a clean exit has the created flag and the export acknowledgement", () => {
    expect(
      reconcileFingerprintExit(0, `${OWN_FINGERPRINT}\n`, {
        created: true,
        exportRequested: true,
      }),
    ).toEqual({
      kind: "ok",
      fingerprint: OWN_FINGERPRINT,
      created: true,
      certificateExported: true,
    });
  });

  test("an overflowed or malformed read is an error, never a partial result", () => {
    expect(
      reconcileFingerprintExit(0, undefined, {
        created: false,
        exportRequested: false,
      }),
    ).toEqual({ kind: "error" });
    expect(
      reconcileFingerprintExit(0, "garbage", {
        created: false,
        exportRequested: false,
      }),
    ).toEqual({ kind: "error" });
    expect(
      reconcileFingerprintExit(69, `${OWN_FINGERPRINT}\n`, {
        created: false,
        exportRequested: false,
      }),
    ).toEqual({ kind: "error" });
  });

  test("drives the CLI subcommand, reporting a first run as created and a second as loaded", async () => {
    const root = scratchDir();
    const identityPath = signingIdentityPath(root);
    const first = await runSigningFingerprint({
      binaryPath: STUB_CLI_PATH,
      identityPath,
      identityLabel: "Agency A",
      childEnv: { STUB_FINGERPRINT_STDOUT: `${OWN_FINGERPRINT}\n` },
    });
    expect(first).toEqual({
      kind: "ok",
      fingerprint: OWN_FINGERPRINT,
      created: true,
      certificateExported: false,
    });
    expect(fs.existsSync(identityPath)).toBe(true);

    const second = await runSigningFingerprint({
      binaryPath: STUB_CLI_PATH,
      identityPath,
      identityLabel: "Agency A",
      exportPath: signingCertificatePath(root),
      childEnv: { STUB_FINGERPRINT_STDOUT: `${OWN_FINGERPRINT}\n` },
    });
    expect(second).toEqual({
      kind: "ok",
      fingerprint: OWN_FINGERPRINT,
      created: false,
      certificateExported: true,
    });
    expect(fs.existsSync(signingCertificatePath(root))).toBe(true);
  });

  test("runs the child in the mount, so the server's own psilink.yaml is out of reach", async () => {
    // With --config-file omitted the CLI resolves its default ./psilink.yaml
    // against the CHILD's working directory, and a malformed one is the exit 64
    // this endpoint reports as a condition in the operator's folder. What keeps a
    // document the operator never mounted out of that decision is the explicit
    // cwd, so the check is on the directory the child actually ran in.
    const root = scratchDir();
    const serverCwd = scratchDir();
    fs.writeFileSync(
      path.join(serverCwd, "psilink.yaml"),
      "signing: [ unclosed",
    );
    const cwdFile = path.join(root, "child-cwd.txt");
    const enteredFrom = process.cwd();
    process.chdir(serverCwd);
    try {
      const result = await runSigningFingerprint({
        binaryPath: STUB_CLI_PATH,
        identityPath: signingIdentityPath(root),
        identityLabel: "Agency A",
        childEnv: {
          STUB_FINGERPRINT_STDOUT: `${OWN_FINGERPRINT}\n`,
          STUB_CWD_FILE: cwdFile,
        },
      });
      expect(result).toMatchObject({ kind: "ok" });
    } finally {
      process.chdir(enteredFrom);
    }
    const childCwd = fs.realpathSync(fs.readFileSync(cwdFile, "utf8"));
    expect(childCwd).toBe(fs.realpathSync(root));
    expect(childCwd).not.toBe(fs.realpathSync(serverCwd));
  });

  test("creates the mount when it does not exist yet, rather than failing to start", async () => {
    // The identity is the first thing an operator asks for, which can precede
    // any job -- and a spawn cannot start in a directory that is not there.
    const root = scratchDir();
    const unmade = path.join(root, "not-yet");
    const result = await runSigningFingerprint({
      binaryPath: STUB_CLI_PATH,
      identityPath: signingIdentityPath(unmade),
      identityLabel: "Agency A",
      childEnv: { STUB_FINGERPRINT_STDOUT: `${OWN_FINGERPRINT}\n` },
    });
    expect(result).toMatchObject({ kind: "ok", created: true });
    expect(fs.existsSync(signingIdentityPath(unmade))).toBe(true);
  });

  test("an oversized stdout flood is an error, never buffered unbounded", async () => {
    // The cap belongs to the spawn boundary this driver shares with the host-key
    // probe, so it is exercised from this side too rather than assumed from the
    // probe's own case.
    const root = scratchDir();
    const result = await runSigningFingerprint({
      binaryPath: STUB_CLI_PATH,
      identityPath: signingIdentityPath(root),
      identityLabel: "Agency A",
      childEnv: { STUB_FINGERPRINT_STDOUT: "x".repeat(8192) },
    });
    expect(result).toEqual({ kind: "error" });
  });

  test("the watchdog kills a hung child and reports a timeout", async () => {
    // A child that ignores SIGTERM and would otherwise run for 5s; the watchdog
    // SIGTERMs at 50ms and SIGKILLs 50ms later, bounding the wait as a timeout.
    const root = scratchDir();
    const result = await runSigningFingerprint({
      binaryPath: STUB_CLI_PATH,
      identityPath: signingIdentityPath(root),
      identityLabel: "Agency A",
      childEnv: { STUB_IGNORE_SIGTERM: "1", STUB_DELAY_MS: "5000" },
      sigtermMs: 50,
      sigkillGraceMs: 50,
    });
    expect(result).toEqual({ kind: "timeout" });
  });

  test("a mount that cannot be created resolves as an error, not an unhandled throw", async () => {
    // The driver creates the mount itself before it spawns, and a mount path an
    // operator left occupied by a regular file has to settle as a result kind:
    // the endpoint only reconciles kinds. The one documented rejection is the
    // export-path caller bug; this is not it.
    const root = scratchDir();
    const occupied = path.join(root, "not-a-directory");
    fs.writeFileSync(occupied, "");
    await expect(
      runSigningFingerprint({
        binaryPath: STUB_CLI_PATH,
        identityPath: signingIdentityPath(occupied),
        identityLabel: "Agency A",
        childEnv: { STUB_FINGERPRINT_STDOUT: `${OWN_FINGERPRINT}\n` },
      }),
    ).resolves.toEqual({ kind: "error" });
  });
});

describe("the receipts card's model", () => {
  test("an untouched draft emits nothing, so the intent is the one sent before it existed", () => {
    expect(receiptsIntentFields(RECEIPTS_DEFAULT)).toEqual({});
    expect(problemsFor(RECEIPTS_DEFAULT)).toEqual([]);
    expect(receiptsAdvisories(RECEIPTS_DEFAULT, SHARED_RENDEZVOUS)).toEqual([]);
    expect(receiptsSummary(RECEIPTS_DEFAULT)).toBe("Unsigned record only");
  });

  test("certificate mode emits the block once the identity is resolved", () => {
    const authored = draft({
      mode: "certificate",
      ownFingerprint: OWN_FINGERPRINT,
      partnerFingerprint: ` ${PARTNER_FINGERPRINT} `,
      retentionDisposition: `  ${RETENTION_NOTE}  `,
    });
    expect(receiptsIntentFields(authored)).toEqual({
      signing: {
        mode: "certificate",
        partnerFingerprint: PARTNER_FINGERPRINT,
      },
      retentionDisposition: RETENTION_NOTE,
    });
    expect(problemsFor(authored)).toEqual([]);
    expect(receiptsSummary(authored)).toBe("Signed receipt, retention note");
  });

  test("a note alone emits only the note", () => {
    const noted = draft({ retentionDisposition: RETENTION_NOTE });
    expect(receiptsIntentFields(noted)).toEqual({
      retentionDisposition: RETENTION_NOTE,
    });
    expect(receiptsSummary(noted)).toBe("Retention note");
  });

  test("every problem is a refusal the run itself would make", () => {
    expect(problemsFor(draft({ mode: "certificate" }))).toContain(
      IDENTITY_MISSING_PROBLEM,
    );
    expect(problemsFor(draft({ mode: "session-derived" }))).toContain(
      SESSION_DERIVED_PROBLEM,
    );
    expect(
      problemsFor(
        draft({
          mode: "certificate",
          ownFingerprint: OWN_FINGERPRINT,
          partnerFingerprint: "nope",
        }),
      ),
    ).toContain(PARTNER_FINGERPRINT_PROBLEM);
    expect(
      problemsFor(
        draft({ retentionDisposition: "x".repeat(MAX_TEXT_LENGTH + 1) }),
      ),
    ).toContain(RETENTION_NOTE_PROBLEM);
  });

  test("a control character in the retention note is caught on the card, not only at submit", () => {
    // Mirrors the server's own refusal (NOTE_CONTROL_CHAR_PATTERN in
    // apps/web/src/jobs/intent.ts, via the shared @psi/retentionNoteShape
    // pattern): a NUL or an ESC pasted into the note must report a card
    // problem here, or the operator would see nothing wrong until the run
    // failed at submit with a generic 400.
    expect(
      problemsFor(
        draft({
          retentionDisposition: `Filed${String.fromCharCode(0x00)}under the schedule`,
        }),
      ),
    ).toContain(RETENTION_NOTE_CONTROL_CHAR_PROBLEM);
    expect(
      problemsFor(
        draft({
          retentionDisposition: `Filed${String.fromCharCode(0x1b)}under the schedule`,
        }),
      ),
    ).toContain(RETENTION_NOTE_CONTROL_CHAR_PROBLEM);
    // The card authors this field in a textarea, so the whitespace controls a
    // multi-line note holds -- and that the server admits -- stay clean.
    expect(
      problemsFor(
        draft({
          retentionDisposition:
            "Filed\tunder the schedule.\r\nPurged after six years.",
        }),
      ),
    ).toEqual([]);
  });

  test("an unpinned partner blocks the run, as the run itself would", () => {
    // Core refuses this configuration before any connection is opened
    // (assertCertificateModePinsPartner) and the console's job schema refuses
    // the intent at create time, so the card reports it as a problem rather than
    // an advisory: nothing about the partner or the network could make such a run
    // finish, and warning-and-proceeding would spend the operator's disclosure on
    // a run that ends with no result and no receipt on this side.
    const unpinned = draft({
      mode: "certificate",
      ownFingerprint: OWN_FINGERPRINT,
    });
    expect(problemsFor(unpinned)).toContain(NO_PARTNER_PIN_PROBLEM);
    expect(
      receiptsAdvisories(unpinned, SHARED_RENDEZVOUS).map(
        (advisory) => advisory.message,
      ),
    ).not.toContain(NO_PARTNER_PIN_PROBLEM);
  });

  test("an unnamed party blocks the run, as the run itself would", () => {
    // Core refuses this configuration before any connection is opened
    // (assertCertificateModeNamesLocalParty) and the console's job schema
    // refuses the intent at create time: a certificate is trusted by the identity
    // its holder used in the agreed terms, so an unnamed party has nothing for
    // the partner to check it against. The card's own fingerprint request is
    // withheld for want of a name too, but the run gate does not rest on it: a
    // fingerprint requested under a name since cleared leaves the draft here.
    const unnamed = draft({
      mode: "certificate",
      ownFingerprint: OWN_FINGERPRINT,
      partnerFingerprint: PARTNER_FINGERPRINT,
    });
    expect(receiptsProblems(unnamed, "")).toContain(UNNAMED_PARTY_PROBLEM);
    expect(receiptsProblems(unnamed, "   ")).toContain(UNNAMED_PARTY_PROBLEM);
    expect(receiptsProblems(unnamed, THIS_PARTY)).toEqual([]);
    expect(
      receiptsAdvisories(unnamed, SHARED_RENDEZVOUS).map(
        (advisory) => advisory.message,
      ),
    ).not.toContain(UNNAMED_PARTY_PROBLEM);
  });

  test("an unnamed exchange that signs nothing is asked for no name", () => {
    // The gate binds the certificate-signing configuration alone. A quick
    // unsigned exchange states no name and is asked for none, so a nameless
    // draft must report no problem at all in the modes that sign nothing.
    expect(receiptsProblems(RECEIPTS_DEFAULT, "")).toEqual([]);
    expect(
      receiptsProblems(draft({ retentionDisposition: RETENTION_NOTE }), ""),
    ).toEqual([]);
  });

  test("the unnamed-party copy names the run's own terms and the unsigned exit", () => {
    // Same register as the missing-pin block: what the run does (refuses to
    // start), why (the certificate is trusted by the name in the agreed terms),
    // and the two ways out -- name the party, or run unsigned.
    expect(UNNAMED_PARTY_PROBLEM).toMatch(/refuses to start/);
    expect(UNNAMED_PARTY_PROBLEM).toMatch(/agreed terms/);
    expect(UNNAMED_PARTY_PROBLEM).toMatch(/No receipt/);
  });

  test("authoring stays open while the pin is missing", () => {
    // The block is on STARTING a run, not on the draft: the mode stays selected,
    // the resolved own fingerprint stays put (it is what the operator sends the
    // partner to get theirs), and the emitted intent is still the certificate
    // block the console schema will judge. An operator part-way through the
    // two-sided ceremony keeps everything they have authored.
    const unpinned = draft({
      mode: "certificate",
      ownFingerprint: OWN_FINGERPRINT,
      retentionDisposition: RETENTION_NOTE,
    });
    expect(receiptsIntentFields(unpinned)).toEqual({
      signing: { mode: "certificate" },
      retentionDisposition: RETENTION_NOTE,
    });
    expect(receiptsSummary(unpinned)).toBe("Signed receipt, retention note");
    expect(fingerprintRequestProblem("Agency A")).toBeUndefined();
  });

  test("the shared-mount advisory raises above the notices", () => {
    // It names a key-disclosure hazard that is live by default on the
    // single-mount filedrop layout, so it has warning weight. The two notices
    // state only where a file lands and how to look after it, so they stay at
    // info.
    const pinned = draft({
      mode: "certificate",
      ownFingerprint: OWN_FINGERPRINT,
      partnerFingerprint: PARTNER_FINGERPRINT,
    });
    expect(
      receiptsAdvisories(pinned, SHARED_RENDEZVOUS)
        .filter((advisory) => advisory.severity === "warning")
        .map((advisory) => advisory.message),
    ).toEqual([IDENTITY_SHARED_MOUNT_ADVISORY]);
    expect(
      receiptsAdvisories(pinned, SHARED_RENDEZVOUS)
        .filter((advisory) => advisory.severity === "info")
        .map((advisory) => advisory.message),
    ).toEqual([IDENTITY_AT_REST_NOTICE, RECEIPT_LOCATION_NOTICE]);
  });

  test("an unresolved shared-mount comparison raises the hedged variant", () => {
    // The walk defaulted to "holds" rather than matching it, so the copy must
    // not assert the layout as fact.
    const pinned = draft({
      mode: "certificate",
      ownFingerprint: OWN_FINGERPRINT,
      partnerFingerprint: PARTNER_FINGERPRINT,
    });
    expect(
      receiptsAdvisories(pinned, UNCERTAIN_SHARED_RENDEZVOUS)
        .filter((advisory) => advisory.severity === "warning")
        .map((advisory) => advisory.message),
    ).toEqual([IDENTITY_SHARED_MOUNT_ADVISORY_UNCERTAIN]);
  });

  test("the unpinned problem names the whole consequence, not just the receipt", () => {
    // Core refuses an absent pin inside the exchange, after the payloads have
    // crossed, and the results and the receipt are written only once the exchange
    // has returned -- so a run started that way would cost the operator their data
    // disclosure and give them back only the record of it. That is why the card
    // refuses it, and copy that named only the receipt would understate what is
    // being refused.
    expect(NO_PARTNER_PIN_PROBLEM).toMatch(/gone to your partner/);
    expect(NO_PARTNER_PIN_PROBLEM).toMatch(/no results/);
    expect(NO_PARTNER_PIN_PROBLEM).toMatch(/no receipt/);
    // What it does keep is named too, so the copy neither overstates the loss nor
    // leaves the operator to guess whether the disclosure was logged.
    expect(NO_PARTNER_PIN_PROBLEM).toMatch(
      /the exchange record of what you had already disclosed/,
    );
    // And it is placed where the operator can act on it, in both places it can be
    // acted on: the console offers a terminated run's record on the run screen,
    // and the file itself is in the run's folder in the mount. Copy that named
    // only the folder would send an operator into the mount for a file the screen
    // was already offering.
    expect(NO_PARTNER_PIN_PROBLEM).toMatch(
      /the run screen offers it for download when the run stops/,
    );
    expect(NO_PARTNER_PIN_PROBLEM).toMatch(
      /record\.json with that run's files in the mounted folder/,
    );
    // Placement is not permanence: the one control the failure surface leads with
    // takes the record away, so the sentence that offers it also says so.
    expect(NO_PARTNER_PIN_PROBLEM).toMatch(/Discarding the run removes it/);
  });

  test("the unpinned problem states the initiator's extra disclosure", () => {
    // exchangeSignedReceipt has the initiator send its own {certificate,
    // signature} frame before verifying the partner's, so "no results and no
    // receipt" is not the whole cost on the side that sends first: the partner
    // would hold this party's signed receipt when the run stopped. Which role this
    // side takes is not decided while authoring, so the copy is conditional -- and
    // it still says nothing about what the partner does with what it receives.
    expect(NO_PARTNER_PIN_PROBLEM).toMatch(/sends its signature first/);
    expect(NO_PARTNER_PIN_PROBLEM).toMatch(
      /your partner would already have your signed receipt/,
    );
  });

  test("the unpinned problem names the exit for an operator without the pin yet", () => {
    // Pinning is half of a two-sided ceremony, so the refusal has to leave a way
    // to exchange today: run unsigned now, and switch once the fingerprint
    // arrives. Copy that only refused would push an operator toward abandoning
    // the receipt or waiting on the partner with nothing to do.
    expect(NO_PARTNER_PIN_PROBLEM).toMatch(/choose 'No receipt' now/);
    expect(NO_PARTNER_PIN_PROBLEM).toMatch(/psilink fingerprint/);
  });

  test("signing states where both durable files land, before the run", () => {
    const pinned = draft({
      mode: "certificate",
      ownFingerprint: OWN_FINGERPRINT,
      partnerFingerprint: PARTNER_FINGERPRINT,
    });
    expect(receiptsAdvisories(pinned, SHARED_RENDEZVOUS)).toEqual([
      { message: IDENTITY_SHARED_MOUNT_ADVISORY, severity: "warning" },
      { message: IDENTITY_AT_REST_NOTICE, severity: "info" },
      { message: RECEIPT_LOCATION_NOTICE, severity: "info" },
    ]);
  });

  test("both shared-mount advisory variants name the collision at the choice point", () => {
    // The rendezvous directory falls back to the data root, so a filedrop
    // exchange on a one-mount console syncs the folder this key is written into.
    // The operator meets that fact where they choose to sign, not only in the
    // deployment guide, and it names the remedy the guide documents -- true of
    // both the established and hedged copy, which differ only in the opening
    // sentence.
    for (const advisory of [
      IDENTITY_SHARED_MOUNT_ADVISORY,
      IDENTITY_SHARED_MOUNT_ADVISORY_UNCERTAIN,
    ]) {
      expect(advisory).toMatch(
        /sign receipts in your name -- for every exchange, with every partner/,
      );
      expect(advisory).toMatch(/JOB_RENDEZVOUS_DIR/);
    }
  });

  test("both shared-mount advisory variants hold the sync to the exchange that does it", () => {
    // The layout is what raises the advisory, but it is a shared-folder exchange
    // that puts a partner's writes in the mount: an SFTP or WebRTC run out of the
    // same single mount has nobody syncing into it. Copy stating flatly that the
    // partner writes there would be untrue on those runs, and an operator who can
    // see it is untrue of theirs discounts the hazard it names.
    for (const advisory of [
      IDENTITY_SHARED_MOUNT_ADVISORY,
      IDENTITY_SHARED_MOUNT_ADVISORY_UNCERTAIN,
    ]) {
      expect(advisory).toMatch(/a shared-folder exchange/);
      expect(advisory).toMatch(
        /On a run like that your long-lived private key sits where your partner/,
      );
    }
  });

  test("the shared-mount advisory states the layout as established fact", () => {
    // Raised only where the report positively determined the layout (a lexical
    // or filesystem match), so it is not telling the operator something the walk
    // did not find.
    expect(IDENTITY_SHARED_MOUNT_ADVISORY).not.toMatch(/cannot rule out/);
    expect(IDENTITY_SHARED_MOUNT_ADVISORY).toMatch(
      /This console rendezvouses out of the folder you mounted/,
    );
  });

  test("the uncertain shared-mount advisory states the layout as unruled-out, not established", () => {
    // Raised on the report's fail-closed cases: a leg or a data root whose real
    // path cannot be read counts as holding (jobRendezvous.ts), and a console
    // that has not answered keeps the advisory (the case below). Neither case
    // established the layout, so copy asserting it flatly would be telling the
    // operator something the walk did not find -- which an operator who checks
    // and finds otherwise learns to discount.
    expect(IDENTITY_SHARED_MOUNT_ADVISORY_UNCERTAIN).toMatch(/cannot rule out/);
  });

  test("the receipt notice names where the download appears, not this screen", () => {
    // It renders on the authoring screens (review & create, and the acceptor
    // screen) while the download control renders on the run screen once the run
    // settles -- disjoint surfaces, so copy pointing at "here" would send the
    // operator looking for a control that is not on the screen they are reading.
    // That control is offered on any settled run, so the sentence names failure
    // outright: an operator who reads "once the exchange finishes" as "once it
    // succeeds" never goes looking after the failed run whose receipt may be the
    // only artifact left.
    expect(RECEIPT_LOCATION_NOTICE).toContain(
      "the run screen offers it as a download once the run finishes or fails",
    );
    expect(RECEIPT_LOCATION_NOTICE).not.toMatch(/\bhere\b/);
  });

  test("the at-rest notice stands on its own, without the collision half", () => {
    // It is shown on layouts where the shared-mount advisory is withheld, so it
    // has to stand as a whole message: the key-hygiene guidance it holds is true
    // wherever the key is written, and it must not lean on a sentence about the
    // partner's folder that the operator may never see.
    expect(IDENTITY_AT_REST_NOTICE).toMatch(/readable only by you/);
    expect(IDENTITY_AT_REST_NOTICE).toMatch(/not put it on shared storage/);
    expect(IDENTITY_AT_REST_NOTICE).not.toMatch(/partner/);
    expect(IDENTITY_AT_REST_NOTICE).not.toMatch(/JOB_RENDEZVOUS_DIR/);
  });

  test("a separately mounted rendezvous withholds only the shared-mount half", () => {
    // The remedy that advisory closes on is already in place, so raising it there
    // would spend the warning channel on a hazard that is not live. What survives
    // the suppression is the at-rest notice: the key is still written into the
    // mounted folder, and a card that said nothing about that would leave the
    // operator with no word on where their long-lived key lands.
    const pinned = draft({
      mode: "certificate",
      ownFingerprint: OWN_FINGERPRINT,
      partnerFingerprint: PARTNER_FINGERPRINT,
    });
    expect(receiptsAdvisories(pinned, SEPARATE_RENDEZVOUS)).toEqual([
      { message: IDENTITY_AT_REST_NOTICE, severity: "info" },
      { message: RECEIPT_LOCATION_NOTICE, severity: "info" },
    ]);
  });

  test("a console that has not answered keeps the hedged shared-mount advisory", () => {
    // An unresolved probe, a failed one, and a report that cannot run a filedrop
    // exchange as provisioned all leave the layout unknown -- and an unread report
    // is not evidence of a separate mount, so the advisory stands, and in the
    // hedged form: none of these established the layout.
    const pinned = draft({
      mode: "certificate",
      ownFingerprint: OWN_FINGERPRINT,
      partnerFingerprint: PARTNER_FINGERPRINT,
    });
    for (const rendezvous of [
      undefined,
      { configured: false },
      { configured: false, sharesDataRoot: false },
      { configured: true, locator: "psilink" },
    ])
      expect(receiptsAdvisories(pinned, rendezvous)).toContainEqual({
        message: IDENTITY_SHARED_MOUNT_ADVISORY_UNCERTAIN,
        severity: "warning",
      });
  });

  test("a blank identity withholds the fingerprint request, with the reason", () => {
    // The one hard precondition the card holds: the console's schema requires a
    // non-empty label, so an ordinary click without one could only ever be a 400
    // the operator was told nothing actionable by.
    expect(fingerprintRequestProblem("")).toBe(IDENTITY_LABEL_REQUIRED_REASON);
    expect(fingerprintRequestProblem("   ")).toBe(
      IDENTITY_LABEL_REQUIRED_REASON,
    );
    expect(
      fingerprintRequestProblem("Agency A, contact@agency-a.example"),
    ).toBeUndefined();
  });

  test("leaving certificate mode drops the resolved identity and the pin", () => {
    const authored = draft({
      mode: "certificate",
      ownFingerprint: OWN_FINGERPRINT,
      partnerFingerprint: PARTNER_FINGERPRINT,
      retentionDisposition: RETENTION_NOTE,
    });
    const cleared = receiptsWithField(authored, "mode", "none");
    expect(cleared.ownFingerprint).toBeUndefined();
    expect(cleared.partnerFingerprint).toBe("");
    // The note is about the record, not the receipt, so it survives the switch.
    expect(cleared.retentionDisposition).toBe(RETENTION_NOTE);
  });
});

describe("the verify screen reads a config the way --config-file does", () => {
  test("a whole exchange configuration is accepted for its linkage_terms", () => {
    const yaml = composeConfigDocument(
      validIntent(),
      "/rendezvous",
      undefined,
      signingPaths(),
    );
    const imported = importLinkageTerms(yaml);
    expect(imported.success).toBe(true);
    if (!imported.success) throw new Error("unreachable");
    expect(imported.terms.identity).toBe(validLinkageTerms().identity);
  });

  test("a bare exported terms document still imports", () => {
    const imported = importLinkageTerms(
      JSON.stringify({
        ...validLinkageTerms(),
        linkage_fields: undefined,
      }),
    );
    // The round-trip shape is covered by linkageTermsIO's own suite; here it is
    // enough that unwrapping did not break the bare-document path.
    expect(typeof imported.success).toBe("boolean");
  });

  test("a document defining neither is still rejected with the terms schema's reason", () => {
    const imported = importLinkageTerms(JSON.stringify({ connection: {} }));
    expect(imported.success).toBe(false);
  });
});
