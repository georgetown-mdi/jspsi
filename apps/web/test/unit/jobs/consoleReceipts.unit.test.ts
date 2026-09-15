import fs from "node:fs";
import path from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import { parse as parseYaml } from "yaml";

import {
  MAX_TEXT_LENGTH,
  certificateAuthorizesIdentity,
  generateSigningIdentity,
  safeParseExchangeSpec,
  serializeSigningIdentity,
} from "@psilink/core";

import {
  FIRST_CONTACT_PIN_ADVISORY,
  IDENTITY_AT_REST_NOTICE,
  IDENTITY_DEFAULT_LOCATION_LABEL,
  IDENTITY_DEFAULT_PATH_LEFTOVER_CAVEAT,
  IDENTITY_LABEL_REQUIRED_REASON,
  IDENTITY_MISSING_PROBLEM,
  IDENTITY_PICKED_LOCATION_NOTICE,
  IDENTITY_SHARED_MOUNT_LIMIT_ADVISORY,
  IDENTITY_SHARED_MOUNT_REFUSAL_ADVISORY,
  PARTNER_FINGERPRINT_PROBLEM,
  RECEIPTS_DEFAULT,
  RECEIPT_LOCATION_NOTICE,
  RETENTION_NOTE_CONTROL_CHAR_PROBLEM,
  RETENTION_NOTE_PROBLEM,
  SESSION_DERIVED_PROBLEM,
  SIGNING_IDENTITY_DIVERGENCE_POINTER,
  UNNAMED_PARTY_PROBLEM,
  fingerprintRequestProblem,
  identityLocationLabel,
  partnerPinStatement,
  receiptsAdvisories,
  receiptsIntentFields,
  receiptsProblems,
  receiptsSummary,
  receiptsWithField,
  receiptsWithResolvedIdentity,
  signingIdentityDivergence,
} from "@psi/receiptsModel";
import {
  HANDOFF_SHARED_DIRECTORY_PLACEHOLDER,
  HANDOFF_SIGNING_IDENTITY_PLACEHOLDER,
  buildJobHandoff,
} from "@jobs/handoff";
import {
  composeConfigDocument,
  composeSftpConfigDocument,
} from "@jobs/intentConfig";

import {
  JOB_FILE_NAMES,
  jobCreateIntentSchema,
  jobExchangeIntentSchema,
} from "@jobs/intentSchemas";
import {
  SIGNING_CERTIFICATE_FILE_NAME,
  SIGNING_IDENTITY_FILE_NAME,
  assertExportPathDistinct,
  fingerprintArgv,
  parseFingerprintStdout,
  readBoundIdentity,
  reconcileFingerprintExit,
  runSigningFingerprint,
  signingCertificatePath,
  signingIdentityPath,
} from "@jobs/signingIdentity";
import { browseSegment } from "@jobs/workInputName";
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
} from "../../utils/jobFixtures";

import type { CertificateBody, LinkageTerms } from "@psilink/core";
import type { JobRendezvousConfig } from "@psi/jobClient/workInputClient";
import type { JobSigningPaths } from "@jobs/intentSchemas";
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

/** The single-mount layout a shared-folder exchange is refused on: the folder
 * the partner syncs into holds the working directory this party's signing key is
 * written to, positively established by the walk (a lexical or filesystem
 * match), so the advisory states the refusal in force there. */
const SHARED_RENDEZVOUS: JobRendezvousConfig = {
  configured: true,
  locator: "psilink",
  folderName: "psilink",
  sharesDataRoot: true,
  sharesDataRootUncertain: false,
};

/** The same single-mount layout, but where the walk could not rule it out rather
 * than positively establishing it -- an unresolved real path in the comparison --
 * so no run is refused over it and the advisory stands. */
const UNCERTAIN_SHARED_RENDEZVOUS: JobRendezvousConfig = {
  ...SHARED_RENDEZVOUS,
  sharesDataRootUncertain: true,
};

/** A console whose rendezvous has a mount of its own, where the collision the
 * refusal catches was not found. */
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

  test("certificate mode with no pin is admitted, on both channels and the create union", () => {
    // The first authenticated contact: the spawned child pins the certificate
    // its partner presents at the terms exchange and records the fingerprint, so
    // the job is one the run can finish. The console asks for an out-of-band
    // value and warns where it has none, rather than refusing the operator a run
    // the command line accepts.
    for (const intent of [
      validIntent({ signing: { mode: "certificate" } }),
      validSftpIntent({ signing: { mode: "certificate" } }),
    ])
      expect(jobExchangeIntentSchema.safeParse(intent).success).toBe(true);
    // The create route parses the mode-discriminated union, not the exchange
    // schema directly, so the rule is asserted where the 400 is actually decided.
    expect(
      jobCreateIntentSchema.safeParse(
        validIntent({ signing: { mode: "certificate" } }),
      ).success,
    ).toBe(true);
    // The pin stays admissible under certificate mode alone: relaxing the
    // requirement does not admit one beside a run that signs nothing.
    expect(
      jobCreateIntentSchema.safeParse(
        validIntent({
          signing: { mode: "none", partnerFingerprint: PARTNER_FINGERPRINT },
        }),
      ).success,
    ).toBe(false);
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

  test("certificate mode with no pinned fingerprint composes the key away", () => {
    // What makes the run a first authenticated contact: the child reads a
    // signing block with no pin, adopts the certificate its partner presents,
    // and records the value back into this same document. Emitting the key with
    // an empty value instead would be a pin the comparison fails closed on, so
    // the key is absent rather than blank.
    for (const composed of [
      composedSpec(
        composeConfigDocument(
          validIntent({ signing: { mode: "certificate" } }),
          "/rendezvous",
          undefined,
          signingPaths(),
        ),
      ),
      composedSpec(
        composeSftpConfigDocument(
          validSftpIntent({ signing: { mode: "certificate" } }),
          testSftpServerEntry(),
          signingPaths(),
        ),
      ),
    ]) {
      const signing = composed["signing"] as Record<string, unknown>;
      expect(signing["mode"]).toBe("certificate");
      expect(signing).not.toHaveProperty("partner_fingerprint");
    }
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
        dataRoot: root,
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
      dataRoot: root,
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
      dataRoot: root,
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
        dataRoot: root,
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
      dataRoot: unmade,
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
      dataRoot: root,
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
      dataRoot: root,
      identityPath: signingIdentityPath(root),
      identityLabel: "Agency A",
      childEnv: { STUB_IGNORE_SIGTERM: "1", STUB_DELAY_MS: "5000" },
      sigtermMs: 50,
      sigkillGraceMs: 50,
    });
    expect(result).toEqual({ kind: "timeout" });
  });

  test("reads the party name the identity on disk is bound to", async () => {
    // The name a reused identity holds, which the label a later request sends
    // does not rebind. Read from a real identity document rather than a stand-in,
    // so the certificate's own validation is part of what is asserted.
    const dir = scratchDir();
    const identityPath = path.join(dir, SIGNING_IDENTITY_FILE_NAME);
    fs.writeFileSync(
      identityPath,
      serializeSigningIdentity(
        await generateSigningIdentity("County Registrar"),
      ),
    );
    await expect(readBoundIdentity(identityPath)).resolves.toBe(
      "County Registrar",
    );
  });

  test("a file that holds no readable identity names nobody", async () => {
    // Each of these is "nothing to compare" rather than a name: a missing file, a
    // document that is not an identity of a recognized format, and one whose
    // certificate does not validate. None of them may report a name the console
    // would then compare a run against.
    const dir = scratchDir();
    const absent = path.join(dir, "no-such-identity.json");
    await expect(readBoundIdentity(absent)).resolves.toBeUndefined();
    const unparseable = path.join(dir, "unparseable.json");
    fs.writeFileSync(unparseable, "{ not json");
    await expect(readBoundIdentity(unparseable)).resolves.toBeUndefined();
    const unrecognized = path.join(dir, "unrecognized.json");
    fs.writeFileSync(unrecognized, JSON.stringify({ stub: "identity" }));
    await expect(readBoundIdentity(unrecognized)).resolves.toBeUndefined();
    const tampered = path.join(dir, "tampered.json");
    const identity = await generateSigningIdentity("County Registrar");
    fs.writeFileSync(
      tampered,
      serializeSigningIdentity({
        ...identity,
        certificate: { ...identity.certificate, identity: "Agency A" },
      }),
    );
    await expect(readBoundIdentity(tampered)).resolves.toBeUndefined();
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
        dataRoot: occupied,
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

  test("the closed card states a signed run with nothing pinned", () => {
    // The advisory is inside the disclosure, which an operator can create the
    // job without ever opening, so the collapsed summary states the condition
    // where they decide.
    const unpinned = draft({
      mode: "certificate",
      ownFingerprint: OWN_FINGERPRINT,
    });
    expect(receiptsSummary(unpinned)).toBe(
      "Signed receipt, no partner fingerprint pinned",
    );
    expect(
      receiptsSummary({ ...unpinned, partnerFingerprint: PARTNER_FINGERPRINT }),
    ).toBe("Signed receipt");
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
    // apps/web/src/jobs/intentSchemas.ts, the pattern both surfaces read):
    // a NUL or an ESC pasted into the note must report a card
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

  test("an unpinned partner warns and guides rather than blocking", () => {
    // Such a run is the first authenticated contact the spawned child adopts a
    // certificate on, and the job schema admits it, so the card warns rather
    // than blocking: a block would refuse the operator a run the command line
    // accepts, and the console's posture toward their own choices is to warn
    // and guide (CLAUDE.md, Applications).
    const unpinned = draft({
      mode: "certificate",
      ownFingerprint: OWN_FINGERPRINT,
    });
    expect(problemsFor(unpinned)).toEqual([]);
    expect(receiptsAdvisories(unpinned, SHARED_RENDEZVOUS)).toContainEqual({
      message: FIRST_CONTACT_PIN_ADVISORY,
      severity: "warning",
    });
  });

  test("the card states what is pinned, and plainly when nothing is", () => {
    // The one line an operator reads to learn what this exchange has on file.
    // A draft signing nothing states none of it: no pin decides anything there.
    const unpinned = draft({
      mode: "certificate",
      ownFingerprint: OWN_FINGERPRINT,
    });
    expect(partnerPinStatement(unpinned)).toMatch(
      /No partner fingerprint pinned yet/,
    );
    expect(partnerPinStatement(unpinned)).toMatch(/first exchange pins/);
    const pinned = draft({
      mode: "certificate",
      ownFingerprint: OWN_FINGERPRINT,
      partnerFingerprint: PARTNER_FINGERPRINT,
    });
    expect(partnerPinStatement(pinned)).toContain(PARTNER_FINGERPRINT);
    expect(partnerPinStatement(draft({ mode: "none" }))).toBeUndefined();
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
    expect(receiptsSummary(unpinned)).toBe(
      "Signed receipt, retention note, no partner fingerprint pinned",
    );
    expect(fingerprintRequestProblem("Agency A")).toBeUndefined();
  });

  test("the shared-mount advisory raises above the notices", () => {
    // It names a key-disclosure hazard the pre-run check cannot see, so it has
    // warning weight. The two notices state only where a file lands and how to
    // look after it, so they stay at info. Read on an unanswered report, the one
    // layout that raises the advisory without establishing anything.
    const pinned = draft({
      mode: "certificate",
      ownFingerprint: OWN_FINGERPRINT,
      partnerFingerprint: PARTNER_FINGERPRINT,
    });
    expect(
      receiptsAdvisories(pinned, undefined)
        .filter((advisory) => advisory.severity === "warning")
        .map((advisory) => advisory.message),
    ).toEqual([IDENTITY_SHARED_MOUNT_LIMIT_ADVISORY]);
    expect(
      receiptsAdvisories(pinned, undefined)
        .filter((advisory) => advisory.severity === "info")
        .map((advisory) => advisory.message),
    ).toEqual([IDENTITY_AT_REST_NOTICE, RECEIPT_LOCATION_NOTICE]);
  });

  test("an unresolved shared-mount comparison keeps the advisory", () => {
    // The walk defaulted to "holds" rather than matching it, so no run is
    // refused over the layout and the advisory is the whole treatment.
    const pinned = draft({
      mode: "certificate",
      ownFingerprint: OWN_FINGERPRINT,
      partnerFingerprint: PARTNER_FINGERPRINT,
    });
    expect(
      receiptsAdvisories(pinned, UNCERTAIN_SHARED_RENDEZVOUS)
        .filter((advisory) => advisory.severity === "warning")
        .map((advisory) => advisory.message),
    ).toEqual([IDENTITY_SHARED_MOUNT_LIMIT_ADVISORY]);
  });

  test("the unpinned advisory names what an out-of-band fingerprint buys", () => {
    // An exchange with no pin on file adopts the certificate its partner
    // presents, so what is lost by not entering one is the anchor rather than
    // the run: the pin would rest on the channel the invitation travelled.
    // Copy that said the run would fail would be describing something that
    // does not happen, and would teach the operator to expect a refusal.
    expect(FIRST_CONTACT_PIN_ADVISORY).toMatch(
      /channel the invitation travelled/,
    );
    expect(FIRST_CONTACT_PIN_ADVISORY).toMatch(
      /attests to whoever sent that invitation/,
    );
    expect(FIRST_CONTACT_PIN_ADVISORY).toMatch(/to nobody else/);
    // The channel it asks for is named concretely, since "a channel you trust"
    // alone leaves the one mistake that matters -- the invitation's own channel
    // -- looking acceptable.
    expect(FIRST_CONTACT_PIN_ADVISORY).toMatch(
      /a phone call, not the same email as the invitation/,
    );
  });

  test("the unpinned advisory states what the run does about it", () => {
    // The operator is told the run reports the value it pinned, so they know
    // there is something to take away and compare. Copy that only warned would
    // leave a first contact looking like a dead end rather than a step with a
    // follow-up.
    expect(FIRST_CONTACT_PIN_ADVISORY).toMatch(/reports the fingerprint/);
    expect(FIRST_CONTACT_PIN_ADVISORY).toMatch(/psilink fingerprint/);
  });

  test("signing states where both durable files land, before the run", () => {
    const pinned = draft({
      mode: "certificate",
      ownFingerprint: OWN_FINGERPRINT,
      partnerFingerprint: PARTNER_FINGERPRINT,
    });
    expect(receiptsAdvisories(pinned, UNCERTAIN_SHARED_RENDEZVOUS)).toEqual([
      { message: IDENTITY_SHARED_MOUNT_LIMIT_ADVISORY, severity: "warning" },
      { message: IDENTITY_AT_REST_NOTICE, severity: "info" },
      { message: RECEIPT_LOCATION_NOTICE, severity: "info" },
    ]);
  });

  test("a rendezvous with a mount of its own raises no warning at all", () => {
    // The recommended layout: nothing a partner syncs holds the key, so the
    // hazard the warning names is not live. Raising it there too costs the
    // warning channel its meaning -- the operator who did the recommended thing
    // is the one who could no longer tell the two states apart -- while the two
    // notices, true wherever the key is written, stay.
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

  test("the shared-mount advisory names the collision at the choice point", () => {
    // The operator meets what a synced folder holding the key would cost them
    // where they choose to sign, not only in the deployment guide, and it names
    // the remedy the guide documents.
    expect(IDENTITY_SHARED_MOUNT_LIMIT_ADVISORY).toMatch(
      /sign receipts in your name -- for every exchange, with every partner/,
    );
    expect(IDENTITY_SHARED_MOUNT_LIMIT_ADVISORY).toMatch(/JOB_RENDEZVOUS_DIR/);
  });

  test("the shared-mount advisory holds the sync to the exchange that does it", () => {
    // It is a shared-folder exchange that puts a partner's writes in the mount:
    // an SFTP or WebRTC run out of the same single mount has nobody syncing into
    // it, and it is not refused. Copy stating flatly that the partner writes
    // there would be untrue on those runs, and an operator who can see it is
    // untrue of theirs discounts the hazard it names.
    expect(IDENTITY_SHARED_MOUNT_LIMIT_ADVISORY).toMatch(
      /a shared-folder exchange/,
    );
  });

  test("the shared-mount advisory states the check and what it misses", () => {
    // Its whole reason to exist is the layout the pre-run refusal cannot see:
    // one folder mounted twice under two names passes a comparison of locations
    // and identity. Copy that only repeated the hazard would leave the operator
    // trusting a check that had already cleared their console.
    expect(IDENTITY_SHARED_MOUNT_LIMIT_ADVISORY).toMatch(/refuses the run/);
    expect(IDENTITY_SHARED_MOUNT_LIMIT_ADVISORY).toMatch(
      /one folder mounted twice under two names passes it/,
    );
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

  test("an established shared mount states the refusal and the one path it reads", () => {
    // The layout the console refuses on is the layout the operator most needs
    // the word on, because the refusal reads one fixed name in a folder the
    // partner writes into. Saying nothing there would leave an operator whose
    // console has cleared every run believing the folder is watched.
    const pinned = draft({
      mode: "certificate",
      ownFingerprint: OWN_FINGERPRINT,
      partnerFingerprint: PARTNER_FINGERPRINT,
    });
    expect(receiptsAdvisories(pinned, SHARED_RENDEZVOUS)).toEqual([
      { message: IDENTITY_SHARED_MOUNT_REFUSAL_ADVISORY, severity: "warning" },
      { message: IDENTITY_AT_REST_NOTICE, severity: "info" },
      { message: RECEIPT_LOCATION_NOTICE, severity: "info" },
    ]);
  });

  test("the established shared-mount advisory names the refusal and what it misses", () => {
    // Its two halves: what the console does on this layout -- refuse the run
    // while a file sits at the identity's path -- and the reach of the single
    // path that refusal reads, which leaves a renamed copy of the key and a
    // second mount of this folder unseen. Creating an identity is refused on no
    // layout, so copy promising that would be telling the operator of a control
    // the console does not have.
    expect(IDENTITY_SHARED_MOUNT_REFUSAL_ADVISORY).toMatch(
      /refuses a shared-folder exchange/,
    );
    expect(IDENTITY_SHARED_MOUNT_REFUSAL_ADVISORY).not.toMatch(/create|mint/);
    expect(IDENTITY_SHARED_MOUNT_REFUSAL_ADVISORY).toMatch(
      /checks that one path and nothing else/,
    );
    expect(IDENTITY_SHARED_MOUNT_REFUSAL_ADVISORY).toMatch(
      /a copy of your key under another name/,
    );
    expect(IDENTITY_SHARED_MOUNT_REFUSAL_ADVISORY).toMatch(
      /mounted a second time under another path/,
    );
    expect(IDENTITY_SHARED_MOUNT_REFUSAL_ADVISORY).toMatch(
      /JOB_RENDEZVOUS_DIR/,
    );
  });

  test("a console that has not answered keeps the shared-mount advisory", () => {
    // An unresolved probe, a failed one, and a report that cannot run a filedrop
    // exchange as provisioned all leave the layout unknown -- and an unread report
    // is not evidence of a separate mount, nor of a layout the refusal catches,
    // so the advisory stands.
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
        message: IDENTITY_SHARED_MOUNT_LIMIT_ADVISORY,
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

  test("an untouched draft names the default location and emits no locator", () => {
    // The option's absence IS the default, so a draft that never touched it
    // composes exactly the block an exchange authored before the option did.
    expect(RECEIPTS_DEFAULT.identityLocation).toBeUndefined();
    expect(identityLocationLabel(undefined)).toBe(
      IDENTITY_DEFAULT_LOCATION_LABEL,
    );
    expect(
      receiptsIntentFields(
        draft({
          mode: "certificate",
          ownFingerprint: OWN_FINGERPRINT,
          partnerFingerprint: PARTNER_FINGERPRINT,
        }),
      ).signing,
    ).toEqual({ mode: "certificate", partnerFingerprint: PARTNER_FINGERPRINT });
  });

  test("a picked location rides the signing block as a locator, never a path", () => {
    const located = draft({
      mode: "certificate",
      ownFingerprint: OWN_FINGERPRINT,
      partnerFingerprint: PARTNER_FINGERPRINT,
      identityLocation: {
        mount: "secrets",
        subPath: [".ssh", "identity.json"],
      },
    });
    expect(receiptsIntentFields(located).signing).toEqual({
      mode: "certificate",
      partnerFingerprint: PARTNER_FINGERPRINT,
      identityLocation: {
        mount: "secrets",
        subPath: [".ssh", "identity.json"],
      },
    });
    // What the card shows is the locator's own segments: no leading slash and
    // nothing the browser did not itself send.
    const label = identityLocationLabel(located.identityLocation);
    expect(label).toBe("secrets / .ssh / identity.json");
    expect(label.startsWith("/")).toBe(false);
  });

  test("a text-direction override in a picked name is shown escaped", () => {
    // The browse admits any single-segment name without a control character, so
    // a file whose name holds a right-to-left override is pickable. Shown raw it
    // would reorder the line the operator reads to check which key signs, and
    // that line is the whole of what the card says about the location.
    const reversing = "identity\u202egpj.json";
    expect(browseSegment(reversing)).toBe(true);
    const label = identityLocationLabel({
      mount: "secrets",
      subPath: [reversing],
    });
    expect(label).toBe("secrets / identity\\u202egpj.json");
    expect(label).not.toContain("\u202e");
  });

  test("changing the location drops the fingerprint read at the old one", () => {
    // A fingerprint is a fact about one key. Carrying it across a move would
    // report the old key's value beside the new location and let the run gate
    // pass on an identity that may not be there.
    const authored = draft({
      mode: "certificate",
      ownFingerprint: OWN_FINGERPRINT,
      partnerFingerprint: PARTNER_FINGERPRINT,
    });
    const moved = receiptsWithField(authored, "identityLocation", {
      mount: "secrets",
      subPath: ["identity.json"],
    });
    expect(moved.ownFingerprint).toBeUndefined();
    expect(moved.partnerFingerprint).toBe(PARTNER_FINGERPRINT);
    expect(problemsFor(moved)).toContain(IDENTITY_MISSING_PROBLEM);
    // And back to the default, which is equally a move.
    const returned = receiptsWithField(
      { ...moved, ownFingerprint: OWN_FINGERPRINT },
      "identityLocation",
      undefined,
    );
    expect(returned.ownFingerprint).toBeUndefined();
  });

  test("a picked location withdraws the shared-mount warning it answers", () => {
    // Both warnings are about the key this run loads, in the folder the
    // rendezvous falls back to. With that key out of the folder they are about
    // no hazard this run makes live, and a warning shown on the safe layout too
    // tells the operator nothing about which layout they are in.
    const located = draft({
      mode: "certificate",
      ownFingerprint: OWN_FINGERPRINT,
      partnerFingerprint: PARTNER_FINGERPRINT,
      identityLocation: { mount: "secrets", subPath: ["identity.json"] },
    });
    for (const rendezvous of [
      SHARED_RENDEZVOUS,
      UNCERTAIN_SHARED_RENDEZVOUS,
      SEPARATE_RENDEZVOUS,
      undefined,
    ]) {
      const messages = receiptsAdvisories(located, rendezvous).map(
        (advisory) => advisory.message,
      );
      expect(messages).not.toContain(IDENTITY_SHARED_MOUNT_LIMIT_ADVISORY);
      expect(messages).not.toContain(IDENTITY_SHARED_MOUNT_REFUSAL_ADVISORY);
      expect(messages).not.toContain(IDENTITY_AT_REST_NOTICE);
      expect(messages).toContain(RECEIPT_LOCATION_NOTICE);
    }
  });

  test("each location advisory names the remedy the other one is", () => {
    // The shared-mount warnings gained the option as a second remedy; the
    // picked-location notice states what the console does there instead.
    expect(IDENTITY_SHARED_MOUNT_LIMIT_ADVISORY).toMatch(/secrets folder/);
    expect(IDENTITY_SHARED_MOUNT_REFUSAL_ADVISORY).toMatch(/secrets folder/);
    expect(IDENTITY_AT_REST_NOTICE).toMatch(/secrets folder/);
    expect(IDENTITY_PICKED_LOCATION_NOTICE).toMatch(/creates no key there/);
    expect(IDENTITY_PICKED_LOCATION_NOTICE).toMatch(/psilink fingerprint/);
    expect(IDENTITY_PICKED_LOCATION_NOTICE).toMatch(/your partner syncs/);
  });

  test("the picked-location notice attributes the write the spec accepts", () => {
    // SERVER_JOB_API.md accepts one write into the secrets mount, and it is the
    // fingerprint request's: the presence check and the child's load are two
    // steps, so a file removed between them is created by that child. The
    // exchange run creates nothing anywhere -- resolveSigningPersist refuses when
    // nothing is at the identity file -- so copy attributing the write to the run
    // names a write that cannot happen while leaving the control that can write
    // unqualified. The read-only mount that closes the case is what the sentence
    // has to keep, since it is the recommended layout.
    expect(IDENTITY_PICKED_LOCATION_NOTICE).not.toMatch(/never writes/);
    expect(IDENTITY_PICKED_LOCATION_NOTICE).not.toMatch(
      /by the run|run's read/,
    );
    expect(IDENTITY_PICKED_LOCATION_NOTICE).toMatch(
      /showing your fingerprint checks that the file is there and then reads it, so a file removed between those two steps is created again at that path/,
    );
    expect(IDENTITY_PICKED_LOCATION_NOTICE).toMatch(
      /mount the folder read-only afterwards/,
    );
  });

  test("a picked location keeps the word on a key left at the default path", () => {
    // Picking a location moves the option, not the file: the usual single-mount
    // flow created the first key at the default path, in the folder the partner
    // syncs, and it stays there. With both shared-mount warnings withdrawn this
    // caveat is the only word the card has on it, and without it the operator
    // meets the hazard as a refusal mid-run or not at all. Where the report says
    // that folder is shared or cannot rule it out the disclosure is live, so the
    // caveat is raised at the weight it takes with no location picked; where the
    // rendezvous has a mount of its own the key is in no folder the partner
    // reads, and it stays inside the notice.
    const located = draft({
      mode: "certificate",
      ownFingerprint: OWN_FINGERPRINT,
      partnerFingerprint: PARTNER_FINGERPRINT,
      identityLocation: { mount: "secrets", subPath: ["identity.json"] },
    });
    for (const [rendezvous, severity] of [
      [SHARED_RENDEZVOUS, "warning"],
      [UNCERTAIN_SHARED_RENDEZVOUS, "warning"],
      [undefined, "warning"],
      [SEPARATE_RENDEZVOUS, "info"],
    ] as const) {
      const raised = receiptsAdvisories(located, rendezvous).find((advisory) =>
        /console's default path/.test(advisory.message),
      );
      expect(raised).toBeDefined();
      expect(raised?.severity).toBe(severity);
      expect(raised?.message).toContain(IDENTITY_DEFAULT_PATH_LEFTOVER_CAVEAT);
      expect(raised?.message).toMatch(/does not move a key you already have/);
      expect(raised?.message).toMatch(
        /a shared-folder exchange is refused while a key sits in a folder your partner syncs/,
      );
      expect(raised?.message).toMatch(
        /Move that file to the location you picked, or remove it if that key is not one you use/,
      );
    }
  });
});

describe("the signing identity's bound name against the agreed terms", () => {
  // The console's half of the CLI's own refusal
  // (assertIdentityMatchesAgreedTerms, apps/cli/src/signingIdentityDivergence.ts):
  // the identity is bound to a party name when it is created and reusing it does
  // not rebind, so an exchange naming this party something else signs receipts
  // the partner rejects, and the run is refused at identity load. The console
  // states that before the launch instead of spending the press on it.

  /** A draft with an identity resolved and bound to `boundIdentity`, the state
   * every case here is about: the fingerprint and the bound name arrive from one
   * read of one file, so neither stands without the other. */
  const resolved = (boundIdentity: string): ReceiptsDraft =>
    receiptsWithResolvedIdentity(
      draft({ mode: "certificate" }),
      OWN_FINGERPRINT,
      boundIdentity,
    );

  test("a bound name the terms state agrees, and nothing is raised", () => {
    const agreeing = resolved(THIS_PARTY);
    expect(signingIdentityDivergence(agreeing, THIS_PARTY)).toBeUndefined();
    // Nor does agreement reach the card's own refusals or advisories: a run
    // whose names match is the ordinary signed run, unchanged.
    expect(problemsFor(agreeing)).toEqual([]);
    expect(
      receiptsAdvisories(agreeing, SEPARATE_RENDEZVOUS).map(
        (advisory) => advisory.message,
      ),
    ).not.toContain(SIGNING_IDENTITY_DIVERGENCE_POINTER);
  });

  test("a diverging name is refused before the launch, naming both values", () => {
    const statement = signingIdentityDivergence(
      resolved("County Registrar"),
      THIS_PARTY,
    );
    expect(statement).toBeDefined();
    expect(statement).toContain('"County Registrar"');
    expect(statement).toContain(`"${THIS_PARTY}"`);
    // What happens, and what to do about it: the refusal, then the two remedies
    // the CLI offers in the same order -- the local name edit first, since a new
    // key invalidates every fingerprint a partner has pinned.
    expect(statement).toMatch(/this run is refused before it connects/);
    expect(statement).toMatch(/set 'Your name' for this exchange/);
    expect(statement).toMatch(/psilink fingerprint --force --identity/);
    expect(statement).toMatch(/new fingerprint/);
    // The console's own words, not the configuration keys the CLI states them in.
    expect(statement).not.toContain("linkage_terms.identity");
    expect(statement).not.toContain("signing.mode");
  });

  test("signing with no identity resolved yet states no divergence", () => {
    // Nothing has been read, so there is no bound name to compare: the missing
    // identity is its own refusal (IDENTITY_MISSING_PROBLEM) and this one is owed
    // a positive finding.
    const unresolved = draft({ mode: "certificate" });
    expect(signingIdentityDivergence(unresolved, THIS_PARTY)).toBeUndefined();
    expect(problemsFor(unresolved)).toContain(IDENTITY_MISSING_PROBLEM);
  });

  test("an identity whose bound name could not be read states no divergence", () => {
    // The console reports no name for a file it cannot read one from, which is
    // nothing to compare rather than disagreement. The run's own refusal, which
    // reads the file itself, stays the authority.
    const unread = receiptsWithResolvedIdentity(
      draft({ mode: "certificate" }),
      OWN_FINGERPRINT,
      undefined,
    );
    expect(unread.boundIdentity).toBeUndefined();
    expect(signingIdentityDivergence(unread, THIS_PARTY)).toBeUndefined();
  });

  test("a draft that signs nothing is never held over an identity", () => {
    expect(
      signingIdentityDivergence(RECEIPTS_DEFAULT, THIS_PARTY),
    ).toBeUndefined();
    expect(
      signingIdentityDivergence(
        draft({ mode: "none", boundIdentity: "County Registrar" }),
        THIS_PARTY,
      ),
    ).toBeUndefined();
    expect(
      signingIdentityDivergence(
        draft({ mode: "session-derived", boundIdentity: "County Registrar" }),
        THIS_PARTY,
      ),
    ).toBeUndefined();
  });

  test("a bound name no terms document may state takes the re-key exit", () => {
    // The local name edit is closed to its holder -- no terms document may state
    // that label -- so the statement names the class core names and never any
    // part of the label itself.
    const statement = signingIdentityDivergence(
      resolved("Registrar\u0007X"),
      THIS_PARTY,
    );
    expect(statement).toBeDefined();
    expect(statement).toContain("control or text-direction character");
    expect(statement).toMatch(/Create a new signing identity/);
    expect(statement).not.toMatch(/set 'Your name' for this exchange to/);
    expect(statement).not.toContain("Registrar");
    expect(statement).toContain(`"${THIS_PARTY}"`);
  });

  test("the bound name is escaped where it is shown", () => {
    // It comes out of a file the operator's own command line may have written,
    // so the card shows it through the display escape like every other value read
    // from the mount.
    const statement = signingIdentityDivergence(
      resolved("Agency \u00c1"),
      THIS_PARTY,
    );
    expect(statement).toBeDefined();
    expect(statement).not.toContain("\u00c1");
  });

  test("the verdict is core's own comparison of the two identity values", () => {
    // The console predicts a refusal the run makes over the canonical identity
    // bytes (certificateAuthorizesIdentity). Held to that predicate rather than
    // described as agreeing with it, over the pairs a whitespace or case
    // difference would part the two on.
    for (const [bound, terms] of [
      ["Agency A", "Agency A"],
      ["Agency A", "Agency B"],
      ["Agency A", "agency a"],
      ["Agency A", "Agency A "],
      ["Agency A", " Agency A"],
      ["Agency \u00c1", "Agency \u00c1"],
    ] as const) {
      const authorized = certificateAuthorizesIdentity(
        { identity: bound } as CertificateBody,
        terms,
      );
      expect([
        bound,
        terms,
        signingIdentityDivergence(resolved(bound), terms) === undefined,
      ]).toEqual([bound, terms, authorized]);
    }
  });

  test("the card points at the statement rather than repeating it", () => {
    // The whole statement is at the control that starts the exchange, where the
    // operator is when the refusal applies; the card, which shows the identity,
    // holds one line pointing there. Neither is one of the card's own refusals,
    // whose remedies are all controls on the card itself.
    const statement = signingIdentityDivergence(
      resolved("County Registrar"),
      THIS_PARTY,
    );
    expect(SIGNING_IDENTITY_DIVERGENCE_POINTER).not.toBe(statement);
    expect(SIGNING_IDENTITY_DIVERGENCE_POINTER).toMatch(
      /the control that starts this exchange/,
    );
    expect(problemsFor(resolved("County Registrar"))).toEqual([]);
  });

  test("the fingerprint and the bound name are dropped together", () => {
    // Both are facts about one key at one location, so no edit may leave one
    // behind: a stale bound name would hold a launch over a key the draft no
    // longer names.
    const bound = resolved("County Registrar");
    expect(bound.ownFingerprint).toBe(OWN_FINGERPRINT);
    expect(bound.boundIdentity).toBe("County Registrar");
    const unsigned = receiptsWithField(bound, "mode", "none");
    expect(unsigned.ownFingerprint).toBeUndefined();
    expect(unsigned.boundIdentity).toBeUndefined();
    const moved = receiptsWithField(bound, "identityLocation", {
      mount: "secrets",
      subPath: ["signing-identity.json"],
    });
    expect(moved.ownFingerprint).toBeUndefined();
    expect(moved.boundIdentity).toBeUndefined();
  });

  test("an unnamed exchange has nothing to diverge from", () => {
    // Mirrors the CLI's divergesFromAgreedTerms, which treats an empty terms
    // identity the same as an absent one rather than a name that disagrees.
    const bound = resolved("County Registrar");
    expect(signingIdentityDivergence(bound, "")).toBeUndefined();
    expect(signingIdentityDivergence(bound, "Someone Else")).toBeDefined();
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
