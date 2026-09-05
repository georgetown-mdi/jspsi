import fs from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";

import { afterEach, describe, expect, test, vi } from "vitest";
import type { Arguments } from "yargs";
import logLibrary from "loglevel";
import YAML from "yaml";
import {
  CONSENT_FACTS,
  DEDUPLICATE_ACCEPTOR_SIDE_NOTE,
  DEDUPLICATE_SHARED_RESULT_DISCLOSURE_STATEMENT,
  DEDUPLICATE_SOLE_RECEIVER_DISCLOSURE_STATEMENT,
  DEFAULT_MAX_DISPLAY_LENGTH,
  DISPLAY_TRUNCATION_MARKER,
  encodeInvitation,
  getDefaultLinkageTerms,
  getDiagnosticSink,
  getLogger,
  inferMetadata,
  LINKAGE_RULE_SET_VERDICT_COPY,
  MAX_DECLARED_NAMES_SHOWN,
  MAX_NAME_LENGTH,
  MAX_PAYLOAD_ENTRIES,
  parseExchangeSpec,
  reconcileReceivedPayload,
  redactPrivateKeyMaterial,
  sanitizeErrorForDisplay,
  sanitizeForDisplay,
  setDiagnosticSink,
  summarizeInvitation,
  UNRECOGNIZED_TRANSFORM_NOTE,
  unshownDeclaredNamesLine,
  UsageError,
} from "@psilink/core";
import {
  BEL,
  CONSENT_PROBE_TERMS,
  COUNT_ONLY_PROBE_TERMS,
  ESC,
  MAX_ENDPOINT_HOST_LENGTH,
  MAX_RAW_INVITATION_LENGTH,
  PRINTABLE_ASCII,
  RLO,
  consentRepresentationProbes,
  hostileVariants,
} from "@psilink/core/testing";
import type {
  ConnectionConfig,
  ConnectionEndpoint,
  ConsentFact,
  Displayable,
  InvitationToken,
  LinkageRuleSetReference,
  LinkageStrategy,
  LinkageTerms,
  TransformStep,
} from "@psilink/core";

// Mock only the two terminal reads; the rest of util/prompt, and every other
// util module (util/dataIo's openInputSource, which the `-` stdin tests exercise
// for real, util/logging's configureLogFile, etc.) is the genuine
// implementation. This lets the handler tests assert whether the confirmation
// prompt and the identity question ran without driving a real readline over the
// test runner's stdin.
vi.mock("../../../src/util/prompt", async () => {
  const actual = await vi.importActual<
    typeof import("../../../src/util/prompt")
  >("../../../src/util/prompt");
  return { ...actual, promptConfirm: vi.fn(), promptFreeText: vi.fn() };
});

// Mock only runOnlineBootstrap, so the online-handler wiring can be asserted
// without opening a connection or running a real exchange; every other
// onlineBootstrap export (generateSharedSecret, and the buildDataSpec/
// prepareForOnlineExchange chain validateAccept drives) is the genuine
// implementation.
vi.mock("../../../src/onlineBootstrap", async () => {
  const actual = await vi.importActual<
    typeof import("../../../src/onlineBootstrap")
  >("../../../src/onlineBootstrap");
  return { ...actual, runOnlineBootstrap: vi.fn() };
});

import {
  handler as acceptHandler,
  resolveAcceptPositionals,
  validateAccept,
} from "../../../src/commands/accept";
import { INVITATION_BROKER_ADDRESS_REFUSED } from "../../../src/connection/webrtc/brokerClient";
import { decodeAndValidateInvitation } from "../../../src/invitationDecode";
import {
  displayInvitation,
  logDecisionFacts,
  renderDialedBroker,
} from "../../../src/invitationDisplay";
import {
  generateSharedSecret,
  runOnlineBootstrap,
} from "../../../src/onlineBootstrap";
import type { CommonBootstrapOptions } from "../../../src/optionDefinitions";
import {
  ACCEPT_IDENTITY_QUESTION,
  IDENTITY_REQUIRED,
  IDENTITY_STILL_PLACEHOLDER,
  PLACEHOLDER_IDENTITY,
} from "../../../src/partyIdentity";
import { saveConfig } from "../../../src/config";
import { exitCodeForError } from "../../../src/util/exit";
import { promptConfirm, promptFreeText } from "../../../src/util/prompt";
import { captureStdio } from "../../loggingTestSupport";
import { ttyStream } from "../../stdinStream";

const promptConfirmMock = vi.mocked(promptConfirm);
const promptFreeTextMock = vi.mocked(promptFreeText);

const silentLog = getLogger("accept-test");
silentLog.setLevel("silent");

let optionsCounter = 0;
// Minimal options pointing config/key at fresh, non-existent temp paths so the
// conflict gate passes and validateAccept reaches the step under test. The
// identity is part of that minimum: the acceptor derives terms holding its own
// label, and a run without one stops at the identity gate before the step under
// test.
function testOptions(
  overrides: Partial<CommonBootstrapOptions> = {},
): CommonBootstrapOptions {
  const id = `${process.pid}-${optionsCounter++}`;
  return {
    configFile: path.join(tmpdir(), `psilink-accept-test-${id}.yaml`),
    keyFile: path.join(tmpdir(), `psilink-accept-test-${id}.key`),
    identity: "Agency B",
    record: false,
    eventStream: false,
    logLevel: logLibrary.levels.SILENT,
    verbosity: 0,
    ...overrides,
  };
}

afterEach(() => {
  vi.useRealTimers();
  // Reset the shared prompt mocks after every test so none inherits a stale
  // implementation or call count from a prior one -- the guarantee lives here
  // rather than each handler test having to remember to reset it.
  promptConfirmMock.mockReset();
  promptFreeTextMock.mockReset();
});

function sampleToken(
  expires?: string,
  connectionEndpoint?: ConnectionEndpoint,
): InvitationToken {
  return {
    version: "1",
    linkageTerms: sampleTerms("Inviter Org"),
    sharedSecret: generateSharedSecret(),
    expires,
    connectionEndpoint,
  };
}

// The same token holding a SPLIT inbound/outbound endpoint. Core requires the
// retain declaration beside that shape at the mint (a split directory puts every
// connection built from it in retain mode), so a case that goes through
// encodeInvitation has it exactly as a real inviter's mint does. A case that
// renders a token without minting it uses sampleToken directly, since an
// undeclared split endpoint stays a decodable shape.
function splitEndpointToken(
  expires: string,
  connectionEndpoint: ConnectionEndpoint,
): InvitationToken {
  return {
    ...sampleToken(expires, connectionEndpoint),
    inviterRetainsFiles: true,
  };
}

// A token whose one linkage key splits its element's value into several match
// candidates: the shape that raises a fan-out consent fact, in whichever of the
// two registers the strategy puts it.
function splittingKeyToken(
  expires: string,
  linkageStrategy: LinkageStrategy,
): InvitationToken {
  const token = sampleToken(expires);
  return {
    ...token,
    linkageTerms: {
      ...token.linkageTerms,
      linkageStrategy,
      linkageKeys: [
        {
          name: "last name",
          elements: [
            {
              field: token.linkageTerms.linkageFields[0].name,
              transform: [{ function: "split_on", params: { delimiter: " " } }],
            },
          ],
        },
      ],
    },
  };
}

// --- offline vs online dispatch ----------------------------------------------

describe("offline vs online dispatch", () => {
  test("a leading invitation dispatches offline", () => {
    const r = resolveAcceptPositionals(["abc123def456ghi", "input.csv"]);
    expect(r.mode).toBe("offline");
    if (r.mode !== "offline") return;
    expect(r.invitation).toBe("abc123def456ghi");
    expect(r.input).toBe("input.csv");
  });

  test("a leading URL dispatches online", () => {
    const r = resolveAcceptPositionals([
      "sftp://host/drop",
      "INVITE",
      "input.csv",
      "out.csv",
    ]);
    expect(r.mode).toBe("online");
    if (r.mode !== "online") return;
    expect(r.url.hostname).toBe("host");
    expect(r.invitation).toBe("INVITE");
    expect(r.input).toBe("input.csv");
    expect(r.output).toBe("out.csv");
  });

  test("no positionals is a usage error", () => {
    expect(() => resolveAcceptPositionals([])).toThrow(UsageError);
    expect(() => resolveAcceptPositionals([])).toThrow(
      "invitation is required",
    );
  });

  test("online acceptance without an input file is a usage error", () => {
    expect(() =>
      resolveAcceptPositionals(["sftp://host/drop", "INVITE"]),
    ).toThrow("requires an invitation and an input file");
  });

  test("a positional past the form's last one is a usage error, not a drop", () => {
    // Each form is checked against its own count: the third positional is the
    // OUTPUT_FILE offline and the INPUT_FILE online, so an operator who reached
    // for the wrong form reads that form's usage rather than having the file they
    // named silently ignored.
    const offline = (): void => {
      resolveAcceptPositionals(["INVITE", "input.csv", "out.csv", "extra.csv"]);
    };
    expect(offline).toThrow(UsageError);
    expect(offline).toThrow(
      "psilink accept --identity IDENTITY INVITATION [INPUT_FILE] [OUTPUT_FILE]",
    );
    const online = (): void => {
      resolveAcceptPositionals([
        "sftp://host/drop",
        "INVITE",
        "input.csv",
        "out.csv",
        "extra.csv",
      ]);
    };
    expect(online).toThrow(UsageError);
    expect(online).toThrow(
      "psilink accept --identity IDENTITY URL INVITATION INPUT_FILE " +
        "[OUTPUT_FILE]",
    );
    // The classification an unattended caller reads: a positional it typed is its
    // own to fix, so 64 rather than the transport's 69.
    let refusal: unknown;
    try {
      offline();
    } catch (err) {
      refusal = err;
    }
    expect(exitCodeForError(refusal)).toBe(64);
    // The counts each form does accept are untouched.
    expect(
      resolveAcceptPositionals(["INVITE", "input.csv", "out.csv"]).mode,
    ).toBe("offline");
    expect(
      resolveAcceptPositionals([
        "sftp://host/drop",
        "INVITE",
        "input.csv",
        "out.csv",
      ]).mode,
    ).toBe("online");
  });
});

// --- a '-'-leading invitation is taken as the positional, not a flag ---------

describe("a '-'-leading invitation is taken as the positional, not a flag", () => {
  test("an invitation beginning with '-' is parsed as the positional invitation", () => {
    const r = resolveAcceptPositionals([
      "-eyJ2ZXJzaW9uIjoiMSJ9abcDEF",
      "input.csv",
    ]);
    expect(r.mode).toBe("offline");
    if (r.mode !== "offline") return;
    expect(r.invitation).toBe("-eyJ2ZXJzaW9uIjoiMSJ9abcDEF");
    expect(r.input).toBe("input.csv");
  });
});

// --- decode + validate (the gate before the prompt) --------------------------

describe("decode + validate (the gate before the prompt)", () => {
  test("encode/decode round-trips an invitation at the command level", async () => {
    const token = sampleToken(new Date(Date.now() + 3_600_000).toISOString());
    const encoded = await encodeInvitation(token);
    const decoded = await decodeAndValidateInvitation(encoded);
    expect(decoded.sharedSecret).toBe(token.sharedSecret);
    expect(decoded.linkageTerms.identity).toBe("Inviter Org");
    expect(decoded.linkageTerms.linkageKeys.map((k) => k.name)).toEqual(
      token.linkageTerms.linkageKeys.map((k) => k.name),
    );
  });

  test("a hard-wrapped invitation paste decodes at the command level", async () => {
    const token = sampleToken(FUTURE());
    const encoded = await encodeInvitation(token);
    // What a token pasted out of a wrapping mail client holds: line breaks and
    // the indentation of a quoted reply, none of it part of the invitation.
    const wrapped = `${encoded.slice(0, 30)}\n  ${encoded.slice(30, 60)}\n${encoded.slice(60)}`;
    const decoded = await decodeAndValidateInvitation(wrapped);
    expect(decoded.sharedSecret).toBe(token.sharedSecret);
  });

  test("an NBSP-wrapped invitation decodes identically on argv and on an @-file reference", async () => {
    const token = sampleToken(FUTURE());
    const encoded = await encodeInvitation(token);
    // Leading and trailing U+00A0, plus an interior U+2028, alongside the usual
    // hard-wrap: the @-file path's own readFileSync(...).trim() would already
    // strip the edges, so this pins that argv (no such trim) reaches the same
    // decoded token through stripInvitationWhitespace alone.
    const wrapped =
      `\u00a0${encoded.slice(0, 30)}\n  ${encoded.slice(30, 60)}` +
      `\u2028${encoded.slice(60)}\u00a0`;

    const viaArgv = await decodeAndValidateInvitation(wrapped);

    const dir = fs.mkdtempSync(
      path.join(tmpdir(), "psilink-accept-invitation-atfile-"),
    );
    const file = path.join(dir, "invitation.txt");
    fs.writeFileSync(file, wrapped);
    const viaAtFile = await decodeAndValidateInvitation(`@${file}`);

    expect(viaArgv).toEqual(viaAtFile);
    expect(viaArgv.sharedSecret).toBe(token.sharedSecret);
  });

  test("an argv token over the raw bound is refused with the length message", async () => {
    const overBound = "a".repeat(MAX_RAW_INVITATION_LENGTH + 1);
    const err = await decodeAndValidateInvitation(overBound).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(UsageError);
    expect((err as UsageError).message).toContain("exceeds the maximum length");
  });

  test("a checksum mismatch is rejected (before any prompt) with a usage error", async () => {
    const encoded = await encodeInvitation(
      sampleToken(new Date(Date.now() + 3_600_000).toISOString()),
    );
    // Corrupt the final checksum character; the 4-byte checksum no longer matches.
    const last = encoded.slice(-1);
    const tampered = encoded.slice(0, -1) + (last === "A" ? "B" : "A");
    await expect(decodeAndValidateInvitation(tampered)).rejects.toBeInstanceOf(
      UsageError,
    );
    await expect(decodeAndValidateInvitation(tampered)).rejects.toThrow(
      /checksum mismatch/,
    );
  });

  test("an expired invitation is rejected, naming the expiry time", async () => {
    const realNow = Date.now();
    const expires = new Date(realNow + 60_000).toISOString();
    // Encode while the token is still in the future (encodeInvitation requires it).
    const encoded = await encodeInvitation(sampleToken(expires));
    // Advance past the expiry; decode + validate must now reject by name.
    vi.useFakeTimers();
    vi.setSystemTime(new Date(realNow + 120_000));
    await expect(decodeAndValidateInvitation(encoded)).rejects.toThrow(expires);
  });
});

// --- validateAccept (the no-commit phase, before the prompt) -----------------

// accept reads its y/N confirmation from stdin, so it cannot also take the CSV
// there. validateAccept runs before promptConfirm, so a `-` input is rejected up
// front (a UsageError naming a file path) instead of a stdin CSV starving the
// prompt into a silent EOF decline. Both positional modes pass allowStdin: false.
async function expectStdinRejection(
  resolved: Parameters<typeof validateAccept>[0]["resolved"],
): Promise<void> {
  let caught: unknown;
  try {
    await validateAccept({ resolved, options: testOptions(), log: silentLog });
  } catch (err) {
    caught = err;
  }
  expect(caught).toBeInstanceOf(UsageError);
  // Match the stdin-specific phrasing, not just "file path": several unrelated
  // UsageErrors on this path (e.g. config reconciliation) also mention a file
  // path, so require the stdin rejection's own wording to avoid a pass for the
  // wrong reason.
  expect((caught as Error).message).toMatch(/stdin/);
  expect((caught as Error).message).toMatch(/file path/);
}

describe("validateAccept (the no-commit phase, before the prompt)", () => {
  test("validateAccept: an invalid invitation is rejected before the prompt", async () => {
    await expect(
      validateAccept({
        resolved: { mode: "offline", invitation: "not-a-valid-invitation" },
        options: testOptions(),
        log: silentLog,
      }),
    ).rejects.toBeInstanceOf(UsageError);
  });

  test("validateAccept: a missing or blank --identity is refused", async () => {
    // The acceptor records its OWN identity in the derived terms (the invitation
    // has the inviter's), so a valid invitation is not a label this party can
    // borrow: with none supplied, the acceptance stops. A blank value -- the
    // scripted `--identity "$ORG"` with ORG unset -- is none supplied.
    const encoded = await encodeInvitation(sampleToken(FUTURE()));
    for (const identity of [undefined, "", "   "])
      await expect(
        validateAccept({
          resolved: { mode: "offline", invitation: encoded },
          options: testOptions({ identity }),
          log: silentLog,
        }),
      ).rejects.toThrow(IDENTITY_REQUIRED);
  });

  test("validateAccept: an --identity still holding the init placeholder is refused", async () => {
    // Accepting authors a durable partnership under this party's own label, so the
    // template's placeholder is refused here exactly as no label at all -- whether
    // it was copied verbatim or with the whitespace a quoted argument leaves.
    const encoded = await encodeInvitation(sampleToken(FUTURE()));
    for (const identity of [
      PLACEHOLDER_IDENTITY,
      `  ${PLACEHOLDER_IDENTITY}  `,
    ])
      await expect(
        validateAccept({
          resolved: { mode: "offline", invitation: encoded },
          options: testOptions({ identity }),
          log: silentLog,
        }),
      ).rejects.toThrow(IDENTITY_STILL_PLACEHOLDER);
  });

  test("validateAccept: with no --identity, the answer at the terminal is this party's label", async () => {
    // The label the acceptance records is the one the operator typed, trimmed the
    // way a flag value is -- so what the partner reads and what the written
    // configuration holds is the answer, not the keystrokes around it.
    const encoded = await encodeInvitation(sampleToken(FUTURE()));
    const askIdentity = vi.fn().mockResolvedValue("  Agency B  ");
    const ready = await validateAccept({
      resolved: { mode: "offline", invitation: encoded },
      options: testOptions({ identity: undefined }),
      askIdentity,
      log: silentLog,
    });
    expect(askIdentity).toHaveBeenCalledTimes(1);
    expect(ready.dataSpec.linkageTerms.identity).toBe("Agency B");
  });

  test("validateAccept: --identity is answer enough; no question is asked over it", async () => {
    // The flag is the scripted path on both commands: where it names this party
    // there is nothing to ask, so an acceptance that could ask still does not.
    const encoded = await encodeInvitation(sampleToken(FUTURE()));
    const askIdentity = vi.fn().mockResolvedValue("Someone Else");
    const ready = await validateAccept({
      resolved: { mode: "offline", invitation: encoded },
      options: testOptions({ identity: "Agency B" }),
      askIdentity,
      log: silentLog,
    });
    expect(askIdentity).not.toHaveBeenCalled();
    expect(ready.dataSpec.linkageTerms.identity).toBe("Agency B");
  });

  test("validateAccept: a blank answer is absence, and the acceptance stops unnamed", async () => {
    // Blank at the question is treated as blank at the flag: absence, not a label. An
    // acceptance authors a durable partnership, so absence is where it stops --
    // pressing return past the question does not name this party the empty string.
    const encoded = await encodeInvitation(sampleToken(FUTURE()));
    for (const answer of ["", "   ", "\n"])
      await expect(
        validateAccept({
          resolved: { mode: "offline", invitation: encoded },
          options: testOptions({ identity: undefined }),
          askIdentity: vi.fn().mockResolvedValue(answer),
          log: silentLog,
        }),
      ).rejects.toThrow(IDENTITY_REQUIRED);
  });

  test("validateAccept: the init placeholder typed at the question is refused", async () => {
    // The one string that is not a label is refused whichever way it arrives, so
    // an operator who pastes the template's own field back at the question is told
    // the same thing as one who passes it on --identity.
    const encoded = await encodeInvitation(sampleToken(FUTURE()));
    await expect(
      validateAccept({
        resolved: { mode: "offline", invitation: encoded },
        options: testOptions({ identity: undefined }),
        askIdentity: vi.fn().mockResolvedValue(`  ${PLACEHOLDER_IDENTITY}  `),
        log: silentLog,
      }),
    ).rejects.toThrow(IDENTITY_STILL_PLACEHOLDER);
  });

  test("validateAccept: a deduplicating invitation leaves this party one-to-one", async () => {
    // The hostile-flip guard at the CLI accept entry point. validateAccept derives
    // the acceptor's own terms (deriveAcceptedLinkageTerms) ahead of reading the
    // input, opening any connection, or prompting, and that derivation sets this
    // party's own deduplicate rather than adopting the invitation's -- so what the
    // inviter declares, or goes on to present at the terms exchange, cannot make
    // this party the "many" side. What it does agree to is the invitation's own
    // side, which the consent surface states.
    const base = sampleToken(new Date(Date.now() + 3_600_000).toISOString());
    const encoded = await encodeInvitation({
      ...base,
      linkageTerms: { ...base.linkageTerms, deduplicate: true },
    });
    const ready = await validateAccept({
      resolved: { mode: "offline", invitation: encoded },
      options: testOptions(),
      log: silentLog,
    });
    expect(ready.dataSpec.linkageTerms?.deduplicate).toBe(false);
    expect(ready.token.linkageTerms.deduplicate).toBe(true);
  });

  test("validateAccept: online retains the invitation's declared deduplicate for the run", async () => {
    // The other half of that guard. This party's own side is derived, so the
    // invitation's declaration for the INVITING party's side is what the consent
    // surface stated and what the exchange must hold its partner to -- and it
    // survives nowhere in the derived terms. The acceptance records it on the
    // prepared exchange, where runExchange refuses a partner presenting anything
    // else before a key or payload moves.
    for (const declared of [false, true]) {
      const base = sampleToken(FUTURE());
      const { error, ready } = await acceptWarnings({
        token: {
          ...base,
          linkageTerms: { ...base.linkageTerms, deduplicate: declared },
        },
        columns: LINKAGE_COLUMNS,
        loggerName: `accept-declared-deduplicate-${declared}`,
        mode: "online",
      });
      expect(error).toBeUndefined();
      const prepared = (
        ready as { prepared: { expectedPartnerDeduplicate?: boolean } }
      ).prepared;
      expect(prepared.expectedPartnerDeduplicate).toBe(declared);
    }
  });

  test("validateAccept: a deduplicating single-pass invitation derives before the prompt", async () => {
    // validateAccept derives the acceptor's terms ahead of the input, the
    // connection, and the consent display, so an invitation the run cannot honor is
    // refused before reaching a screen that would state what its grouping
    // discloses. Both strategies match a deduplicating cardinality, so this pair
    // derives -- with the acceptor's own side the derived false, whatever the
    // invitation declared.
    const base = sampleToken(new Date(Date.now() + 3_600_000).toISOString());
    const encoded = await encodeInvitation({
      ...base,
      linkageTerms: {
        ...base.linkageTerms,
        deduplicate: true,
        linkageStrategy: "single-pass",
      },
    });
    const ready = await validateAccept({
      resolved: { mode: "offline", invitation: encoded },
      options: testOptions(),
      log: silentLog,
    });
    expect(ready.dataSpec.linkageTerms?.deduplicate).toBe(false);
    expect(ready.dataSpec.linkageTerms?.linkageStrategy).toBe("single-pass");
    expect(ready.token.linkageTerms.deduplicate).toBe(true);
  });

  test("validateAccept: online rejects a missing input file before the prompt, preserving its exit code", async () => {
    const encoded = await encodeInvitation(
      sampleToken(new Date(Date.now() + 3_600_000).toISOString()),
    );
    await expect(
      validateAccept({
        resolved: {
          mode: "online",
          url: new URL("sftp://host/drop"),
          invitation: encoded,
          input: "/nonexistent/psilink-input.csv",
        },
        options: testOptions(),
        log: silentLog,
      }),
    ).rejects.toMatchObject({ exitCode: 69 });
  });

  test("validateAccept: online `-` input is rejected as a usage error before the prompt, not silently declined", async () => {
    const encoded = await encodeInvitation(
      sampleToken(new Date(Date.now() + 3_600_000).toISOString()),
    );
    await expectStdinRejection({
      mode: "online",
      url: new URL("sftp://host/drop"),
      invitation: encoded,
      input: "-",
    });
  });

  test("validateAccept: offline `-` input is rejected as a usage error before the prompt, not silently declined", async () => {
    const encoded = await encodeInvitation(
      sampleToken(new Date(Date.now() + 3_600_000).toISOString()),
    );
    await expectStdinRejection({
      mode: "offline",
      invitation: encoded,
      input: "-",
    });
  });
});

// --- `--consent-to-terms` (consentToTerms) relaxes the `-` rejection ---------
// With the prompt skipped, stdin is free for the CSV, so `-` is read rather than
// rejected. Run validateAccept with process.stdin replaced by a byte stream that
// emits a CSV then EOF, mirroring `cat data.csv | psilink accept --consent-to-terms - INVITE`.

/** A byte-stream stand-in for process.stdin that emits `csv` then ends. */
function makeStdin(csv: string): Readable {
  const stream = new Readable({ read() {} });
  stream.push(Buffer.from(csv, "utf8"));
  stream.push(null);
  return stream;
}

/** Run `fn` with process.stdin replaced by `stream`, restoring it after. */
async function withStdinStream<T>(
  stream: Readable,
  fn: () => Promise<T>,
): Promise<T> {
  const original = Object.getOwnPropertyDescriptor(process, "stdin");
  Object.defineProperty(process, "stdin", {
    value: stream,
    configurable: true,
  });
  try {
    return await fn();
  } finally {
    if (original !== undefined)
      Object.defineProperty(process, "stdin", original);
  }
}

/** Run `fn` with process.stdin replaced by a stream emitting `csv`, restoring it. */
async function withStdin<T>(csv: string, fn: () => Promise<T>): Promise<T> {
  return withStdinStream(makeStdin(csv), fn);
}

describe("'--consent-to-terms' (consentToTerms) relaxes the '-' rejection", () => {
  test("validateAccept: offline `-` with consentToTerms reads the CSV from stdin and proceeds", async () => {
    // A CSV the default linkage terms can satisfy, so the satisfiability pre-flight
    // passes and the dataSpec holds metadata inferred from the stdin header --
    // proof the CSV was actually read from stdin rather than `-` being rejected.
    const csv =
      "first_name,last_name,dob,ssn\nAlice,Smith,1990-01-02,123456789\n";
    const encoded = await encodeInvitation(
      sampleToken(new Date(Date.now() + 3_600_000).toISOString()),
    );
    const ready = await withStdin(csv, () =>
      validateAccept({
        resolved: { mode: "offline", invitation: encoded, input: "-" },
        options: testOptions(),
        consentToTerms: true,
        log: silentLog,
      }),
    );
    expect(ready.mode).toBe("offline");
    // The metadata names match the stdin header, so the stdin CSV reached the spec.
    expect(ready.dataSpec.metadata?.map((c) => c.name)).toEqual(
      expect.arrayContaining(["first_name", "last_name", "dob", "ssn"]),
    );
  });

  test("validateAccept: online `-` with consentToTerms reads the CSV from stdin and proceeds", async () => {
    // The online path gates stdin on consentToTerms exactly as the offline path
    // does; exercise it through the same stdin swap so the symmetric `-` relaxation
    // is covered on both branches, not just offline.
    const csv =
      "first_name,last_name,dob,ssn\nAlice,Smith,1990-01-02,123456789\n";
    const dir = fs.mkdtempSync(
      path.join(tmpdir(), "psilink-accept-online-stdin-"),
    );
    const encoded = await encodeInvitation(
      sampleToken(new Date(Date.now() + 3_600_000).toISOString()),
    );
    try {
      const ready = await withStdin(csv, () =>
        validateAccept({
          resolved: {
            mode: "online",
            url: new URL("sftp://host/drop"),
            invitation: encoded,
            input: "-",
          },
          options: testOptions({
            configFile: path.join(dir, "psilink.yaml"),
            keyFile: path.join(dir, ".psilink.key"),
          }),
          consentToTerms: true,
          log: silentLog,
        }),
      );
      expect(ready.mode).toBe("online");
      // The metadata names match the stdin header, so the stdin CSV reached the spec.
      expect(ready.dataSpec.metadata?.map((c) => c.name)).toEqual(
        expect.arrayContaining(["first_name", "last_name", "dob", "ssn"]),
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("validateAccept: an unsupported URL is rejected before the input file is read", async () => {
    const encoded = await encodeInvitation(
      sampleToken(new Date(Date.now() + 3_600_000).toISOString()),
    );
    // Both the URL is unsupported and the input file is missing; the URL is now
    // checked first (mirroring validateInvite), so the UsageError wins over the
    // file's exitCode-69 error -- proving the URL is validated before the read.
    await expect(
      validateAccept({
        resolved: {
          mode: "online",
          url: new URL("ws://host/path"),
          invitation: encoded,
          input: "/nonexistent/psilink-input.csv",
        },
        options: testOptions(),
        log: silentLog,
      }),
    ).rejects.toBeInstanceOf(UsageError);
  });
});

// --- connection_per_poll ignored on a non-sftp online URL --------------------
// A file:// URL resolves to filedrop, which holds no session, so an online accept
// passing --connection-per-poll must warn it is ignored rather than silently
// drop it. connectionFromURL applies the override only on sftp, so on filedrop the
// raw flag is the sole carrier of the operator's intent; validateAccept reads it
// and warns. On sftp the mode is valid, so the ignored-warning stays silent.

const CPP_CSV =
  "first_name,last_name,dob,ssn\nAlice,Smith,1990-01-02,123456789\n";

describe("connection_per_poll ignored on a non-sftp online URL", () => {
  test("validateAccept: online file:// URL with --connection-per-poll warns it is ignored", async () => {
    const dir = fs.mkdtempSync(
      path.join(tmpdir(), "psilink-accept-cpp-filedrop-"),
    );
    const input = path.join(dir, "input.csv");
    fs.writeFileSync(input, CPP_CSV);
    const encoded = await encodeInvitation(
      sampleToken(new Date(Date.now() + 3_600_000).toISOString()),
    );
    const log = getLogger("accept-cpp-filedrop-test");
    log.setLevel("silent");
    const warnSpy = vi.spyOn(log, "warn");
    try {
      await validateAccept({
        resolved: {
          mode: "online",
          url: new URL(`file://${dir}`),
          invitation: encoded,
          input,
        },
        options: testOptions({
          configFile: path.join(dir, "psilink.yaml"),
          keyFile: path.join(dir, ".psilink.key"),
          connectionPerPoll: true,
        }),
        log,
      });
      expect(
        warnSpy.mock.calls.some(
          (c) =>
            typeof c[0] === "string" &&
            c[0].includes("--connection-per-poll") &&
            c[0].includes("will be ignored") &&
            c[0].includes("only supported on sftp"),
        ),
      ).toBe(true);
    } finally {
      warnSpy.mockRestore();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("validateAccept: online sftp URL with --connection-per-poll does not warn it is ignored", async () => {
    const dir = fs.mkdtempSync(path.join(tmpdir(), "psilink-accept-cpp-sftp-"));
    const input = path.join(dir, "input.csv");
    fs.writeFileSync(input, CPP_CSV);
    const encoded = await encodeInvitation(
      sampleToken(new Date(Date.now() + 3_600_000).toISOString()),
    );
    const log = getLogger("accept-cpp-sftp-test");
    log.setLevel("silent");
    const warnSpy = vi.spyOn(log, "warn");
    try {
      await validateAccept({
        resolved: {
          mode: "online",
          url: new URL("sftp://host/drop"),
          invitation: encoded,
          input,
        },
        options: testOptions({
          configFile: path.join(dir, "psilink.yaml"),
          keyFile: path.join(dir, ".psilink.key"),
          connectionPerPoll: true,
          // A long poll interval keeps the wasteful-short-interval advisory silent
          // too, so no connection_per_poll warning of any kind appears on sftp.
          pollingFrequencyMs: 3_600_000,
        }),
        log,
      });
      expect(
        warnSpy.mock.calls.some(
          (c) =>
            typeof c[0] === "string" && c[0].includes("--connection-per-poll"),
        ),
      ).toBe(false);
    } finally {
      warnSpy.mockRestore();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

// --- linkage pre-flight (block vs warn) --------------------------------------

const FUTURE = () => new Date(Date.now() + 3_600_000).toISOString();

// Write a temp CSV with the given header columns (one filler data row; the
// pre-flight reasons about column names, not values). Returns the path.
function writeInputCSV(columns: string[]): string {
  const id = `${process.pid}-${optionsCounter++}`;
  const file = path.join(tmpdir(), `psilink-accept-input-${id}.csv`);
  fs.writeFileSync(
    file,
    `${columns.join(",")}\n${columns.map(() => "x").join(",")}\n`,
  );
  return file;
}

describe("linkage pre-flight (block vs warn)", () => {
  test("validateAccept: offline refuses (UsageError) when the CSV satisfies no linkage key", async () => {
    // The invitation's terms need first/last name, dob and ssn; a CSV with only
    // first_name can complete no key, so the pre-flight aborts before the prompt
    // rather than running an exchange that could only produce an empty result.
    const options = testOptions();
    const input = writeInputCSV(["first_name"]);
    try {
      const encoded = await encodeInvitation(sampleToken(FUTURE()));
      await expect(
        validateAccept({
          resolved: { mode: "offline", invitation: encoded, input },
          options,
          log: silentLog,
        }),
      ).rejects.toThrow(
        /cannot satisfy every linkage key the invitation declares/,
      );
    } finally {
      fs.rmSync(input, { force: true });
    }
  });

  test("validateAccept: offline refuses when the CSV satisfies only some keys", async () => {
    // last/first name + dob satisfy the name+dob keys but not the ssn keys. The
    // acceptance is refused -- offline runs no prepare, so this pre-flight is the
    // only place the refusal lands, and it fires before the prompt and before any
    // configuration or key file is written. It is a usage error (exit 64) naming
    // the agreed keys it costs; the invitation declares more of them than the
    // rendered cause chain reaches, so the keys take the whole enumeration and
    // what stands behind them is counted rather than named.
    const options = testOptions();
    const input = writeInputCSV(["last_name", "first_name", "dob"]);
    try {
      const encoded = await encodeInvitation(sampleToken(FUTURE()));
      const raised = await validateAccept({
        resolved: { mode: "offline", invitation: encoded, input },
        options,
        log: silentLog,
      }).then(
        () => {
          throw new Error("the acceptance should have been refused");
        },
        (reason: unknown) => reason,
      );
      expect(raised).toBeInstanceOf(UsageError);
      const rendered = sanitizeErrorForDisplay(raised);
      expect(rendered).toContain(
        "cannot satisfy every linkage key the invitation declares",
      );
      expect(rendered).toContain(
        "linkage key the CSV cannot produce: SSN + LN + DOB",
      );
      expect(rendered).toContain("more details of the terms this CSV cannot");
      expect(rendered).toContain(
        "or ask your partner for an invitation with different linkage terms.",
      );
    } finally {
      fs.rmSync(input, { force: true });
    }
  });
});

// --- the disclosure the invitation will not accept ---------------------------

// The columns satisfying the sample invitation's linkage keys, none of which is
// disclosed to the partner (inferMetadata gives a recognized linkage alias
// is_payload: false), so a CSV of these alone sends nothing.
const LINKAGE_COLUMNS = ["first_name", "last_name", "dob", "ssn"];

// The built-in rule set narrowed to the keys LINKAGE_COLUMNS supports, the way a
// party's own file narrows it. Every terms fixture in this file uses it, on both
// sides: an acceptance is refused unless its CSV can satisfy every key the
// invitation declares, so terms declaring a key no test CSV here holds would
// refuse every acceptance below.
function sampleTerms(identity: string): LinkageTerms {
  return getDefaultLinkageTerms(identity, inferMetadata(LINKAGE_COLUMNS));
}

// The distinctive clause of the warning under test, kept apart from the remedies
// and the column list the assertions check separately.
const REFUSED_DISCLOSURE_CLAUSE = "will accept no payload columns";

/**
 * An invitation whose inviter declares `receive` -- what it will accept FROM the
 * acceptor. deriveAcceptedLinkageTerms mirrors it onto the acceptor's own
 * `payload.send`, which is what the acceptance writes and what
 * assertPayloadSendDisclosed holds the acceptor's metadata to. `output` overrides
 * the inviter's output direction; the acceptor's `shareWithPartner` is the mirror
 * of the inviter's `expectsOutput`, so it is what decides whether this party's
 * disclosure actually crosses.
 */
function tokenDeclaringReceive(
  receive: Array<{ name: string }> | undefined,
  output?: LinkageTerms["output"],
): InvitationToken {
  const base = sampleToken(FUTURE());
  return {
    ...base,
    linkageTerms: {
      ...base.linkageTerms,
      ...(output !== undefined ? { output } : {}),
      payload: { receive },
    },
  };
}

/** Every message an acceptance of `token` over `columns` warns with, plus
 * whatever it threw (online acceptance meets the refusal itself). */
async function acceptWarnings(params: {
  token: InvitationToken;
  columns: string[];
  loggerName: string;
  mode?: "online" | "offline";
  options?: CommonBootstrapOptions;
}): Promise<{ warnings: string[]; error: unknown; ready: unknown }> {
  const { token, columns, loggerName, mode = "offline" } = params;
  const options = params.options ?? testOptions();
  const input = writeInputCSV(columns);
  const log = getLogger(loggerName);
  log.setLevel("silent");
  const warnSpy = vi.spyOn(log, "warn");
  let error: unknown;
  let ready: unknown;
  try {
    const encoded = await encodeInvitation(token);
    ready = await validateAccept({
      resolved:
        mode === "online"
          ? {
              mode: "online",
              url: new URL("sftp://host/drop"),
              invitation: encoded,
              input,
            }
          : { mode: "offline", invitation: encoded, input },
      options,
      log,
    });
  } catch (err) {
    error = err;
  }
  const warnings = warnSpy.mock.calls.map((c) => String(c[0]));
  warnSpy.mockRestore();
  fs.rmSync(input, { force: true });
  return { warnings, error, ready };
}

/** The one refused-disclosure warning in `warnings`, asserted to be exactly one. */
function refusedDisclosureWarning(warnings: string[]): string {
  const refused = warnings.filter((m) => m.includes(REFUSED_DISCLOSURE_CLAUSE));
  expect(refused).toHaveLength(1);
  return refused[0];
}

// --- the count-only shape, at the accept boundary ----------------------------

/** An invitation in exactly the count-only shape the specification admits: the
 * default terms narrowed to one linkage key, which is the only one of the five
 * rules the defaults break. */
function countOnlyToken(): InvitationToken {
  const base = sampleToken(FUTURE());
  return {
    ...base,
    linkageTerms: {
      ...base.linkageTerms,
      algorithm: "psi-c",
      linkageKeys: base.linkageTerms.linkageKeys.slice(0, 1),
    },
  };
}

describe("the count-only shape, at the accept boundary", () => {
  test("validateAccept: refuses a count-only invitation whose own columns would send one", async () => {
    // The count-only rule this party's own metadata holds: `diagnosis` is an
    // unrecognized column, which inferMetadata marks for transmission, and a
    // count-only exchange moves no data column in either direction. Refused at the
    // accept boundary, naming what to clear -- not left to the algorithm gate,
    // which says only that no count-only run path exists yet.
    const { error, ready } = await acceptWarnings({
      token: countOnlyToken(),
      columns: [...LINKAGE_COLUMNS, "diagnosis"],
      loggerName: "accept-count-only-transmits",
    });
    expect(ready).toBeUndefined();
    expect(error).toBeInstanceOf(UsageError);
    expect((error as Error).message).toMatch(/transmits no data columns/);
    // Named by the rule rather than by the column, matching every other refusal
    // composed beside a partner's document.
    expect((error as Error).message).not.toContain("diagnosis");
  });

  test("validateAccept: online refuses the same arrangement, writing nothing", async () => {
    const options = testOptions();
    const { error } = await acceptWarnings({
      token: countOnlyToken(),
      columns: [...LINKAGE_COLUMNS, "diagnosis"],
      loggerName: "accept-count-only-transmits-online",
      mode: "online",
      options,
    });
    expect(error).toBeInstanceOf(UsageError);
    expect((error as Error).message).toMatch(/transmits no data columns/);
    expect(fs.existsSync(options.configFile)).toBe(false);
    expect(fs.existsSync(options.keyFile)).toBe(false);
  });

  test("validateAccept: a count-only invitation over a file that sends nothing is not refused here", async () => {
    // The rule reads what this party's marks would transmit, not the algorithm
    // alone: a file of recognized linkage columns discloses nothing, so acceptance
    // completes and the count-only algorithm meets only the run-side gate.
    const { error, ready } = await acceptWarnings({
      token: countOnlyToken(),
      columns: LINKAGE_COLUMNS,
      loggerName: "accept-count-only-sends-nothing",
    });
    expect(error).toBeUndefined();
    expect((ready as { mode: string }).mode).toBe("offline");
  });

  test("validateAccept: a crafted count-only invitation outside the shape is refused at the decode", async () => {
    // The four rules the terms hold, on the partner's document: minting one is
    // refused by the same schema, so it reaches this party only as a crafted token
    // -- and the decode is where the acceptance meets it, before the prompt.
    const base = countOnlyToken();
    const crafted = await encodeRaw({
      ...base,
      linkageTerms: {
        ...base.linkageTerms,
        linkageStrategy: "single-pass",
      },
    });
    const err = await decodeAndValidateInvitation(crafted).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(UsageError);
    expect((err as Error).message).toMatch(/linkage strategy to "cascade"/);
  });

  test("validateAccept: warns when the input discloses columns the invitation accepts none of", async () => {
    // An explicit empty receive is the inviter declaring it takes no payload column,
    // while inferMetadata defaults every unrecognized column to is_payload: true --
    // so the configuration this acceptance writes cannot run (prepareForExchange
    // refuses it before any data is sent). One warning, however many columns, naming them
    // and both remedies, while the operator can still decline.
    const hostile = `notes${ESC}[0m`;
    const { warnings, ready } = await acceptWarnings({
      token: tokenDeclaringReceive([]),
      columns: [...LINKAGE_COLUMNS, "diagnosis", hostile],
      loggerName: "accept-refused-disclosure-warn",
    });
    expect((ready as { mode: string }).mode).toBe("offline");
    const refused = refusedDisclosureWarning(warnings);
    expect(refused).toContain("is_payload: false");
    expect(refused).toContain("ask your partner for an invitation");
    // One entry per line, the rendering both consent surfaces use, so a name
    // holding the list separator is not misread as two entries.
    expect(refused).toContain("\n  - diagnosis");
    expect(refused).toContain(`\n  - ${sanitizeForDisplay(hostile)}`);
    // The names are the operator's own file's and reach the log sink without ever
    // becoming an Error, so the sink is where they are escaped.
    expect(refused).not.toContain(ESC);
    // Offline acceptance completes, so it says where the refusal actually arrives.
    expect(refused).toContain("psilink exchange");
  });

  test("validateAccept: online states that the acceptance itself stops, and it does", async () => {
    // prepareForOnlineExchange runs inside validateAccept, so the refusal the
    // warning names aborts the acceptance itself rather than waiting for a later
    // command -- a configuration error, before the terms display and before any
    // file is written.
    const options = testOptions();
    const { warnings, error } = await acceptWarnings({
      token: tokenDeclaringReceive([]),
      columns: [...LINKAGE_COLUMNS, "diagnosis"],
      loggerName: "accept-refused-disclosure-online",
      mode: "online",
      options,
    });
    const refused = refusedDisclosureWarning(warnings);
    expect(refused).toContain("exit 64");
    expect(refused).not.toContain("psilink exchange");
    expect(error).toBeInstanceOf(UsageError);
    // The refusal the warning describes, not some other usage error on the path.
    expect((error as Error).message).toContain("payload.send");
    expect(fs.existsSync(options.configFile)).toBe(false);
    expect(fs.existsSync(options.keyFile)).toBe(false);
  });

  test("validateAccept: stays silent where the disclosure and the invitation can agree", async () => {
    // An ABSENT receive is not a mismatch: the inviter left the direction lazy and
    // reconciles against this party's own disclosure when the exchange runs.
    expect(
      (
        await acceptWarnings({
          token: tokenDeclaringReceive(undefined),
          columns: [...LINKAGE_COLUMNS, "diagnosis"],
          loggerName: "accept-refused-disclosure-absent",
        })
      ).warnings,
    ).not.toContainEqual(expect.stringContaining(REFUSED_DISCLOSURE_CLAUSE));

    // An empty receive against a file that discloses nothing is already agreed: the
    // acceptance writes a configuration that sends nothing and runs.
    expect(
      (
        await acceptWarnings({
          token: tokenDeclaringReceive([]),
          columns: LINKAGE_COLUMNS,
          loggerName: "accept-refused-disclosure-nothing-sent",
        })
      ).warnings,
    ).not.toContainEqual(expect.stringContaining(REFUSED_DISCLOSURE_CLAUSE));

    // A non-empty receive that disagrees with the disclosed set is a different
    // comparison with different remedies, and is not what this warning covers.
    expect(
      (
        await acceptWarnings({
          token: tokenDeclaringReceive([{ name: "dose" }]),
          columns: [...LINKAGE_COLUMNS, "diagnosis"],
          loggerName: "accept-refused-disclosure-nonempty",
        })
      ).warnings,
    ).not.toContainEqual(expect.stringContaining(REFUSED_DISCLOSURE_CLAUSE));
  });

  test("validateAccept: stays silent, and the display stays consistent, when the inviting party receives no result", async () => {
    // The refusal is gated on the direction, so this pair is not refused: the
    // inviting party is entitled to no result, the payload step transmits nothing
    // to it whatever the metadata discloses, and the exchange runs. Warning here
    // would put "the exchange refuses to run" directly above a consent line reading
    // that no payload is sent.
    const token = tokenDeclaringReceive([], {
      expectsOutput: false,
      shareWithPartner: true,
    });
    const { warnings, error } = await acceptWarnings({
      token,
      columns: [...LINKAGE_COLUMNS, "diagnosis"],
      loggerName: "accept-refused-disclosure-no-inviter-output",
    });
    expect(error).toBeUndefined();
    expect(warnings).not.toContainEqual(
      expect.stringContaining(REFUSED_DISCLOSURE_CLAUSE),
    );
    // The line the warning would have contradicted, on the same invitation.
    const log = getLogger(
      "accept-refused-disclosure-no-inviter-output-display",
    );
    log.setLevel("silent");
    expect(renderDisplayInvitation(log, token, ["diagnosis"])).toContain(
      "no payload is sent",
    );
  });

  test("validateAccept: offline warns that a --server-* override is ignored", async () => {
    // The offline path builds the connection block from connectionFromEndpoint (a
    // placeholder here, since sampleToken has no endpoint; or an endpoint seed
    // when one is present -- the warning reads only `options`, so it fires the same
    // way either way), so a --server-* override cannot take effect; it must be
    // reported rather than silently dropped.
    const input = writeInputCSV(["first_name", "last_name", "dob", "ssn"]);
    const log = getLogger("accept-offline-override-warn");
    log.setLevel("silent");
    const warnSpy = vi.spyOn(log, "warn");
    try {
      const encoded = await encodeInvitation(sampleToken(FUTURE()));
      const ready = await validateAccept({
        resolved: { mode: "offline", invitation: encoded, input },
        options: testOptions({ serverUsername: "alice" }),
        log,
      });
      expect(ready.mode).toBe("offline");
      expect(
        warnSpy.mock.calls.some(
          (c) =>
            typeof c[0] === "string" &&
            c[0].includes("--server-username") &&
            c[0].includes("no effect on an offline invite/accept"),
        ),
      ).toBe(true);
    } finally {
      warnSpy.mockRestore();
      fs.rmSync(input, { force: true });
    }
  });

  test("validateAccept: online does not warn about a --server-* override (it is applied)", async () => {
    // The online path builds the connection from the URL through
    // applyConnectionOverrides, so the override takes effect and no
    // ignored-override warning is emitted.
    const dir = fs.mkdtempSync(
      path.join(tmpdir(), "psilink-accept-online-override-"),
    );
    const input = path.join(dir, "input.csv");
    fs.writeFileSync(
      input,
      "first_name,last_name,dob,ssn\nAlice,Smith,1990-01-02,123456789\n",
    );
    const log = getLogger("accept-online-override-nowarn");
    log.setLevel("silent");
    const warnSpy = vi.spyOn(log, "warn");
    try {
      const encoded = await encodeInvitation(sampleToken(FUTURE()));
      const ready = await validateAccept({
        resolved: {
          mode: "online",
          url: new URL("sftp://host/drop"),
          invitation: encoded,
          input,
        },
        options: testOptions({
          configFile: path.join(dir, "psilink.yaml"),
          keyFile: path.join(dir, ".psilink.key"),
          serverUsername: "alice",
        }),
        log,
      });
      expect(ready.mode).toBe("online");
      if (ready.mode !== "online") return;
      if (ready.connection.channel !== "sftp") throw new Error("expected sftp");
      expect(ready.connection.server.username).toBe("alice");
      expect(
        warnSpy.mock.calls.some(
          (c) =>
            typeof c[0] === "string" &&
            c[0].includes("no effect on an offline invite/accept"),
        ),
      ).toBe(false);
    } finally {
      warnSpy.mockRestore();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("validateAccept: offline warns that a connection-options override is ignored", async () => {
    // The offline path builds the connection block from connectionFromEndpoint
    // (placeholder or endpoint seed), which has no `options` block, so a
    // connection-options override cannot take effect; it must be reported with a
    // remedy pointing at connection.options, distinct from the server warning.
    const input = writeInputCSV(["first_name", "last_name", "dob", "ssn"]);
    const log = getLogger("accept-offline-opt-override-warn");
    log.setLevel("silent");
    const warnSpy = vi.spyOn(log, "warn");
    try {
      const encoded = await encodeInvitation(sampleToken(FUTURE()));
      const ready = await validateAccept({
        resolved: { mode: "offline", invitation: encoded, input },
        options: testOptions({ retainFiles: true }),
        log,
      });
      expect(ready.mode).toBe("offline");
      expect(
        warnSpy.mock.calls.some(
          (c) =>
            typeof c[0] === "string" &&
            c[0].includes("--retain-files") &&
            c[0].includes("connection.options"),
        ),
      ).toBe(true);
    } finally {
      warnSpy.mockRestore();
      fs.rmSync(input, { force: true });
    }
  });

  test("validateAccept: offline does not warn about connection.options when no options flag is set", async () => {
    // No connection-options flag is set, so the connection.options warning must
    // stay silent on the offline accept path.
    const input = writeInputCSV(["first_name", "last_name", "dob", "ssn"]);
    const log = getLogger("accept-offline-no-opt-warn");
    log.setLevel("silent");
    const warnSpy = vi.spyOn(log, "warn");
    try {
      const encoded = await encodeInvitation(sampleToken(FUTURE()));
      const ready = await validateAccept({
        resolved: { mode: "offline", invitation: encoded, input },
        options: testOptions(),
        log,
      });
      expect(ready.mode).toBe("offline");
      expect(
        warnSpy.mock.calls.some(
          (c) =>
            typeof c[0] === "string" && c[0].includes("connection.options"),
        ),
      ).toBe(false);
    } finally {
      warnSpy.mockRestore();
      fs.rmSync(input, { force: true });
    }
  });

  test("validateAccept: online does not warn about a connection-options override (it is applied)", async () => {
    // The online path builds the connection from the URL through
    // applyConnectionOverrides, so a connection-options override takes effect and
    // no ignored-override warning is emitted.
    const dir = fs.mkdtempSync(
      path.join(tmpdir(), "psilink-accept-online-opt-override-"),
    );
    const input = path.join(dir, "input.csv");
    fs.writeFileSync(
      input,
      "first_name,last_name,dob,ssn\nAlice,Smith,1990-01-02,123456789\n",
    );
    const log = getLogger("accept-online-opt-override-nowarn");
    log.setLevel("silent");
    const warnSpy = vi.spyOn(log, "warn");
    try {
      const encoded = await encodeInvitation(sampleToken(FUTURE()));
      const ready = await validateAccept({
        resolved: {
          mode: "online",
          url: new URL("sftp://host/drop"),
          invitation: encoded,
          input,
        },
        options: testOptions({
          configFile: path.join(dir, "psilink.yaml"),
          keyFile: path.join(dir, ".psilink.key"),
          maxReconnectAttempts: 5,
        }),
        log,
      });
      expect(ready.mode).toBe("online");
      if (ready.mode !== "online") return;
      expect(ready.connection.options?.maxReconnectAttempts).toBe(5);
      expect(
        warnSpy.mock.calls.some(
          (c) =>
            typeof c[0] === "string" && c[0].includes("connection.options"),
        ),
      ).toBe(false);
    } finally {
      warnSpy.mockRestore();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("validateAccept: offline split-seed accept does not warn on --no-retain-files (seed forces retain on)", async () => {
    // A split-directory endpoint seeds the connection with SPLIT_SEED_OPTIONS (the
    // retain trio = true) and applies no override, so an explicit --no-retain-files
    // (retainFiles === false) is dropped and the seed's retain_files: true stands.
    // The `=== true` gate declines to warn on the negated form -- it is not an
    // enabling override, and warning would name --retain-files for a flag the
    // operator typed as --no-retain-files. This mirrors the online split path,
    // which also forces retain on and warns nothing. Pins the SPLIT_SEED_OPTIONS x
    // gate interaction the helper-level tests do not reach.
    const input = writeInputCSV(["first_name", "last_name", "dob", "ssn"]);
    const endpoint: ConnectionEndpoint = {
      channel: "sftp",
      host: "inviter-host",
      inboundPath: "/exchange/inviter-in",
      outboundPath: "/exchange/inviter-out",
    };
    const log = getLogger("accept-offline-split-seed-no-retain");
    log.setLevel("silent");
    const warnSpy = vi.spyOn(log, "warn");
    try {
      const encoded = await encodeInvitation(
        splitEndpointToken(FUTURE(), endpoint),
      );
      const ready = await validateAccept({
        resolved: { mode: "offline", invitation: encoded, input },
        options: testOptions({ retainFiles: false }),
        log,
      });
      expect(ready.mode).toBe("offline");
      if (ready.mode !== "offline") return;
      if (ready.connection.channel !== "sftp") throw new Error("expected sftp");
      // The seed forces retain on despite --no-retain-files.
      expect(ready.connection.options?.retainFiles).toBe(true);
      // No --retain-files warning: the gate declines on the negated form.
      expect(
        warnSpy.mock.calls.some(
          (c) =>
            typeof c[0] === "string" &&
            c[0].includes("--retain-files") &&
            c[0].includes("connection.options"),
        ),
      ).toBe(false);
    } finally {
      warnSpy.mockRestore();
      fs.rmSync(input, { force: true });
    }
  });
});

// --- the WebRTC peer-addressing role -----------------------------------------

describe("the WebRTC peer-addressing role", () => {
  test("validateAccept: offline stamps role: acceptor onto a seeded webrtc connection", async () => {
    // The accepting side derives its WebRTC rendezvous peer id from the `acceptor`
    // label, and the persisted connection block is the only place a later
    // `psilink exchange` can learn which side it is on -- the operator never
    // authors it. Given no input file this acceptance writes that block and stops,
    // so the stamp is asserted on the connection it writes.
    const endpoint: ConnectionEndpoint = {
      channel: "webrtc",
      host: "peer.example.org",
      path: "/psi",
    };
    const encoded = await encodeInvitation(sampleToken(FUTURE(), endpoint));
    const ready = await validateAccept({
      resolved: { mode: "offline", invitation: encoded },
      options: testOptions(),
      log: silentLog,
    });
    expect(ready.mode).toBe("offline");
    if (ready.mode !== "offline") return;
    if (ready.connection.channel !== "webrtc")
      throw new Error("expected webrtc");
    expect(ready.connection.role).toBe("acceptor");
    // The stamp rides along with the seeded locator rather than replacing it.
    expect(ready.connection.server.host).toBe("peer.example.org");
    expect(ready.connection.server.path).toBe("/psi");
  });

  test("validateAccept: offline leaves a non-webrtc connection without a role", async () => {
    // `role` is a WebRTC-only field, so an sftp acceptance (here the placeholder
    // block an endpoint-less invitation seeds) has no such key at all.
    const input = writeInputCSV(["first_name", "last_name", "dob", "ssn"]);
    try {
      const encoded = await encodeInvitation(sampleToken(FUTURE()));
      const ready = await validateAccept({
        resolved: { mode: "offline", invitation: encoded, input },
        options: testOptions(),
        log: silentLog,
      });
      expect(ready.mode).toBe("offline");
      if (ready.mode !== "offline") return;
      expect(ready.connection.channel).toBe("sftp");
      expect(Object.keys(ready.connection)).not.toContain("role");
    } finally {
      fs.rmSync(input, { force: true });
    }
  });
});

// --- accepting and running a webrtc exchange in one command ------------------
// An invitation naming a webrtc coordination server has everything the
// exchange needs, so an acceptance given an input file runs it rather than
// printing a second command for the operator to type while the inviter sits
// inside its accept timeout. Everything else -- another channel's endpoint, no
// endpoint, no input file, a kept configuration -- keeps the two-command shape.

/** A webrtc endpoint pointing at a coordination server, host and mount both. */
const WEBRTC_ENDPOINT: ConnectionEndpoint = {
  channel: "webrtc",
  host: "peer.example.org",
  path: "/psi",
};

/**
 * A silent logger whose `info` and `warn` lines land in `messages`, for the
 * diagnostics an acceptance reports rather than throws. Each call takes a fresh
 * logger name, so no two tests share a spy through loglevel's own registry.
 */
function recordingLog(messages: string[]): ReturnType<typeof getLogger> {
  const log = getLogger(`accept-recording-${optionsCounter++}`);
  log.setLevel("silent");
  for (const level of ["info", "warn"] as const)
    vi.spyOn(log, level).mockImplementation((...args: unknown[]) => {
      messages.push(args.map(String).join(" "));
    });
  return log;
}

describe("accepting and running a webrtc exchange in one command", () => {
  test("validateAccept: a webrtc invitation with an input file prepares the exchange it accepts", async () => {
    const input = writeInputCSV(["first_name", "last_name", "dob", "ssn"]);
    try {
      const token = sampleToken(FUTURE(), WEBRTC_ENDPOINT);
      const encoded = await encodeInvitation({
        ...token,
        disclosedPayloadColumns: ["diagnosis"],
      });
      const ready = await validateAccept({
        resolved: { mode: "offline", invitation: encoded, input },
        options: testOptions(),
        log: silentLog,
      });
      expect(ready.mode).toBe("endpointRun");
      if (ready.mode !== "endpointRun") return;
      // The connection this run dials is the invitation's own locator, stamped
      // with the end this command takes; nothing else supplies either.
      expect(ready.connection.channel).toBe("webrtc");
      expect(ready.connection.role).toBe("acceptor");
      expect(ready.connection.server).toMatchObject({
        host: "peer.example.org",
        path: "/psi",
      });
      // The prepared exchange has the same two bindings the URL-driven mode
      // sets, so this single run enforces what the acceptance consented to.
      expect(ready.prepared.expectedPayloadColumns).toEqual(["diagnosis"]);
      expect(ready.prepared.expectedPartnerDeduplicate).toBe(
        token.linkageTerms.deduplicate,
      );
    } finally {
      fs.rmSync(input, { force: true });
    }
  });

  test("validateAccept: a webrtc invitation with no input file keeps the two-command shape", async () => {
    // No dataset, so there is no exchange to run: the acceptance writes the
    // configuration and key file, and `psilink exchange` conducts it later.
    const encoded = await encodeInvitation(
      sampleToken(FUTURE(), WEBRTC_ENDPOINT),
    );
    const ready = await validateAccept({
      resolved: { mode: "offline", invitation: encoded },
      options: testOptions(),
      log: silentLog,
    });
    expect(ready.mode).toBe("offline");
  });

  test("validateAccept: an invitation holding no webrtc endpoint keeps the two-command shape", async () => {
    // The fallback the acceptance criteria name: no endpoint at all, and an
    // endpoint on a channel whose credentials the operator still supplies by hand.
    // Neither fails; each writes a connection block to complete.
    const input = writeInputCSV(["first_name", "last_name", "dob", "ssn"]);
    try {
      for (const endpoint of [
        undefined,
        {
          channel: "sftp" as const,
          host: "sftp.example.org",
          path: "/exchange",
        },
      ]) {
        const encoded = await encodeInvitation(sampleToken(FUTURE(), endpoint));
        const ready = await validateAccept({
          resolved: { mode: "offline", invitation: encoded, input },
          options: testOptions(),
          log: silentLog,
        });
        expect(ready.mode).toBe("offline");
      }
    } finally {
      fs.rmSync(input, { force: true });
    }
  });

  test("validateAccept: a webrtc acceptance over a kept configuration keeps the two-command shape", async () => {
    // The kept configuration governs its own exchange -- `psilink exchange` loads
    // it, resolves its @path references and its own server.key/secure, and dials
    // what it says -- so running the endpoint-built connection here would dial a
    // coordination server that configuration does not name.
    const options = testOptions();
    writeExistingConfig(options.configFile);
    const input = writeInputCSV(["first_name", "last_name", "dob", "ssn"]);
    const messages: string[] = [];
    // The kept configuration's label differs from this run's flag, so the
    // no-effect notice writes where the prompt asks; capture it here rather than
    // in the suite's own output.
    const stdio = captureStdio();
    try {
      const encoded = await encodeInvitation(
        sampleToken(FUTURE(), WEBRTC_ENDPOINT),
      );
      const ready = await validateAccept({
        resolved: { mode: "offline", invitation: encoded, input },
        options,
        log: recordingLog(messages),
      });
      expect(ready.reuseExistingConfig).toBe(true);
      expect(ready.mode).toBe("offline");
      // Reported rather than silent: an operator who passed an input file expecting
      // a run reads why one did not happen, and what to run instead.
      expect(
        messages.some(
          (m) =>
            m.includes("keeps the existing configuration") &&
            m.includes("psilink exchange"),
        ),
      ).toBe(true);
    } finally {
      stdio.restore();
      fs.rmSync(options.configFile, { force: true });
      fs.rmSync(input, { force: true });
    }
  });

  test("validateAccept: a partner endpoint the dial would refuse is refused before the prompt", async () => {
    // The security invariant: a partner-supplied locator reaches the dial through
    // the same refusals a CLI-authored connection does. The endpoint schema bounds
    // host and path by length only, so a delimiter that could move the signaling
    // authority is caught by the shared broker-location resolver -- here, before
    // the terms are displayed and before anything is written.
    const input = writeInputCSV(["first_name", "last_name", "dob", "ssn"]);
    try {
      for (const endpoint of [
        { ...WEBRTC_ENDPOINT, host: "peer.example.org@evil.example" },
        { ...WEBRTC_ENDPOINT, path: "psi" },
        { ...WEBRTC_ENDPOINT, path: "/psi?to=elsewhere" },
      ]) {
        const encoded = await encodeInvitation(sampleToken(FUTURE(), endpoint));
        const options = testOptions();
        await expect(
          validateAccept({
            resolved: { mode: "offline", invitation: encoded, input },
            options,
            log: silentLog,
          }),
        ).rejects.toBeInstanceOf(UsageError);
        expect(fs.existsSync(options.configFile)).toBe(false);
        expect(fs.existsSync(options.keyFile)).toBe(false);
      }
    } finally {
      fs.rmSync(input, { force: true });
    }
  });

  test("validateAccept: a partner endpoint that forms no dialable address is refused as a usage error", async () => {
    // The shapes the delimiter refusal above does not cover: the endpoint schema
    // bounds the host by length alone, so one holding a port or an unterminated
    // IPv6 bracket arrives and fails the authority parse instead. Deterministic in
    // the invitation alone, so it exits 64 like its delimiter sibling -- a 69 would
    // set an unattended supervisor re-running an acceptance that cannot dial -- and
    // it names the invitation as the locator's source, there being no connection
    // block on this path the operator could go and check.
    const input = writeInputCSV(["first_name", "last_name", "dob", "ssn"]);
    try {
      for (const host of ["peer.example.org:9000", "[::1"]) {
        const encoded = await encodeInvitation(
          sampleToken(FUTURE(), { ...WEBRTC_ENDPOINT, host }),
        );
        const options = testOptions();
        let refusal: unknown;
        try {
          await validateAccept({
            resolved: { mode: "offline", invitation: encoded, input },
            options,
            log: silentLog,
          });
        } catch (err) {
          refusal = err;
        }
        expect(refusal).toBeInstanceOf(UsageError);
        expect((refusal as Error).message).toBe(
          INVITATION_BROKER_ADDRESS_REFUSED,
        );
        expect(exitCodeForError(refusal)).toBe(64);
        // The refusal lands before the terms are displayed, so an unusable
        // endpoint costs neither a confirmation nor a written file.
        expect(fs.existsSync(options.configFile)).toBe(false);
        expect(fs.existsSync(options.keyFile)).toBe(false);
      }
    } finally {
      fs.rmSync(input, { force: true });
    }
  });

  test("validateAccept: an OUTPUT_FILE an acceptance cannot honor is reported, not dropped", async () => {
    // The result destination belongs to a run. An acceptance that writes only a
    // configuration and key file has no result to send there, so the positional is
    // named rather than silently ignored -- and a running acceptance passes it
    // through to the bootstrap instead.
    const input = writeInputCSV(["first_name", "last_name", "dob", "ssn"]);
    const stops: string[] = [];
    const runs: string[] = [];
    try {
      const noEndpoint = await encodeInvitation(sampleToken(FUTURE()));
      await validateAccept({
        resolved: {
          mode: "offline",
          invitation: noEndpoint,
          input,
          output: "results.csv",
        },
        options: testOptions(),
        log: recordingLog(stops),
      });
      expect(stops.some((m) => m.includes("OUTPUT_FILE"))).toBe(true);

      const webrtc = await encodeInvitation(
        sampleToken(FUTURE(), WEBRTC_ENDPOINT),
      );
      const ready = await validateAccept({
        resolved: {
          mode: "offline",
          invitation: webrtc,
          input,
          output: "results.csv",
        },
        options: testOptions(),
        log: recordingLog(runs),
      });
      expect(runs.some((m) => m.includes("OUTPUT_FILE"))).toBe(false);
      expect(ready.mode).toBe("endpointRun");
      if (ready.mode !== "endpointRun") return;
      expect(ready.output).toBe("results.csv");
    } finally {
      fs.rmSync(input, { force: true });
    }
  });
});

// --- reconciling a pre-existing config ---------------------------------------

/** Write a config whose linkage terms agree with the invitation's by default
 *  (same default terms, identity aside), so a test perturbs only what it means
 *  to test. */
function writeExistingConfig(
  configPath: string,
  overrides: {
    terms?: LinkageTerms;
    connection?: ConnectionConfig;
  } = {},
): void {
  saveConfig(configPath, {
    connection: overrides.connection ?? {
      channel: "filedrop",
      path: "/mnt/share",
    },
    linkageTerms: overrides.terms ?? sampleTerms("Acceptor Org"),
  });
}

/**
 * Accept over a configuration already at the path, in either reuse mode,
 * reporting the prepared acceptance alongside every line it emitted -- the calls
 * it made on the logger, the lines that survived the level to reach the log's
 * own sink, and what it wrote where the confirmation prompt asks. The saved
 * connection agrees with the online URL, so the reuse verdict has no
 * connection divergence of its own and the only notice a case can raise is the
 * one it is about.
 *
 * `logLevel` and `logFile` are the routing the operator chose, which is what
 * decides whether a consent line needs a copy where the prompt asks; the
 * diagnostic sink is captured for the same run rather than left to the suite's
 * own output, so a case can compare the two destinations.
 */
async function acceptOverKeptConfig(params: {
  terms: LinkageTerms;
  identity: string | undefined;
  loggerName: string;
  mode?: "online" | "offline";
  logLevel?: "silent" | "error" | "warn";
  logFile?: string;
  consentToTerms?: boolean;
}): Promise<{
  ready: Awaited<ReturnType<typeof validateAccept>>;
  warnings: string[];
  logged: string[];
  promptWrites: string;
}> {
  const {
    terms,
    identity,
    loggerName,
    mode = "offline",
    logLevel = "silent",
    logFile,
    consentToTerms = false,
  } = params;
  const dir = fs.mkdtempSync(path.join(tmpdir(), "psilink-accept-kept-"));
  const configFile = path.join(dir, "psilink.yaml");
  const keyFile = path.join(dir, ".psilink.key");
  const input = path.join(dir, "input.csv");
  fs.writeFileSync(
    input,
    "first_name,last_name,dob,ssn\nAlice,Smith,1990-01-02,123456789\n",
  );
  saveConfig(configFile, {
    connection: { channel: "sftp", server: { host: "host" } },
    linkageTerms: terms,
  });
  const log = getLogger(loggerName);
  log.setLevel(logLevel);
  const warnSpy = vi.spyOn(log, "warn");
  const logged: string[] = [];
  const previousSink = getDiagnosticSink();
  setDiagnosticSink((_method, _prefix, args) => {
    logged.push(args.map((arg) => String(arg)).join(" "));
  });
  const stdio = captureStdio();
  try {
    const encoded = await encodeInvitation(sampleToken(FUTURE()));
    const ready = await validateAccept({
      resolved:
        mode === "online"
          ? {
              mode: "online",
              url: new URL("sftp://host"),
              invitation: encoded,
              input,
            }
          : { mode: "offline", invitation: encoded, input },
      options: testOptions({ configFile, keyFile, identity, logFile }),
      consentToTerms,
      log,
    });
    return {
      ready,
      warnings: warnSpy.mock.calls.map((c) => String(c[0])),
      logged,
      promptWrites: stdio.stderrWrites.join(""),
    };
  } finally {
    stdio.restore();
    setDiagnosticSink(previousSink);
    warnSpy.mockRestore();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** The distinctive clause of the flag-had-no-effect notice. */
const IDENTITY_NO_EFFECT_CLAUSE = "has no effect on an acceptance that keeps";

/**
 * The one no-effect notice the operator was shown, asserted to be exactly one.
 * Read off the prompt transcript, which is where the consent surface's sink puts
 * a line on a run that stops to ask.
 */
function identityNoEffectNotice(promptWrites: string): string {
  const notices = promptWrites
    .split("\n")
    .filter((line) => line.includes(IDENTITY_NO_EFFECT_CLAUSE));
  expect(notices).toHaveLength(1);
  return notices[0];
}

/** The default terms with their first two keys swapped: rules that no longer
 *  support the rule-set citation the same terms hold, key order being cascade
 *  order. */
function termsCitingASetTheyLeft(identity: string): LinkageTerms {
  const terms = sampleTerms(identity);
  const [first, second, ...rest] = terms.linkageKeys;
  return { ...terms, linkageKeys: [second!, first!, ...rest] };
}

describe("reconciling a pre-existing config", () => {
  test("validateAccept: offline reuses a config whose linkage terms match the invitation", async () => {
    const options = testOptions();
    writeExistingConfig(options.configFile);
    // The flag and the kept file name this party differently, so the no-effect
    // notice reaches the prompt's own sink; keep it out of the suite's output.
    const stdio = captureStdio();
    try {
      const encoded = await encodeInvitation(sampleToken(FUTURE()));
      const ready = await validateAccept({
        resolved: { mode: "offline", invitation: encoded },
        options,
        log: silentLog,
      });
      expect(ready.reuseExistingConfig).toBe(true);
      expect(ready.mode).toBe("offline");
    } finally {
      stdio.restore();
      fs.rmSync(options.configFile, { force: true });
    }
  });

  test("validateAccept: an acceptance that keeps an existing config takes its label and asks nothing", async () => {
    // The question exists to be remembered in the configuration the acceptance
    // writes, and this one writes none: the kept file's own linkage terms govern
    // every later run, so that file's label is what this acceptance proceeds
    // under, and there is nothing to ask.
    const options = testOptions({ identity: undefined });
    writeExistingConfig(options.configFile);
    const askIdentity = vi.fn().mockResolvedValue("Agency B");
    try {
      const encoded = await encodeInvitation(sampleToken(FUTURE()));
      const ready = await validateAccept({
        resolved: { mode: "offline", invitation: encoded },
        options,
        askIdentity,
        log: silentLog,
      });
      expect(askIdentity).not.toHaveBeenCalled();
      expect(ready.reuseExistingConfig).toBe(true);
      expect(ready.dataSpec.linkageTerms.identity).toBe("Acceptor Org");
    } finally {
      fs.rmSync(options.configFile, { force: true });
    }
  });

  test("validateAccept: offline reuse runs under the stored label, reporting the flag as having none", async () => {
    // The kept file governs every exchange under the partnership, so a flag cannot
    // rename the party in passing: the acceptance proceeds under the stored label
    // and says so, naming both values and the field to edit.
    const { ready, promptWrites } = await acceptOverKeptConfig({
      terms: sampleTerms("Acceptor Org"),
      identity: "Agency B",
      loggerName: "accept-kept-identity-offline",
    });
    expect(ready.reuseExistingConfig).toBe(true);
    expect(ready.dataSpec.linkageTerms.identity).toBe("Acceptor Org");
    const notice = identityNoEffectNotice(promptWrites);
    expect(notice).toContain('"Agency B"');
    expect(notice).toContain('"Acceptor Org"');
    expect(notice).toContain("Edit linkage_terms.identity");
  });

  test("validateAccept: online reuse presents the stored label to the partner", async () => {
    // The path the divergence would have shown on: this run conducts the exchange
    // itself, so the name the partner reads is the prepared exchange's -- and it
    // has to be the one the kept configuration goes on sending, not a label
    // supplied for this invocation alone.
    const { ready, promptWrites } = await acceptOverKeptConfig({
      terms: sampleTerms("Acceptor Org"),
      identity: "Agency B",
      loggerName: "accept-kept-identity-online",
      mode: "online",
    });
    expect(ready.reuseExistingConfig).toBe(true);
    expect(ready.mode).toBe("online");
    if (ready.mode !== "online") return;
    expect(ready.prepared.linkageTerms.identity).toBe("Acceptor Org");
    expect(ready.dataSpec.linkageTerms.identity).toBe("Acceptor Org");
    expect(identityNoEffectNotice(promptWrites)).toContain('"Acceptor Org"');
  });

  test("validateAccept: a flag that asks for the stored label reports nothing", async () => {
    // Nothing diverged, so there is nothing to report: the notice exists to name a
    // difference between what was typed and what the run sends. A blank flag --
    // what `--identity "$ORG"` sends with ORG unset -- names nothing either. On
    // neither destination: a suppressed notice reaches the prompt's own sink no
    // more than it reaches the log.
    for (const identity of [
      "Acceptor Org",
      "  Acceptor Org  ",
      "   ",
      undefined,
    ]) {
      const { warnings, promptWrites } = await acceptOverKeptConfig({
        terms: sampleTerms("Acceptor Org"),
        identity,
        loggerName: `accept-kept-identity-agrees-${String(identity)}`,
      });
      expect(
        warnings.filter((m) => m.includes(IDENTITY_NO_EFFECT_CLAUSE)),
      ).toEqual([]);
      expect(promptWrites).not.toContain(IDENTITY_NO_EFFECT_CLAUSE);
    }
  });

  test("validateAccept: the no-effect notice reaches the prompt whatever the log routing", async () => {
    // The operator answers the y/N for the name this notice reports, so it takes
    // the consent surface's routing rather than a plain diagnostic's: a
    // --log-file moves the log's copy off the terminal the question is asked
    // on, and a level above `warn` drops that copy altogether. Under either, the
    // notice is still written where the prompt asks -- the promise docs/CLI.md
    // makes under acceptance. The `--log-file` value is what the sink reads to
    // decide that, so nothing has to be written at the path for the case to hold.
    for (const routing of [
      { logLevel: "warn" as const, logFile: path.join(tmpdir(), "accept.log") },
      { logLevel: "error" as const, logFile: undefined },
    ]) {
      const { promptWrites } = await acceptOverKeptConfig({
        terms: sampleTerms("Acceptor Org"),
        identity: "Agency B",
        loggerName: `accept-kept-identity-routed-${routing.logLevel}`,
        ...routing,
      });
      expect(promptWrites).toContain(IDENTITY_NO_EFFECT_CLAUSE);
      expect(promptWrites).toContain('"Agency B"');
      expect(promptWrites).toContain('"Acceptor Org"');
    }
  });

  test("validateAccept: on the default routing the notice is shown once, not copied", async () => {
    // The prompt's own line already lands on the terminal the log would have used,
    // so a second copy would print the notice twice -- once prefixed and once not.
    const { logged, promptWrites } = await acceptOverKeptConfig({
      terms: sampleTerms("Acceptor Org"),
      identity: "Agency B",
      loggerName: "accept-kept-identity-default-routing",
      logLevel: "warn",
    });
    expect(identityNoEffectNotice(promptWrites)).toContain('"Agency B"');
    expect(
      logged.filter((line) => line.includes(IDENTITY_NO_EFFECT_CLAUSE)),
    ).toEqual([]);
  });

  test("validateAccept: an unattended acceptance keeps the notice in the log alone", async () => {
    // --consent-to-terms asks nothing, so there is no question for the notice to
    // accompany and it stays diagnostic output on the routing the operator chose
    // -- at `warn`, which a level that drops the terms display still records. The
    // routing here is the one that forces a prompt copy on an asking run, so what
    // this measures is the unattended path declining to write one.
    const { logged, promptWrites } = await acceptOverKeptConfig({
      terms: sampleTerms("Acceptor Org"),
      identity: "Agency B",
      loggerName: "accept-kept-identity-unattended",
      logLevel: "warn",
      logFile: path.join(tmpdir(), "accept-unattended.log"),
      consentToTerms: true,
    });
    expect(
      logged.filter((line) => line.includes(IDENTITY_NO_EFFECT_CLAUSE)),
    ).toHaveLength(1);
    expect(promptWrites).toBe("");
  });

  test("validateAccept: a kept configuration holding no identity refuses the acceptance", async () => {
    // The acceptance writes no configuration, so a label supplied here would name
    // this party for one run and leave every later one unnamed -- which is the
    // refusal rather than something a flag can hide.
    for (const stored of [undefined, "   "])
      await expect(
        acceptOverKeptConfig({
          terms: { ...sampleTerms("Acceptor Org"), identity: stored },
          identity: "Agency B",
          loggerName: "accept-kept-identity-absent",
        }),
      ).rejects.toThrow("has no linkage_terms.identity");
  });

  test("validateAccept: a kept configuration still holding the placeholder refuses", async () => {
    // The template's own instruction to name the party is not a name, and reading
    // the label out of a file rather than off the command line does not make it
    // one.
    await expect(
      acceptOverKeptConfig({
        terms: {
          ...sampleTerms("Acceptor Org"),
          identity: PLACEHOLDER_IDENTITY,
        },
        identity: undefined,
        loggerName: "accept-kept-identity-placeholder",
      }),
    ).rejects.toThrow(`is still "${PLACEHOLDER_IDENTITY}"`);
  });

  test("validateAccept: the no-effect notice escapes both labels it reports", async () => {
    // Neither value is psilink's: one was typed at the command line and one read
    // out of a file, and the consent-surface sink this notice takes is their
    // display boundary.
    const flag = `Agency B${ESC}[0m`;
    const stored = `Acceptor Org${RLO}`;
    const { promptWrites } = await acceptOverKeptConfig({
      terms: sampleTerms(stored),
      identity: flag,
      loggerName: "accept-kept-identity-escaping",
    });
    // The prompt's own sink runs no pass of its own, so the line the question is
    // answered against is escaped only because the notice was composed that way.
    const notice = identityNoEffectNotice(promptWrites);
    expect(notice).toContain(sanitizeForDisplay(flag));
    expect(notice).toContain(sanitizeForDisplay(stored));
    expect(notice).not.toContain(ESC);
    expect(notice).not.toContain(RLO);
  });

  test("validateAccept: a reused config's rule-set citation is checked against its own rules", async () => {
    // The reconcile compares the terms that define the agreement, and the citation
    // is not one of them -- so a config agreeing with the invitation key for key
    // can still hold a citation its own rules left. Reuse proceeds, and the drift
    // is reported before the confirmation prompt.
    const options = testOptions();
    writeExistingConfig(options.configFile, {
      terms: termsCitingASetTheyLeft("Acceptor Org"),
    });
    const log = getLogger("accept-citation-drift");
    log.setLevel("silent");
    const warnSpy = vi.spyOn(log, "warn");
    // This run's flag names the party differently from the kept file, so the
    // no-effect notice reaches the prompt's own sink as well as the log.
    const stdio = captureStdio();
    try {
      const encoded = await encodeInvitation({
        ...sampleToken(FUTURE()),
        linkageTerms: termsCitingASetTheyLeft("Inviter Org"),
      });
      const ready = await validateAccept({
        resolved: { mode: "offline", invitation: encoded },
        options,
        log,
      });
      expect(ready.reuseExistingConfig).toBe(true);
      const drifted = warnSpy.mock.calls
        .map((call) => String(call[0]))
        .filter((message) => message.includes("linkage_rule_set"));
      expect(drifted).toHaveLength(1);
      expect(drifted[0]).toContain(options.configFile);
    } finally {
      stdio.restore();
      warnSpy.mockRestore();
      fs.rmSync(options.configFile, { force: true });
    }
  });

  test("validateAccept: a matching config is reconciled but a pre-existing key file still hard-aborts", async () => {
    // The reconcile path (#61) makes a pre-existing CONFIG reusable, but a
    // pre-existing KEY file must still abort -- a stale authentication token must
    // never be silently reused. The config here matches the invitation (so on its
    // own it would be reused), proving the key gate fires independently of, and
    // ahead of, config reconciliation.
    const options = testOptions();
    writeExistingConfig(options.configFile);
    fs.writeFileSync(options.keyFile, "stale-key-file");
    try {
      const encoded = await encodeInvitation(sampleToken(FUTURE()));
      const run = () =>
        validateAccept({
          resolved: { mode: "offline", invitation: encoded },
          options,
          log: silentLog,
        });
      await expect(run()).rejects.toBeInstanceOf(UsageError);
      // The abort is the key-file overwrite refusal naming the key path, not a
      // terms diff (which would name a linkage field and the config path).
      await expect(run()).rejects.toThrow(/refusing to overwrite/);
      await expect(run()).rejects.toThrow(options.keyFile);
    } finally {
      fs.rmSync(options.configFile, { force: true });
      fs.rmSync(options.keyFile, { force: true });
    }
  });

  test("validateAccept: offline fails with a diff when the config's terms disagree", async () => {
    const options = testOptions();
    const terms = sampleTerms("Acceptor Org");
    // The invitation's algorithm is the default "psi"; make the config disagree.
    terms.algorithm = "psi-c";
    writeExistingConfig(options.configFile, { terms });
    try {
      const encoded = await encodeInvitation(sampleToken(FUTURE()));
      const run = () =>
        validateAccept({
          resolved: { mode: "offline", invitation: encoded },
          options,
          log: silentLog,
        });
      await expect(run()).rejects.toBeInstanceOf(UsageError);
      // The error names the differing field and points at the config file.
      await expect(run()).rejects.toThrow(/algorithm/);
      await expect(run()).rejects.toThrow(options.configFile);
    } finally {
      fs.rmSync(options.configFile, { force: true });
    }
  });

  test("validateAccept: a schema-invalid pre-existing config renders readably, not as a raw ZodError blob", async () => {
    const options = testOptions();
    // Well-formed YAML that fails schema validation: the embedded detail must be
    // the describeDecodeError one-liner (`<path>: <message>` with an `(and N
    // more)` suffix), not Zod's multi-line JSON dump of every issue.
    fs.writeFileSync(options.configFile, "connection: 123\n");
    try {
      const encoded = await encodeInvitation(sampleToken(FUTURE()));
      let message = "";
      try {
        await validateAccept({
          resolved: { mode: "offline", invitation: encoded },
          options,
          log: silentLog,
        });
      } catch (err) {
        message = (err as Error).message;
      }
      // The surrounding UsageError wrapper text is preserved.
      expect(message).toContain("could not be parsed to compare against");
      // The readable `<path>: <message>` form appears, with the multi-issue suffix.
      expect(message).toMatch(/connection: /);
      expect(message).toContain("(and 1 more)");
      // The raw multi-line ZodError JSON blob does not: no newlines, no JSON keys.
      expect(message).not.toContain("\n");
      expect(message).not.toContain('"code"');
    } finally {
      fs.rmSync(options.configFile, { force: true });
    }
  });

  test("validateAccept: a malformed-YAML config does not echo an inline credential", async () => {
    const options = testOptions();
    const SECRET = "S3cr3tSFTPPassw0rd";
    // Syntactically invalid YAML (an unclosed flow map) with an inline credential
    // on the offending line. YAML.parse's error embeds a snippet of the source
    // lines; the reconcile must report only the path, never that snippet, or the
    // credential leaks into the (logged) error message.
    fs.writeFileSync(
      options.configFile,
      `connection:\n  channel: sftp\n  server:\n    password: {${SECRET}\n    host: h\n`,
    );
    try {
      const encoded = await encodeInvitation(sampleToken(FUTURE()));
      let caught: unknown;
      try {
        await validateAccept({
          resolved: { mode: "offline", invitation: encoded },
          options,
          log: silentLog,
        });
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(UsageError);
      expect((caught as Error).message).toMatch(/not valid YAML/);
      // The credential must not appear anywhere in the shown message.
      expect((caught as Error).message).not.toContain(SECRET);
    } finally {
      fs.rmSync(options.configFile, { force: true });
    }
  });

  test("validateAccept: online aborts (no acceptance sent) when the connection block disagrees with the URL", async () => {
    const options = testOptions();
    // Linkage terms agree; only the connection host disagrees with the URL.
    writeExistingConfig(options.configFile, {
      connection: {
        channel: "sftp",
        server: { host: "other-host", username: "alice" },
      },
    });
    // The flag names this party differently from the kept file, so each run below
    // writes the no-effect notice where the prompt asks; keep it out of the
    // suite's own output.
    const stdio = captureStdio();
    try {
      const encoded = await encodeInvitation(sampleToken(FUTURE()));
      const run = () =>
        validateAccept({
          resolved: {
            mode: "online",
            url: new URL("sftp://expected-host/drop"),
            invitation: encoded,
            // Never read: the reconcile check throws before the input is loaded,
            // which is also before any network activity (so no acceptance is sent).
            input: "/nonexistent/psilink-input.csv",
          },
          options,
          log: silentLog,
        });
      await expect(run()).rejects.toBeInstanceOf(UsageError);
      await expect(run()).rejects.toThrow(/connection\.server\.host/);
    } finally {
      stdio.restore();
      fs.rmSync(options.configFile, { force: true });
    }
  });

  test("validateAccept: online reuse warns (does not abort) on a differing --server-port override", async () => {
    const dir = fs.mkdtempSync(path.join(tmpdir(), "psilink-accept-online-"));
    const input = path.join(dir, "input.csv");
    fs.writeFileSync(
      input,
      "first_name,last_name,dob,ssn\nAlice,Smith,1990-01-02,123456789\n",
    );
    const configFile = path.join(dir, "psilink.yaml");
    const keyFile = path.join(dir, ".psilink.key");
    // Terms and host (the abort fields) agree, so reconcile proceeds; only the
    // overridden port differs from the saved 22 -- a "how you reach it" detail
    // that must warn and apply, not abort.
    saveConfig(configFile, {
      connection: { channel: "sftp", server: { host: "host", port: 22 } },
      linkageTerms: sampleTerms("Acceptor Org"),
    });
    const log = getLogger("accept-port-warn-test");
    log.setLevel("silent");
    const warnSpy = vi.spyOn(log, "warn");
    const infoSpy = vi.spyOn(log, "info");
    // The kept file's label differs from this run's flag, so the no-effect notice
    // reaches the prompt's own sink; capture it here rather than in the suite's
    // output.
    const stdio = captureStdio();
    try {
      const encoded = await encodeInvitation(sampleToken(FUTURE()));
      const ready = await validateAccept({
        resolved: {
          mode: "online",
          url: new URL("sftp://host"),
          invitation: encoded,
          input,
        },
        options: testOptions({ configFile, keyFile, serverPort: 2222 }),
        log,
      });
      expect(ready.reuseExistingConfig).toBe(true);
      expect(
        warnSpy.mock.calls.some(
          (c) => typeof c[0] === "string" && c[0].includes("2222"),
        ),
      ).toBe(true);
      // With connection warnings emitted, the summary must not claim the config
      // "matches" -- that would contradict the just-emitted divergence.
      expect(
        infoSpy.mock.calls.some(
          (c) => typeof c[0] === "string" && c[0].includes("matches"),
        ),
      ).toBe(false);
    } finally {
      stdio.restore();
      warnSpy.mockRestore();
      infoSpy.mockRestore();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

// --- online accept: invitation-endpoint split directories --------------------

// A CSV the default linkage terms can fully satisfy, so the online path reaches
// prepareForOnlineExchange without a satisfiability abort. Returns a temp dir
// holding the input, config, and key paths (the caller removes the dir).
function onlineSplitFixture(): {
  dir: string;
  input: string;
  configFile: string;
  keyFile: string;
} {
  const dir = fs.mkdtempSync(path.join(tmpdir(), "psilink-accept-split-"));
  const input = path.join(dir, "input.csv");
  fs.writeFileSync(
    input,
    "first_name,last_name,dob,ssn\nAlice,Smith,1990-01-02,123456789\n",
  );
  return {
    dir,
    input,
    configFile: path.join(dir, "psilink.yaml"),
    keyFile: path.join(dir, ".psilink.key"),
  };
}

describe("online accept: invitation-endpoint split directories", () => {
  test("validateAccept: online auto-applies a split endpoint's mirror-swapped directories", async () => {
    const { dir, input, configFile, keyFile } = onlineSplitFixture();
    const endpoint: ConnectionEndpoint = {
      channel: "sftp",
      host: "inviter-host",
      inboundPath: "/exchange/inviter-in",
      outboundPath: "/exchange/inviter-out",
    };
    try {
      const encoded = await encodeInvitation(
        splitEndpointToken(FUTURE(), endpoint),
      );
      const ready = await validateAccept({
        resolved: {
          mode: "online",
          // Credentials + reachable host come from the acceptor's own URL.
          url: new URL("sftp://acceptor:pw@reach-host/ignored-url-path"),
          invitation: encoded,
          input,
        },
        options: testOptions({ configFile, keyFile }),
        log: silentLog,
      });
      expect(ready.mode).toBe("online");
      if (ready.mode !== "online") return;
      const { connection } = ready;
      if (connection.channel !== "sftp") throw new Error("expected sftp");
      expect(connection.server.host).toBe("reach-host");
      expect(connection.server.username).toBe("acceptor");
      // Mirror-swapped from the endpoint (inviter outbound -> acceptor inbound);
      // the URL's single path is dropped in favor of the split pair.
      expect(connection.server.inboundPath).toBe("/exchange/inviter-out");
      expect(connection.server.outboundPath).toBe("/exchange/inviter-in");
      expect(connection.server.path).toBeUndefined();
      expect(connection.options?.retainFiles).toBe(true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("validateAccept: online --outbound-path overrides the endpoint's split pair", async () => {
    const { dir, input, configFile, keyFile } = onlineSplitFixture();
    const endpoint: ConnectionEndpoint = {
      channel: "sftp",
      host: "inviter-host",
      inboundPath: "/exchange/inviter-in",
      outboundPath: "/exchange/inviter-out",
    };
    try {
      const encoded = await encodeInvitation(
        splitEndpointToken(FUTURE(), endpoint),
      );
      const ready = await validateAccept({
        resolved: {
          mode: "online",
          url: new URL("sftp://reach-host/my-inbound"),
          invitation: encoded,
          input,
        },
        // Explicit --outbound-path (with the retain mode a split requires) wins:
        // the URL path is the inbound and the flag is the outbound, never the
        // endpoint's swapped pair.
        options: testOptions({
          configFile,
          keyFile,
          outboundPath: "/my-outbound",
          retainFiles: true,
        }),
        log: silentLog,
      });
      expect(ready.mode).toBe("online");
      if (ready.mode !== "online") return;
      const { connection } = ready;
      if (connection.channel !== "sftp") throw new Error("expected sftp");
      expect(connection.server.inboundPath).toBe("/my-inbound");
      expect(connection.server.outboundPath).toBe("/my-outbound");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("validateAccept: online is unchanged by a non-split invitation endpoint", async () => {
    const { dir, input, configFile, keyFile } = onlineSplitFixture();
    const endpoint: ConnectionEndpoint = {
      channel: "sftp",
      host: "inviter-host",
      path: "/inviter/drop",
    };
    try {
      const encoded = await encodeInvitation(sampleToken(FUTURE(), endpoint));
      const ready = await validateAccept({
        resolved: {
          mode: "online",
          url: new URL("sftp://reach-host/url-drop"),
          invitation: encoded,
          input,
        },
        options: testOptions({ configFile, keyFile }),
        log: silentLog,
      });
      expect(ready.mode).toBe("online");
      if (ready.mode !== "online") return;
      const { connection } = ready;
      if (connection.channel !== "sftp") throw new Error("expected sftp");
      // The connection is exactly what the URL builds: a single shared path, no
      // split pair, no seeded retain mode.
      expect(connection.server.path).toBe("/url-drop");
      expect(connection.server.inboundPath).toBeUndefined();
      expect(connection.server.outboundPath).toBeUndefined();
      expect(connection.options?.retainFiles).toBeUndefined();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

// --- partner-string sanitization on the accept path --------------------------
// The invitation is crafted by the mutually-distrusting inviter; the fields it
// renders to the operator before acceptance must be escaped. These mirror the
// sanitizeForDisplay categories: control/ANSI and deceptive Unicode neutralized,
// ordinary values unchanged.

// Encodes a token WITHOUT schema validation (encodeInvitation would reject a
// malicious token), reproducing decodeInvitation's checksum + base64url framing
// so the decode path runs on attacker-shaped input.
async function encodeRaw(obj: unknown): Promise<string> {
  const toBase64Url = (b: Uint8Array): string =>
    btoa(Array.from(b, (byte) => String.fromCharCode(byte)).join(""))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=/g, "");
  const bytes = new TextEncoder().encode(JSON.stringify(obj));
  const hashBuf = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return toBase64Url(bytes) + toBase64Url(new Uint8Array(hashBuf).slice(0, 4));
}

// Renders displayInvitation into the joined info-log output, through the same
// log-writing sink the unattended path renders to and spying on the given logger
// so each test can assert against its own logger instance. The acceptor's own
// outbound-send set defaults to undefined (the not-yet-known case), so a test
// exercising an unrelated line need not supply one.
function renderDisplayInvitation(
  log: ReturnType<typeof getLogger>,
  token: InvitationToken,
  ownOutboundSend?: ReadonlyArray<string>,
  promptFollows = true,
): string {
  const infoSpy = vi.spyOn(log, "info");
  try {
    displayInvitation({
      token,
      ownOutboundSend,
      emit: (line) => {
        log.info(line);
      },
      promptFollows,
    });
    return infoSpy.mock.calls.map((c) => String(c[0])).join("\n");
  } finally {
    infoSpy.mockRestore();
  }
}

/**
 * The bullet entries listed directly under `heading`, sliced out of the rendered
 * lines so an assertion about one list cannot be satisfied -- or broken -- by a
 * bullet belonging to another block at the same depth. An entry is a bullet line
 * one indent level deeper than the heading; an entry's own nested detail (a
 * linkage key's `matches on:` and `elements:` sub-list) sits deeper still and is
 * skipped rather than ending the run, so every sibling entry is collected and a
 * single displayed entry is distinguishable from two. The block ends at the first
 * line back at the heading's own level or shallower, or at an entry-level line
 * that is not a bullet.
 */
function entriesUnder(
  lines: ReadonlyArray<string>,
  heading: string,
): Array<string> {
  const index = lines.indexOf(heading);
  if (index < 0) return [];
  const indentOf = (line: string): number =>
    line.length - line.trimStart().length;
  const headingIndent = indentOf(heading);
  const entryIndent = headingIndent + 2;
  const bullet = `${" ".repeat(entryIndent)}- `;
  const entries: Array<string> = [];
  for (const line of lines.slice(index + 1)) {
    if (line.startsWith(bullet)) {
      entries.push(line.slice(bullet.length));
      continue;
    }
    if (indentOf(line) <= entryIndent) break;
  }
  return entries;
}

// The display's marked labels, spelled out rather than derived from CONSENT_FACTS,
// so a marker that silently changed vocabulary reddens the assertions using them
// instead of following the table.
const OUTBOUND_SEND_LABEL = "columns you will send (enforced)";
const INVITING_PARTY_LABEL = "inviting party (your partner's word)";

/** The acceptor's own outbound-send columns, as displayed. */
function outboundSendEntries(lines: ReadonlyArray<string>): Array<string> {
  return entriesUnder(lines, `  ${OUTBOUND_SEND_LABEL}:`);
}

// The headings the two declared payload directions render under when the inviter
// authored them, spelled out rather than derived, for the reason the labels above
// are: a marker that silently changed vocabulary must redden the assertion. Only
// the direction's declared total is a parameter, so looking a heading up by exact
// text asserts the rendered total as well as the wording.
const declaredSendHeading = (declaredTotal: number): string =>
  `  columns you will receive (your partner's word, ${declaredTotal} declared):`;
const declaredReceiveHeading = (declaredTotal: number): string =>
  "  columns the inviting party requests from you " +
  `(your partner's word, ${declaredTotal} declared):`;

/**
 * A declaration at core's own ceiling, every name long enough to spend the whole
 * escaped display allowance: the shape that decides whether the operator can still
 * reach the question this prompt is asking.
 *
 * The count overdrives what the intake path can deliver, to pin the
 * cap's arithmetic at the schema ceiling rather than at whatever an encoded token
 * happens to fit: `decodeInvitation` refuses an encoded invitation above
 * `MAX_ENCODED_INVITATION_LENGTH` (64 KiB) before it parses, which holds a declared
 * list to roughly 346 names of this shape.
 *
 * The filler is ordinary content rather than an attack, and outside printable
 * ASCII: U+00E9 LATIN SMALL LETTER E WITH ACUTE is what a real declaration holds
 * and it escapes at this sink, so a name of them spends the allowance in full.
 * Written as an escape rather than a raw byte, so a test about an invisible
 * expansion is itself readable.
 */
function floodedDeclaration(prefix: string): Array<{ name: string }> {
  const filler = "\u00E9".repeat(MAX_NAME_LENGTH);
  return Array.from({ length: MAX_PAYLOAD_ENTRIES }, (_, index) => ({
    name: `${prefix}${index}-${filler}`,
  }));
}

describe("displayInvitation: the declared terms it discloses (columns, citations, dedup, retention)", () => {
  test("decode error escapes a hostile unrecognized endpoint key name end to end", async () => {
    // A malicious inviter adds an endpoint key whose NAME has control/ANSI
    // bytes; strictObject rejects it, echoing the name into the message that
    // decodeAndValidateInvitation shows to the operator as a UsageError.
    const encoded = await encodeRaw({
      ...sampleToken(FUTURE()),
      connectionEndpoint: {
        channel: "sftp",
        host: "h",
        "\x1b[2J\x1b[31mFAKE": 1,
      },
    });
    const err = await decodeAndValidateInvitation(encoded).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(UsageError);
    const msg = (err as Error).message;
    expect(msg).not.toContain("\x1b");
    expect(msg).toContain("\\x1b");
  });

  test("displayInvitation escapes a hostile inviter identity and key names", () => {
    const token: InvitationToken = {
      ...sampleToken(FUTURE()),
      linkageTerms: {
        ...sampleTerms("Inviter Org"),
        identity: "\x1b[31mEVIL\u202e",
        linkageKeys: [{ name: "k\x1b[0m", elements: [{ field: "ssn" }] }],
        // A hostile requested-from-you column name reaches the new "requests from
        // you" line; it must be escaped there too.
        payload: { receive: [{ name: "req\x1b[0m\u202e" }] },
      },
    };
    const log = getLogger("accept-display-test");
    log.setLevel("silent");
    // A hostile acceptor-file column name reaches the new "columns you will send"
    // line; it must be escaped there too. The acceptor's own outbound-send names
    // are operator-file strings rather than partner-controlled, but they still pass
    // through the same escaping, so the assertion covers that line as well.
    const joined = renderDisplayInvitation(log, token, ["send\x1b[0m\u202e"]);
    expect(joined).not.toContain("\x1b");
    expect(joined).not.toContain("\u202e");
    expect(joined).toContain("\\x1b");
    expect(joined).toContain("\\u202e");
  });

  test("displayInvitation: the held disclosed subset shows names, '(none)' when empty, and nothing when absent", () => {
    // The acceptor's "columns you will receive" line. A present subset is shown
    // (an empty one as "(none)", since the empty set is a real "receive nothing"
    // commitment); an absent subset (an older or metadata-unknown mint, reconciled
    // lazily) shows no line at all.
    const log = getLogger("accept-display-receive-test");
    log.setLevel("silent");
    const lines = (token: InvitationToken): string =>
      renderDisplayInvitation(log, token);
    const base = sampleToken(FUTURE());
    const named = lines({
      ...base,
      disclosedPayloadColumns: ["diagnosis", "notes"],
    });
    expect(named).toContain("columns you will receive (enforced, 2 declared):");
    expect(named).toContain("\n    - diagnosis");
    expect(named).toContain("\n    - notes");
    // The empty set is a bare "(none)", with nothing after it: the line renders only
    // for a declared direction (the absent case below prints no line at all), so the
    // reader of a "(none)" is already looking at an explicit declaration, and the
    // enforcement register is what the label's marker holds. What the declaration
    // commits its party to is stated at length in docs/CLI.md, not on the prompt.
    expect(
      lines({ ...base, disclosedPayloadColumns: [] }).split("\n"),
    ).toContain("  columns you will receive (enforced, 0 declared): (none)");
    expect(
      lines({ ...base, disclosedPayloadColumns: undefined }),
    ).not.toContain("columns you will receive");
  });

  test("displayInvitation: the rule-set citation displays as the partner's word, and is absent when none is cited", () => {
    // The citation is the inviting party's own claim about its rules, so the block
    // holds the trust-contingent marker rather than displaying as a provenance
    // psilink vouched for. An invitation citing nothing prints no line:
    // hand-authored rules have no citation, and inventing one would attribute them.
    const log = getLogger("accept-display-rule-set-test");
    log.setLevel("silent");
    const base = sampleToken(FUTURE());
    const cited = renderDisplayInvitation(log, {
      ...base,
      linkageTerms: {
        ...base.linkageTerms,
        linkageRuleSet: {
          fieldSet: { name: "baseline-pii", version: "1.0.0" },
          keySet: { name: "hmis-keys", version: "2.3.0" },
        },
      },
    });
    expect(cited).toContain("linkage rule set (your partner's word):");
    expect(cited).toContain('"hmis-keys" 2.3.0');
    expect(cited).toContain('"baseline-pii" 1.0.0');

    // The name is partner-controlled free text and the version beside it is not, so
    // the quoting is what keeps the boundary between them readable: a name ending in
    // a version-shaped token must not be treated as the version this line reports.
    const spacedName = renderDisplayInvitation(log, {
      ...base,
      linkageTerms: {
        ...base.linkageTerms,
        linkageRuleSet: {
          fieldSet: { name: "baseline-pii", version: "1.0.0" },
          keySet: { name: "hmis-keys 9.9.9", version: "2.3.0" },
        },
      },
    });
    expect(spacedName).toContain('"hmis-keys 9.9.9" 2.3.0');

    const uncited = renderDisplayInvitation(log, {
      ...base,
      linkageTerms: { ...base.linkageTerms, linkageRuleSet: undefined },
    });
    expect(uncited).not.toContain("linkage rule set");
    for (const verdict of ["consistent", "contradicted", "unchecked"] as const)
      expect(uncited).not.toContain(
        LINKAGE_RULE_SET_VERDICT_COPY[verdict].note,
      );
  });

  test("displayInvitation: a cited set name cannot render another citation's line", () => {
    // The name is delimited through core's terms-value boundary, which doubles a
    // delimiter inside a run, so a name holding one cannot end its own value: what
    // the operator reads is the whole name, never the line a citation of a shorter
    // name at another version produces.
    const log = getLogger("accept-display-rule-set-delimiter-test");
    log.setLevel("silent");
    const base = sampleToken(FUTURE());
    const cite = (linkageRuleSet: LinkageRuleSetReference): string =>
      renderDisplayInvitation(log, {
        ...base,
        linkageTerms: { ...base.linkageTerms, linkageRuleSet },
      });
    // Neither citation names a set this build ships -- the first by version, the
    // second by name -- so both render under one marker and the pair of lines
    // differs in nothing but how the name is rendered.
    const marker = LINKAGE_RULE_SET_VERDICT_COPY.unchecked.marker;
    const imitated = {
      keys: `    keys (${marker}): "hmis-keys" 9.9.9`,
      fields: `    fields (${marker}): "baseline-pii" 9.9.9`,
    };
    const imitatedLines = cite({
      fieldSet: { name: "baseline-pii", version: "9.9.9" },
      keySet: { name: "hmis-keys", version: "9.9.9" },
    }).split("\n");
    expect(imitatedLines).toContain(imitated.keys);
    expect(imitatedLines).toContain(imitated.fields);

    const rendered = cite({
      fieldSet: { name: 'baseline-pii" 9.9.9', version: "1.0.0" },
      keySet: { name: 'hmis-keys" 9.9.9', version: "1.0.0" },
    });
    expect(rendered.split("\n")).toContain(
      `    keys (${marker}): "hmis-keys"" 9.9.9" 1.0.0`,
    );
    expect(rendered.split("\n")).toContain(
      `    fields (${marker}): "baseline-pii"" 9.9.9" 1.0.0`,
    );
    expect(rendered).not.toContain(imitated.keys);
    expect(rendered).not.toContain(imitated.fields);

    // The version renders undelimited on the strength of the shape the terms schema
    // holds it to, and that shape is re-checked on the value in hand: one outside it
    // renders delimited instead, rather than standing in the line unattributed.
    expect(
      cite({
        fieldSet: { name: "baseline-pii", version: "1.0.0" },
        keySet: { name: "hmis-keys", version: '1.0.0" 9.9.9' },
      }).split("\n"),
    ).toContain(`    keys (${marker}): "hmis-keys" "1.0.0"" 9.9.9"`);
  });

  test("displayInvitation: each citation half holds this build's own verdict on it", () => {
    const log = getLogger("accept-display-rule-set-verdict-test");
    log.setLevel("silent");
    const base = sampleToken(FUTURE());

    // The default terms ARE the built-in sets, narrowed by nothing, and they cite
    // them: both halves resolve and match.
    const truthful = renderDisplayInvitation(log, base);
    expect(truthful).toContain(
      `keys (${LINKAGE_RULE_SET_VERDICT_COPY.consistent.marker}): "hmis-keys"`,
    );
    expect(truthful).toContain(
      `fields (${LINKAGE_RULE_SET_VERDICT_COPY.consistent.marker}): "baseline-pii"`,
    );
    // One caveat for two agreeing halves, rather than the same sentence twice.
    expect(
      truthful.split(LINKAGE_RULE_SET_VERDICT_COPY.consistent.note).length - 1,
    ).toBe(1);
    expect(truthful).not.toContain(
      LINKAGE_RULE_SET_VERDICT_COPY.contradicted.note,
    );

    // The same citation over a REORDERED cascade: key order is cascade order, so
    // the reordered keys are provably not the set the citation names, while the
    // untouched fields still are. The halves are decided independently.
    const reordered = renderDisplayInvitation(log, {
      ...base,
      linkageTerms: {
        ...base.linkageTerms,
        linkageKeys: [...base.linkageTerms.linkageKeys].reverse(),
      },
    });
    expect(reordered).toContain(
      `keys (${LINKAGE_RULE_SET_VERDICT_COPY.contradicted.marker}): "hmis-keys"`,
    );
    expect(reordered).toContain(
      `fields (${LINKAGE_RULE_SET_VERDICT_COPY.consistent.marker}): "baseline-pii"`,
    );
    expect(reordered).toContain(
      LINKAGE_RULE_SET_VERDICT_COPY.contradicted.note,
    );
    expect(reordered).toContain(LINKAGE_RULE_SET_VERDICT_COPY.consistent.note);
    // Most severe first, so a reader who stops after one line has read the warning.
    expect(
      reordered.indexOf(LINKAGE_RULE_SET_VERDICT_COPY.contradicted.note),
    ).toBeLessThan(
      reordered.indexOf(LINKAGE_RULE_SET_VERDICT_COPY.consistent.note),
    );

    // A name this build does not ship resolves to nothing, so nothing is compared:
    // unchecked, never contradicted, whatever the declared rules are.
    const foreign = renderDisplayInvitation(log, {
      ...base,
      linkageTerms: {
        ...base.linkageTerms,
        linkageKeys: [...base.linkageTerms.linkageKeys].reverse(),
        linkageRuleSet: {
          fieldSet: { name: "county-pii", version: "3.1.0" },
          keySet: { name: "county-keys", version: "3.1.0" },
        },
      },
    });
    expect(foreign).toContain(
      `keys (${LINKAGE_RULE_SET_VERDICT_COPY.unchecked.marker}): "county-keys"`,
    );
    expect(foreign).toContain(
      `fields (${LINKAGE_RULE_SET_VERDICT_COPY.unchecked.marker}): "county-pii"`,
    );
    expect(foreign).toContain(LINKAGE_RULE_SET_VERDICT_COPY.unchecked.note);
    expect(foreign).not.toContain(
      LINKAGE_RULE_SET_VERDICT_COPY.contradicted.note,
    );
  });

  test("displayInvitation: a disproved citation is repeated in the block above the prompt", () => {
    // The terms run well past a screen, so the decision block is where an operator
    // answering the prompt is looking. A citation this build resolved and disproved
    // is repeated there; the other two verdicts stay with the citation itself.
    const log = getLogger("accept-display-rule-set-decision-test");
    log.setLevel("silent");
    const base = sampleToken(FUTURE());
    const contradicted = {
      ...base,
      linkageTerms: {
        ...base.linkageTerms,
        linkageKeys: [...base.linkageTerms.linkageKeys].reverse(),
      },
    };
    const rendered = renderDisplayInvitation(log, contradicted);
    // Three times on a prompting render: once beside the citation, and once in each
    // of the decision block's two printings (heading the terms, and again at the
    // prompt the terms have scrolled away from).
    expect(
      rendered.split(LINKAGE_RULE_SET_VERDICT_COPY.contradicted.note).length -
        1,
    ).toBe(3);
    // The repeated block holds the citation whole -- both halves under their own
    // markers, each name behind a fixed first-party label -- so an operator reads
    // WHICH name is disproved. Only the disproved caveat is repeated with it.
    const decisionLines: string[] = [];
    logDecisionFacts(
      (line) => decisionLines.push(line),
      summarizeInvitation(contradicted),
      undefined,
    );
    const decision = decisionLines.join("\n");
    expect(decision).toContain(
      `keys (${LINKAGE_RULE_SET_VERDICT_COPY.contradicted.marker}): "hmis-keys"`,
    );
    expect(decision).toContain(
      `fields (${LINKAGE_RULE_SET_VERDICT_COPY.consistent.marker}): "baseline-pii"`,
    );
    expect(decision).toContain(LINKAGE_RULE_SET_VERDICT_COPY.contradicted.note);
    expect(decision).not.toContain(
      LINKAGE_RULE_SET_VERDICT_COPY.consistent.note,
    );

    const truthfulLines: string[] = [];
    logDecisionFacts(
      (line) => truthfulLines.push(line),
      summarizeInvitation(base),
      undefined,
    );
    expect(truthfulLines.join("\n")).not.toContain("linkage rule set");
  });

  test("displayInvitation: the received-columns marker follows what the invitation held, not what it declared", () => {
    // The same line has two sources and they do not rest on the same thing. The
    // held subset is the set an acceptance locks in and reconciles the received
    // payload against; an authored payload.send with no held subset locks in
    // nothing, so an inviter that declares one set and transmits another is not
    // stopped on the online run. Marking that case "enforced" would announce a check
    // that does not run, so the marker is keyed on what was held.
    const log = getLogger("accept-display-receive-basis-test");
    log.setLevel("silent");
    const base = sampleToken(FUTURE());
    // One terms document for both renderings, authoring the columns the held
    // subset also names, so the only difference between the two is whether the token
    // holds the subset.
    const linkageTerms: LinkageTerms = {
      ...base.linkageTerms,
      payload: { send: [{ name: "diagnosis" }, { name: "notes" }] },
    };
    const authored = renderDisplayInvitation(log, { ...base, linkageTerms });
    const carried = renderDisplayInvitation(log, {
      ...base,
      linkageTerms,
      disclosedPayloadColumns: ["diagnosis", "notes"],
    });
    expect(authored).toContain(
      "columns you will receive (your partner's word, 2 declared):",
    );
    expect(authored).toContain("\n    - diagnosis");
    expect(authored).toContain("\n    - notes");
    expect(authored).not.toContain("columns you will receive (enforced,");
    expect(carried).toContain(
      "columns you will receive (enforced, 2 declared):",
    );
    expect(carried).not.toContain(
      "columns you will receive (your partner's word,",
    );
    // The marker is the whole of the difference: the same columns are listed either
    // way, so nothing else about the surface moves with the basis.
    expect(
      authored.replace(
        "columns you will receive (your partner's word, 2 declared)",
        "columns you will receive (enforced, 2 declared)",
      ),
    ).toBe(carried);
    // An authored EMPTY send is not a declaration at all -- it holds no subset and
    // prints no line -- so a rendered "(none)" is always the held, enforced case.
    expect(
      renderDisplayInvitation(log, {
        ...base,
        linkageTerms: { ...base.linkageTerms, payload: { send: [] } },
      }),
    ).not.toContain("columns you will receive");
  });

  test("displayInvitation: the inviter's request-from-acceptor receive shows names, '(none)' when empty, and nothing when absent", () => {
    // The opposite direction from "columns you will receive": the inviter's
    // payload.receive is what it requests FROM this party. A declared receive
    // (present, even if empty) is shown -- an empty one as "(none)", since it
    // strictly asserts this party sends nothing -- while an absent receive (lazy)
    // shows no line at all. CLI counterpart of the web "requests from you" line.
    const log = getLogger("accept-display-request-test");
    log.setLevel("silent");
    const lines = (token: InvitationToken): string =>
      renderDisplayInvitation(log, token);
    const base = sampleToken(FUTURE());
    const withReceive = (
      receive: { name: string }[] | undefined,
    ): InvitationToken => ({
      ...base,
      linkageTerms: { ...base.linkageTerms, payload: { receive } },
    });
    const named = lines(withReceive([{ name: "dose" }, { name: "outcome" }]));
    expect(named).toContain(
      "columns the inviting party requests from you " +
        "(your partner's word, 2 declared):",
    );
    expect(named).toContain("\n    - dose");
    expect(named).toContain("\n    - outcome");
    // The mirror of the line above, and bare for the same reason: only a declared
    // direction prints, so "(none)" is the inviter asking for no column rather than
    // the lazy case, which prints nothing.
    expect(lines(withReceive([])).split("\n")).toContain(
      "  columns the inviting party requests from you " +
        "(your partner's word, 0 declared): (none)",
    );
    expect(lines(withReceive(undefined))).not.toContain(
      "the inviting party requests from you",
    );
  });

  test("displayInvitation: bounds each declared payload list by count and states the remainder", () => {
    // Both declared directions hold partner free text at core's MAX_PAYLOAD_ENTRIES
    // ceiling, above what intake can deliver so the arithmetic is pinned at the schema
    // bound; what an invitation actually reaches through the 64 KiB decode cap is
    // roughly 346 names of this shape, some 93 KB of painted text and a thousand-odd
    // terminal rows between the operator and the consent decision below -- usability
    // denial rather than injection, the names being escaped.
    const log = getLogger("accept-display-declared-bound-test");
    log.setLevel("silent");

    // What THIS fixture may paint: a sample token's blocks with both declared payload
    // directions flooded, which is what the count bound governs. It is not a bound on
    // everything the prompt can render -- the linkage-key block, up to
    // MAX_LINKAGE_ENTRIES (256) keys of MAX_KEY_ELEMENTS (256) elements each through
    // the uncapped logList path, stays the larger partner-controlled render on this
    // surface and this fixture does not exercise it. An ABSOLUTE number, not derived
    // from MAX_DECLARED_NAMES_SHOWN: a ceiling that scaled with the cap
    // would hold at any cap, including none, which is the change this check exists to
    // catch. It leaves several thousand characters of headroom over what this fixture
    // measures today, so a copy edit elsewhere on the prompt does not trip it, and
    // stays far under what the same declaration paints uncapped -- the difference
    // between scrolling past the terms and never reaching the question.
    const PROMPT_CEILING = 20_000;

    const base = sampleToken(FUTURE());
    const send = floodedDeclaration("send");
    const receive = floodedDeclaration("receive");
    const rendered = renderDisplayInvitation(log, {
      ...base,
      linkageTerms: { ...base.linkageTerms, payload: { send, receive } },
    });
    const lines = rendered.split("\n");
    const countLine = `    ${unshownDeclaredNamesLine(
      MAX_PAYLOAD_ENTRIES - MAX_DECLARED_NAMES_SHOWN,
    )}`;

    for (const heading of [
      declaredSendHeading(MAX_PAYLOAD_ENTRIES),
      declaredReceiveHeading(MAX_PAYLOAD_ENTRIES),
    ]) {
      // Per direction, not in total: each list holds its own cap, so one flooded
      // declaration cannot spend the other's allowance.
      const entries = entriesUnder(lines, heading);
      expect(entries).toHaveLength(MAX_DECLARED_NAMES_SHOWN);
      // The assumption, asserted rather than assumed: each painted name spends the whole
      // per-value allowance and is cut at it, so what is measured here is the worst
      // case and not a mild one.
      for (const entry of entries) {
        expect(entry.endsWith(DISPLAY_TRUNCATION_MARKER)).toBe(true);
        expect(entry.length).toBeGreaterThan(DEFAULT_MAX_DISPLAY_LENGTH);
      }
      // Directly under the last painted name of this direction, stating this
      // direction's whole remainder, so a cut list cannot drop its tail silently.
      expect(lines[lines.indexOf(heading) + MAX_DECLARED_NAMES_SHOWN + 1]).toBe(
        countLine,
      );
    }
    // Once per bounded direction across the whole surface: neither block repeats the
    // sentence nor borrows the other's remainder.
    expect(lines.filter((line) => line === countLine)).toHaveLength(2);

    // What the same declaration would paint uncapped, measured rather than argued
    // from the constants: the bound is only worth pinning against the size it
    // replaces. That magnitude belongs to the schema ceiling this fixture drives, not
    // to anything an invitation delivers -- one holding it never decodes -- and the
    // reachable worst case the bound forecloses is the ~93 KB, a thousand-odd rows,
    // that the 64 KiB decode cap does leave room for.
    const uncappedSize = [...send, ...receive].reduce(
      (total, column) => total + sanitizeForDisplay(column.name).length,
      0,
    );
    expect(uncappedSize).toBeGreaterThan(1_000_000);
    expect(rendered.length).toBeLessThanOrEqual(PROMPT_CEILING);

    // A realistic declaration is a handful of columns, and paints entire with no
    // count line at all. Exactly at the cap as well as under it: the boundary is
    // where an off-by-one would cut a list it should have painted whole, or count a
    // remainder of nothing.
    for (const width of [
      MAX_DECLARED_NAMES_SHOWN - 1,
      MAX_DECLARED_NAMES_SHOWN,
    ]) {
      const columns = Array.from({ length: width }, (_, index) => ({
        name: `col${index}`,
      }));
      const whole = renderDisplayInvitation(log, {
        ...base,
        linkageTerms: {
          ...base.linkageTerms,
          payload: { send: columns, receive: columns },
        },
      });
      for (const heading of [
        declaredSendHeading(width),
        declaredReceiveHeading(width),
      ])
        expect(entriesUnder(whole.split("\n"), heading)).toEqual(
          columns.map((column) => column.name),
        );
      expect(whole).not.toContain("not shown here");
    }
  });

  test("displayInvitation: each declared direction's heading states its own declared total", () => {
    // Under the count bound the closing "and N more" line is the only magnitude a cut
    // list holds below it, and a padded declared name reproduces that row at a
    // matching terminal width (the stated limit on logDeclaredPayloadList). The
    // heading states the same magnitude from above the first painted name, where no
    // partner text precedes it, so the total is read before any of the declaration's
    // own bytes and corroborates what the count line says.
    const log = getLogger("accept-display-declared-total-test");
    log.setLevel("silent");
    // A different length per direction, both past the cap: a heading reading the
    // painted subset, or the other direction's set, disagrees with what is declared
    // here rather than matching by coincidence.
    const columns = (prefix: string, count: number): Array<{ name: string }> =>
      Array.from({ length: count }, (_, index) => ({
        name: `${prefix}${index}`,
      }));
    const send = columns("send", MAX_DECLARED_NAMES_SHOWN + 3);
    const receive = columns("receive", MAX_DECLARED_NAMES_SHOWN + 7);
    const base = sampleToken(FUTURE());
    const lines = renderDisplayInvitation(log, {
      ...base,
      linkageTerms: { ...base.linkageTerms, payload: { send, receive } },
    }).split("\n");

    for (const [heading, declared] of [
      [declaredSendHeading(send.length), send],
      [declaredReceiveHeading(receive.length), receive],
    ] as const) {
      // Found by exact text, so the rendered heading states this direction's declared
      // length -- not the cap it painted, not the other direction's -- and holds
      // nothing the declaration supplied: an interpolated name would fail the match.
      const headingIndex = lines.indexOf(heading);
      expect(headingIndex).toBeGreaterThanOrEqual(0);
      expect(declared.length).toBeGreaterThan(MAX_DECLARED_NAMES_SHOWN);
      expect(lines[headingIndex + 1]).toBe(`    - ${declared[0].name}`);
      expect(entriesUnder(lines, heading)).toHaveLength(
        MAX_DECLARED_NAMES_SHOWN,
      );
      // Painted plus counted is what the heading states, so the two first-party
      // numbers can only disagree through a real defect.
      expect(lines[headingIndex + MAX_DECLARED_NAMES_SHOWN + 1]).toBe(
        `    ${unshownDeclaredNamesLine(
          declared.length - MAX_DECLARED_NAMES_SHOWN,
        )}`,
      );
    }
  });

  test("displayInvitation: a declared name displaying as the count line stays a list entry", () => {
    // sanitizeForDisplay passes printable ASCII verbatim, so a partner can declare a
    // column named exactly as the sentence closing its own bounded list. The bullet is
    // what tells them apart among the emitted lines, a line-oriented sink having no
    // container to place one inside and the other outside: a painted name always
    // has the bullet, and cannot break its own line to shed it, while the
    // first-party count line never does. What a terminal ROW shows is outside what
    // this asserts -- soft wrap can reproduce the bare count row from a padded name,
    // the stated limit on logDeclaredPayloadList.
    const log = getLogger("accept-display-count-line-impostor-test");
    log.setLevel("silent");
    const impostor = unshownDeclaredNamesLine(
      MAX_PAYLOAD_ENTRIES - MAX_DECLARED_NAMES_SHOWN,
    );
    const send = floodedDeclaration("send");
    send[0] = { name: impostor };
    const base = sampleToken(FUTURE());
    const lines = renderDisplayInvitation(log, {
      ...base,
      linkageTerms: { ...base.linkageTerms, payload: { send } },
    }).split("\n");

    expect(
      entriesUnder(lines, declaredSendHeading(MAX_PAYLOAD_ENTRIES))[0],
    ).toBe(impostor);
    expect(lines.filter((line) => line === `    - ${impostor}`)).toHaveLength(
      1,
    );
    expect(lines.filter((line) => line === `    ${impostor}`)).toHaveLength(1);
  });

  test("displayInvitation: shows the acceptor's own outbound send, one column per line", () => {
    // The columns THIS party will disclose to the partner for matched records -- its
    // own outbound disclosure. A non-empty set is shown one column per line (so a name
    // containing the list separator is not misread as two entries), leading the
    // details before the inviter's proposed terms.
    const log = getLogger("accept-display-outbound-test");
    log.setLevel("silent");
    const joined = renderDisplayInvitation(log, sampleToken(FUTURE()), [
      "diagnosis",
      "medication",
    ]);
    const lines = joined.split("\n");
    // The heading is present and the columns appear one per line, before the
    // inviter's "columns you will receive"/"linkage keys" terms.
    const headingIndex = lines.findIndex((l) =>
      l.includes(`${OUTBOUND_SEND_LABEL}:`),
    );
    expect(headingIndex).toBeGreaterThanOrEqual(0);
    expect(lines).toContain("    - diagnosis");
    expect(lines).toContain("    - medication");
    // No presupposing empty/unknown phrasing when the set is a real non-empty
    // disclosure.
    expect(joined).not.toContain("(none)");
    expect(joined).not.toContain("not yet known");
  });

  test("displayInvitation: a column name containing the list separator is not split into two entries", () => {
    // sanitizeForDisplay does not escape a printable ASCII comma, so a joined list
    // would misread a single column named "last, first" as two columns. Rendering one
    // per line keeps it a single entry.
    const log = getLogger("accept-display-outbound-comma-test");
    log.setLevel("silent");
    const lines = renderDisplayInvitation(log, sampleToken(FUTURE()), [
      "last, first",
      "notes",
    ]).split("\n");
    // The comma-bearing name is one entry on its own line, not split at the comma,
    // and the separator did not create a third entry.
    expect(outboundSendEntries(lines)).toEqual(["last, first", "notes"]);
  });

  test("displayInvitation: the empty and not-yet-known outbound-send cases avoid a presupposing phrase", () => {
    // Empty (the acceptor discloses nothing) and not-yet-known (no metadata resolved
    // at prompt time) must both stay truthful: neither asserts a definite non-empty
    // outbound send.
    const log = getLogger("accept-display-outbound-empty-test");
    log.setLevel("silent");
    const base = sampleToken(FUTURE());
    // Empty: a real "you disclose nothing", shown as a truthful (none) line, not a
    // list and not a forward-reference.
    const empty = renderDisplayInvitation(log, base, []);
    expect(empty).toContain(
      `${OUTBOUND_SEND_LABEL}: (none) -- only matched records`,
    );
    expect(outboundSendEntries(empty.split("\n"))).toEqual([]);
    // Not-yet-known: no metadata at prompt time, so the line says the set is not
    // known rather than claiming any count -- and names what actually determines it,
    // including the confirmation the run stops for and the refusal an unattended run
    // gets instead. The forward reference is only accurate while that checkpoint
    // exists, so it is pinned here beside the acceptance that records it as pending.
    const unknown = renderDisplayInvitation(log, base, undefined);
    expect(unknown).toContain(`${OUTBOUND_SEND_LABEL}: not yet known`);
    expect(unknown).toContain(
      "    Determined from your input file when the exchange runs, which shows " +
        "the columns and asks you to confirm them before anything is sent; a run " +
        "with no terminal to ask on refuses instead of sending them.",
    );
    expect(unknown).not.toContain("(none)");
    expect(outboundSendEntries(unknown.split("\n"))).toEqual([]);
  });

  test("displayInvitation: an inviting party that receives no result is sent nothing, whatever the acceptor's own set is", () => {
    // The payload step transmits nothing at all to a partner not entitled to the
    // result, so a listed column set would name a disclosure that does not happen --
    // under the marker that says the run holds it. The direction answers the line for
    // every value of the acceptor's own set: a resolved set is not listed, the
    // not-yet-known forward reference does not run (the input file it names cannot
    // change this answer), and the empty case's "only matched records" tail gives way
    // to the reason that holds however the operator's file changes.
    const log = getLogger("accept-display-outbound-one-sided-test");
    log.setLevel("silent");
    const base = sampleToken(FUTURE());
    const oneSided: InvitationToken = {
      ...base,
      linkageTerms: {
        ...base.linkageTerms,
        output: { expectsOutput: false, shareWithPartner: true },
      },
    };
    for (const own of [["diagnosis", "medication"], [], undefined]) {
      const rendered = renderDisplayInvitation(log, oneSided, own);
      expect(rendered.split("\n")).toContain(
        `  ${OUTBOUND_SEND_LABEL}: (none) -- the inviting party receives no ` +
          "result, so no payload is sent",
      );
      expect(outboundSendEntries(rendered.split("\n"))).toEqual([]);
      expect(rendered).not.toContain("diagnosis");
      expect(rendered).not.toContain("only matched records");
      expect(rendered).not.toContain("not yet known");
    }
    // The direction is the whole of the gate: the same acceptor set is listed in full
    // when the inviting party does receive the result.
    const twoSided = renderDisplayInvitation(log, base, [
      "diagnosis",
      "medication",
    ]);
    expect(outboundSendEntries(twoSided.split("\n"))).toEqual([
      "diagnosis",
      "medication",
    ]);
  });

  test("displayInvitation: shows the linkage strategy and, for single-pass, the disclosure note", () => {
    const log = getLogger("accept-display-strategy-test");
    log.setLevel("silent");
    const lines = (token: InvitationToken): string =>
      renderDisplayInvitation(log, token);
    const base = sampleToken(FUTURE());
    // The default (cascade) is shown plainly, with no disclosure note.
    const cascade = lines(base);
    expect(cascade).toContain("linkage strategy (enforced): cascade");
    expect(cascade).not.toContain("consented disclosure tradeoff");
    // single-pass is the disclosure-affecting choice the acceptor consents to, so
    // it holds the shared tradeoff note (with the operator-facing doc pointer).
    const singlePass = lines({
      ...base,
      linkageTerms: { ...base.linkageTerms, linkageStrategy: "single-pass" },
    });
    expect(singlePass).toContain("linkage strategy (enforced): single-pass");
    expect(singlePass).toContain("consented disclosure tradeoff");
    expect(singlePass).toContain("docs/EXCHANGE_REFERENCE.md");
  });

  test("displayInvitation: states what a splitting key does, in the register its strategy puts it in", () => {
    // A key element that splits its value is matched on each candidate, which is
    // both a widening and a disclosure -- and under a strategy that matches one
    // value per record it is a refusal instead. The sentence for each case comes
    // from core's shared classification, so this prompt and the web consent screen
    // state the consequence in the same words rather than two accounts of it.
    const log = getLogger("accept-display-fan-out-test");
    log.setLevel("silent");

    const matched = renderDisplayInvitation(
      log,
      splittingKeyToken(FUTURE(), "single-pass"),
    );
    expect(matched).toContain("several values per record (enforced):");
    expect(matched).toContain(CONSENT_FACTS.fanOutCandidates.note);
    expect(matched).toContain("(multiple)");

    const refused = renderDisplayInvitation(
      log,
      splittingKeyToken(FUTURE(), "cascade"),
    );
    expect(refused).toContain("several values per record (enforced):");
    expect(refused).toContain(CONSENT_FACTS.fanOutRefused.note);
    expect(refused).toContain("(not supported)");

    // Silent for terms that declare no split, so the line is not a fixture of the
    // prompt itself.
    expect(renderDisplayInvitation(log, sampleToken(FUTURE()))).not.toContain(
      "several values per record",
    );
  });

  test("displayInvitation: represents every consent-relevant linkage term, bar the recorded gaps", () => {
    // Which terms an acceptor's consent turns on is judged once, in core's shared
    // classification, so this prompt and the web consent summary cannot drift on
    // the answer. A term is represented here when two sets of terms differing at
    // that term alone print differently; one the prompt omits prints identically
    // and has to be recorded as a gap in that same classification.
    const log = getLogger("accept-display-coverage-test");
    log.setLevel("silent");
    // One token, reused across every rendering, so only the terms move -- minting
    // a fresh one per render would vary the displayed `expires` too. Its
    // `disclosedPayloadColumns` is left absent: it is a token field
    // the inviter derives from its own metadata, not a linkage term, and supplying
    // one would answer the question about it rather than about `payload.send`. The
    // acceptor's own outbound-send set is held at the not-yet-known case for the
    // same reason.
    const token = sampleToken(FUTURE());
    const render = (linkageTerms: LinkageTerms): string =>
      renderDisplayInvitation(log, { ...token, linkageTerms });

    const probes = consentRepresentationProbes();
    expect(probes.length).toBeGreaterThan(0);
    expect(
      probes
        .filter((probe) => render(probe.base) === render(probe.variant))
        .map((probe) => probe.path)
        .sort(),
    ).toEqual(
      probes
        .filter((probe) => probe.unrepresented.cli !== undefined)
        .map((probe) => probe.path)
        .sort(),
    );

    // A term whose variant turns on a disclosure holds the sentence stating it in
    // the classification, and both surfaces are held to that one string: moving the
    // output is not enough where an acceptor is entitled to read what the setting
    // costs. Asserted absent from the base too, so the pin measures the setting
    // rather than a sentence the prompt always prints.
    const pinned = probes.filter(
      (probe) =>
        probe.requiredVariantCopy !== undefined &&
        probe.unrepresented.cli === undefined,
    );
    expect(pinned.length).toBeGreaterThan(0);
    for (const probe of pinned) {
      // Per probe, not only over the set: an entry holding an empty list would
      // otherwise satisfy the loop below by rendering nothing at all.
      const copies = probe.requiredVariantCopy ?? [];
      expect(copies.length, probe.label).toBeGreaterThan(0);
      for (const copy of copies) {
        expect(render(probe.variant), probe.label).toContain(copy);
        expect(render(probe.base), probe.label).not.toContain(copy);
      }
      // And the other half of a term measured under several document shapes: the
      // sentence another shape owes must be absent here, or one sentence rendered
      // for every shape would satisfy the pin above while stating a disclosure this
      // shape's run does not make.
      for (const copy of probe.forbiddenVariantCopy ?? [])
        expect(render(probe.variant), probe.label).not.toContain(copy);
    }
    // Non-vacuous: at least one term is measured under shapes that owe different
    // sentences, so the loop above is a check rather than an empty pass.
    expect(
      pinned.filter((probe) => (probe.forbiddenVariantCopy ?? []).length > 0)
        .length,
    ).toBeGreaterThan(0);
  });

  test("displayInvitation: shows each matching rule the acceptor is consenting to", () => {
    // The representation check above proves each term MOVES the output; these pin
    // what it actually says, so a term cannot satisfy that check while displaying as
    // something else. The probe terms hold one of everything: a parameterized
    // transform, a fuzzy comparison, a swap, field constraints, a payload in both
    // directions, and a legal agreement.
    const log = getLogger("accept-display-rules-test");
    log.setLevel("silent");
    const out = renderDisplayInvitation(log, {
      ...sampleToken(FUTURE()),
      linkageTerms: CONSENT_PROBE_TERMS,
    });

    expect(out).toContain("    - given name, family name, and date of birth");
    // The elements the key combines, each under its declared semantic type -- the
    // partner-authored field name is not shown.
    expect(out).toContain("        - First name");
    expect(out).toContain("        - Last name");
    expect(out).toContain("        - Date of birth");
    // A transform with its plain-language consequence and every declared parameter.
    expect(out).toContain("          transform: to_upper_case");
    expect(out).toContain("          transform: substring");
    expect(out).toContain("            - start: 1");
    expect(out).toContain("            - length: 3");
    // The fuzzy-comparison expansion, marked as proposed: the run does not yet
    // apply it, so the prompt must not state a looser match than it performs.
    expect(out).toContain(
      "          also matches approximate variants (adjacent years) (proposed; not yet applied)",
    );
    // The swap, and the cross-application of the transform-carrier's rules onto the
    // other element's value that the generic swap note alone does not convey.
    expect(out).toContain(
      "      swap: First name and Last name may be matched in either order",
    );
    expect(out).toContain(
      "note: when matched in that order, the transforms shown for First name are " +
        "applied to Last name's value",
    );
    // The per-field data standards, under a heading marking them as the inviter's
    // own undertaking rather than rules the exchange applies, with the
    // partner-authored character class shown raw after a fixed first-party label
    // rather than paraphrased as a vetted allow-list.
    expect(out).toContain(
      "      declared data standards (your partner's word):",
    );
    expect(out).toContain("        - honorifics and suffixes removed");
    expect(out).toContain("        - 1 excluded value");
    expect(out).toContain("        - values must be valid");
    expect(out).toContain("        - allowed characters: A-Za-z");
    // Both payload directions, and the attached agreement.
    expect(out).toContain("    - risk_score");
    expect(out).toContain("    - program_outcome");
    expect(out).toContain("    reference: MOU-2026-0001");
    expect(out).toContain(
      "    stated purpose: Evaluation of the county tutoring program",
    );
    expect(out).toContain("    agreement valid through: 2027-12-31");
  });

  test("displayInvitation: a deduplicating term states what it discloses and whose records pay it", () => {
    // The run honors deduplicate, so the line is a plain fact -- and a deduplicating
    // match discloses grouping a one-to-one match does not, which the acceptor is
    // consenting to. The statement is shared wording, printed under the headline it
    // qualifies rather than one block away. The direction note sits with it at the
    // same level: the setting is the inviting party's own, this party's own side
    // being derived as false at accept.
    const log = getLogger("accept-display-deduplicate-test");
    log.setLevel("silent");
    const base = sampleToken(FUTURE());
    const render = (overrides: Partial<LinkageTerms>): string =>
      renderDisplayInvitation(log, {
        ...base,
        linkageTerms: { ...base.linkageTerms, ...overrides },
      });

    const oneToOne = render({});
    expect(oneToOne).toContain(
      "duplicate matches (enforced): each of the inviting party's records " +
        "matches at most one of the accepting party's records",
    );
    // A one-to-one exchange discloses no grouping at all, so neither sentence must
    // reach it: their presence below is the setting's doing rather than the
    // fixture's.
    expect(oneToOne).not.toContain(
      DEDUPLICATE_SHARED_RESULT_DISCLOSURE_STATEMENT,
    );
    expect(oneToOne).not.toContain(
      DEDUPLICATE_SOLE_RECEIVER_DISCLOSURE_STATEMENT,
    );
    expect(oneToOne).not.toContain(DEDUPLICATE_ACCEPTOR_SIDE_NOTE);

    const deduplicating = render({ deduplicate: true });
    expect(deduplicating).toContain(
      "duplicate matches (enforced): more than one of the inviting party's " +
        "records may match a single one of the accepting party's records",
    );
    expect(deduplicating).toContain(
      `    ${DEDUPLICATE_SHARED_RESULT_DISCLOSURE_STATEMENT}`,
    );
    // Same indent as the statement it follows, so the acceptor reads what the
    // setting discloses and whose file is grouped to disclose it in one place
    // rather than a screen apart.
    expect(deduplicating).toContain(`    ${DEDUPLICATE_ACCEPTOR_SIDE_NOTE}`);
    // The sample token shares the result with this party, so the sole-receiver
    // sentence must not reach it -- nor the display limit that qualifies it, since
    // this party IS presented the grouping here.
    expect(deduplicating).not.toContain(
      DEDUPLICATE_SOLE_RECEIVER_DISCLOSURE_STATEMENT,
    );
    expect(deduplicating).not.toContain(
      CONSENT_FACTS.duplicateGroupingDisplayLimit.note,
    );
  });

  test("displayInvitation: a sole-receiver deduplicating term states psilink presents the acceptor no grouping when the inviter alone receives", () => {
    // The other output shape a deduplicating invitation can take: the inviting
    // party receives the result and shares none of it, so this party is sent no
    // table and is presented no grouping. The shared-result sentence would tell it
    // what it learns about the inviting party's groups, which this client shows it
    // not at all -- so the shape selects the other statement, and the direction
    // note stays, its widening applying to either shape.
    const log = getLogger("accept-display-deduplicate-sole-receiver-test");
    log.setLevel("silent");
    const base = sampleToken(FUTURE());
    const soleReceiver = renderDisplayInvitation(log, {
      ...base,
      linkageTerms: {
        ...base.linkageTerms,
        deduplicate: true,
        output: { expectsOutput: true, shareWithPartner: false },
      },
    });

    expect(soleReceiver).toContain(
      `    ${DEDUPLICATE_SOLE_RECEIVER_DISCLOSURE_STATEMENT}`,
    );
    // The limit on that withholding is its own classified fact, rendered from the
    // shared table at the same level as the statement it qualifies: what the
    // statement says psilink presents, this says the rounds still hold.
    expect(soleReceiver).toContain(
      `    ${CONSENT_FACTS.duplicateGroupingDisplayLimit.note}`,
    );
    expect(CONSENT_FACTS.duplicateGroupingDisplayLimit.basis).toBe(
      "trust-contingent",
    );
    expect(soleReceiver).toContain(`    ${DEDUPLICATE_ACCEPTOR_SIDE_NOTE}`);
    expect(soleReceiver).not.toContain(
      DEDUPLICATE_SHARED_RESULT_DISCLOSURE_STATEMENT,
    );
  });

  test("displayInvitation: a deduplicating term states its disclosure under single-pass too", () => {
    // The renderer withholds what a deduplicating run discloses when the strategy
    // matches no deduplicating cardinality, since stating it would describe a run
    // that cannot happen -- and it reads that verdict from core rather than from
    // the strategy's name, so an invitation on the other strategy states the same
    // disclosure the cascade one does. That the withholding still follows a `false`
    // verdict is driven over the whole verdict table in core's
    // invitationSummary.test.ts, which can flip one.
    const log = getLogger("accept-display-deduplicate-single-pass-test");
    log.setLevel("silent");
    const base = sampleToken(FUTURE());
    const singlePass = renderDisplayInvitation(log, {
      ...base,
      linkageTerms: {
        ...base.linkageTerms,
        deduplicate: true,
        linkageStrategy: "single-pass",
      },
    });

    expect(singlePass).toContain(
      "duplicate matches (enforced): more than one of the inviting party's " +
        "records may match a single one of the accepting party's records",
    );
    expect(singlePass).toContain(
      `    ${DEDUPLICATE_SHARED_RESULT_DISCLOSURE_STATEMENT}`,
    );
    expect(singlePass).toContain(`    ${DEDUPLICATE_ACCEPTOR_SIDE_NOTE}`);
  });

  test("displayInvitation: the retain line is printed at both decision blocks, its caveat once, and neither where retention is undisclosed", () => {
    const log = getLogger("accept-display-retain-test");
    log.setLevel("silent");
    const base = sampleToken(FUTURE());
    const RETAIN_LABEL = "  exchange files (enforced): ";

    // The declaration is a decision fact: what outlives the run is exactly what an
    // operator must have in front of them when the y/N question is asked, and the
    // terms are far longer than a screen, so it prints at BOTH decision blocks --
    // heading the terms and again above the prompt -- like every other fact there.
    const retaining = renderDisplayInvitation(log, {
      ...base,
      inviterRetainsFiles: true,
    });
    const lines = retaining.split("\n");
    const retainAt = lines
      .map((line, index) => (line.startsWith(RETAIN_LABEL) ? index : -1))
      .filter((index) => index >= 0);
    expect(retainAt).toHaveLength(2);
    for (const index of retainAt)
      expect(lines[index]).toBe(
        `${RETAIN_LABEL}kept as a permanent transcript, not deleted after the run`,
      );

    // The caveat is the half the run does not hold, and it is printed ONCE, in the
    // outline, rather than at both printings of the block: ten wrapped lines twice
    // over is what pushes the outbound-send list -- the first line of the block, and
    // the acceptor's hardest-to-undo consent -- off a short terminal at the prompt.
    // No shortened wording stands in for it in the block, since an abridgement is a
    // second account of the fact this shape exists to keep to one.
    const noteLine = `    ${CONSENT_FACTS.retainedFiles.note}`;
    expect(lines.filter((line) => line === noteLine)).toHaveLength(1);
    // Directly under the line it explains. The block emits the retain line last for
    // this: a caveat printed after whatever else the block reached would be treated
    // as that line's instead, and the contradicted-citation lines can be there.
    expect(lines[retainAt[0] + 1]).toBe(noteLine);
    // And nothing of it reaches the repetition, whose whole point here is its
    // length: the tail from the heading down is the block alone.
    expect(lines.slice(lines.indexOf(REPEAT_HEADING))).not.toContain(noteLine);

    // Neither absence renders anything, and the two are not alike by accident: an
    // invitation minted before the field existed made no claim, and one declaring
    // delete mode is claiming a cleanup this transport does not promise (a run
    // killed outright, or one failing after the handshake, leaves files in either
    // mode). Both would mislead as a stated fact, so both print nothing.
    for (const declaration of [{}, { inviterRetainsFiles: false }]) {
      const rendered = renderDisplayInvitation(log, {
        ...base,
        ...declaration,
      });
      expect(rendered).not.toContain("exchange files");
      expect(rendered).not.toContain(CONSENT_FACTS.retainedFiles.note);
    }
  });

  test("displayInvitation: a split-directory endpoint states the retention with no declaration", () => {
    // The seeded sub-case: this accept builds its connection from the endpoint and
    // is put in retain mode by its shape (a split pair cannot be configured
    // without it), so a prompt gated on the declaration alone would take consent to
    // a permanent transcript in silence. Both the seeding and this line read
    // core's endpointRequiresRetainedFiles, so the endpoint that seeds the mode is
    // the endpoint that states it.
    const log = getLogger("accept-display-retain-endpoint-test");
    log.setLevel("silent");
    const split: ConnectionEndpoint = {
      channel: "filedrop",
      inboundPath: "/mnt/share/in",
      outboundPath: "/mnt/share/out",
    };
    const rendered = renderDisplayInvitation(log, sampleToken(FUTURE(), split));
    expect(rendered).toContain(
      "  exchange files (enforced): kept as a permanent transcript, not deleted " +
        "after the run",
    );
    expect(rendered).toContain(`    ${CONSENT_FACTS.retainedFiles.note}`);

    // And the shape test does not widen to "holds an endpoint": a single shared
    // directory seeds no options, and its acceptor sets its own mode, so an
    // invitation naming one and declaring nothing states nothing here.
    const shared: ConnectionEndpoint = {
      channel: "filedrop",
      path: "/mnt/share",
    };
    const sharedRendered = renderDisplayInvitation(
      log,
      sampleToken(FUTURE(), shared),
    );
    expect(sharedRendered).not.toContain("exchange files");
    expect(sharedRendered).not.toContain(CONSENT_FACTS.retainedFiles.note);
  });

  test("displayInvitation: every classified fact is marked, and holds core's caveat verbatim", () => {
    // An acceptor meets two unlike kinds of fact here: ones the exchange holds
    // itself, and ones that are only what the inviting party declared. Treating a
    // cooperative undertaking as a cryptographic guarantee is the error this
    // marking exists to prevent, so an enforced line is marked positively rather
    // than told apart by the absence of a marker on the other.
    const log = getLogger("accept-display-basis-test");
    log.setLevel("silent");
    const render = (output: LinkageTerms["output"], receive: boolean): string =>
      renderDisplayInvitation(log, {
        ...sampleToken(FUTURE()),
        linkageTerms: {
          ...CONSENT_PROBE_TERMS,
          output,
          // A party that receives no output may request no payload columns, so the
          // request is dropped alongside expectsOutput rather than left to fail the
          // schema.
          payload: receive
            ? CONSENT_PROBE_TERMS.payload
            : { ...CONSENT_PROBE_TERMS.payload, receive: [] },
        },
      });
    // Between them these two raise every caveat the shared table holds: this
    // party receives nothing while the inviter does, then the reverse.
    const acceptorWithheld = render(
      { expectsOutput: true, shareWithPartner: false },
      true,
    );
    const inviterWithheld = render(
      { expectsOutput: false, shareWithPartner: true },
      false,
    );
    // The count-only tier is the third rendering, because its caveats are the ones no
    // `psi` invitation raises: a table entry the renderer never reaches is exactly
    // what this test exists to catch, so the tier has to be rendered here rather than
    // exempted from the sweep.
    //
    // The retain declaration is the fourth, and for the same reason one step further
    // out: it is held on the TOKEN rather than in the terms, so no variation of
    // `output`, `payload`, or `algorithm` above can raise its caveat.
    const retaining = renderDisplayInvitation(log, {
      ...sampleToken(FUTURE()),
      inviterRetainsFiles: true,
    });
    // The fan-out pair is the fifth and sixth, for the same reason again: both are
    // raised by a linkage key that splits its element's value, and which of the two
    // follows the strategy, so no variation above reaches either.
    const fanOutMatched = renderDisplayInvitation(
      log,
      splittingKeyToken(FUTURE(), "single-pass"),
    );
    const fanOutRefused = renderDisplayInvitation(
      log,
      splittingKeyToken(FUTURE(), "cascade"),
    );
    // The sole receiver's display limit is the seventh, for the reason the pair
    // above is a pair: it is raised only by a DEDUPLICATING invitation whose
    // inviting party receives the result alone, and no variation above declares
    // the term at all.
    const deduplicatingSoleReceiver = renderDisplayInvitation(log, {
      ...sampleToken(FUTURE()),
      linkageTerms: {
        ...CONSENT_PROBE_TERMS,
        deduplicate: true,
        output: { expectsOutput: true, shareWithPartner: false },
        payload: { ...CONSENT_PROBE_TERMS.payload, receive: [] },
      },
    });
    const rendered = [
      acceptorWithheld,
      inviterWithheld,
      renderCountOnlyFacts(),
      retaining,
      fanOutMatched,
      fanOutRefused,
      deduplicatingSoleReceiver,
    ].join("\n");

    // The whole table, rather than a list restated here: a caveat this renderer
    // authored for itself instead of reading is absent from the rendering and fails,
    // and one the web reworded on its own side fails there for the same reason.
    const classified: Array<ConsentFact> = Object.values(CONSENT_FACTS);
    const notes = classified
      .map((fact) => fact.note)
      .filter((note) => note !== undefined);
    expect(notes.length).toBeGreaterThan(0);
    for (const note of notes) expect(rendered).toContain(`\n    ${note}`);

    // Both classes marked, on the pair whose difference in register is the whole
    // reason for marking: this party's own non-receipt is a hard fact the run holds,
    // and withholding a result from the partner is not.
    expect(acceptorWithheld).toContain(
      "  you will receive the result (enforced): no",
    );
    expect(inviterWithheld).toContain(
      "  you will receive the result (enforced): yes",
    );
    // The partner's receipt line is marked by its VALUE, not by the line: a partner
    // that receives is one the run delivers to, and only its use of the result rests
    // on the agreement; a partner that does not receive rests on the agreement for
    // the whole fact.
    expect(acceptorWithheld).toContain(
      "  the inviting party will receive the result (enforced): yes",
    );
    expect(inviterWithheld).toContain(
      "  the inviting party will receive the result (your partner's word): no",
    );
    // The honest-helper disclosure is its own fact, not a rider on the cooperative
    // caveat: it holds however honestly the partner behaves, so it has the
    // opposite basis and may not inherit that line's marker.
    expect(inviterWithheld).toContain(
      "  what your partner learns either way (enforced):",
    );
    // The remaining marked lines, each on the register it belongs to.
    expect(rendered).toContain(`  ${INVITING_PARTY_LABEL}: `);
    expect(rendered).toContain(
      "      declared data standards (your partner's word):",
    );
    expect(rendered).toContain(
      "  allowed-character patterns (your partner's word):",
    );
    // The mode agreement is what the run holds, so the marker is the enforced one;
    // what becomes of the transcript afterwards rides the caveat swept above.
    expect(retaining).toContain(
      "  exchange files (enforced): kept as a permanent transcript, not deleted " +
        "after the run",
    );
  });
});

// The two count-only sentences spelled out rather than read from the shared table,
// for the reason the refusal caveat below is spelled out: an acceptor can ACT on
// either -- the first states the guarantee, the second states what it does not
// cover -- so an edit to either has to be made here as well, on this surface,
// rather than followed. The tier's remaining wording is read from the table, where
// a surface restating it on its own is what fails.
const COUNT_ONLY_STATEMENT =
  "Only the number of records you have in common is revealed, not which " +
  "records match.";
const COUNT_ONLY_INPUT_CHOICE_BOUND =
  "Not enforced against your partner's choice of input: a count-only exchange " +
  "bounds what psilink hands your partner, not what they can learn by choosing " +
  "which records to ask about. A crafted list, or a second run differing by one " +
  "record, turns a count into an answer about one person.";

/**
 * The five tier sentences, read from the shared table by this surface and by the
 * web consent screen. The algorithm is what makes them one class: a psi-c
 * invitation reaches every one of them on BOTH surfaces and a `psi` invitation
 * reaches none, so an assertion over this list states a cross-surface invariant.
 *
 * COUNT_ONLY_STATEMENT is not in it. That sentence is shared wording
 * with a different placement on each surface -- the web renders it as its
 * matching-method headline, this prompt beneath the algorithm it names -- so its
 * placement is a fact about this prompt alone and is asserted as one.
 */
const COUNT_ONLY_TIER_NOTES = [
  CONSENT_FACTS.countOnlyResult.note,
  CONSENT_FACTS.countOnlyRoundDisclosures.note,
  CONSENT_FACTS.countOnlyReportedCount.note,
  CONSENT_FACTS.countOnlyInputChoice.note,
  CONSENT_FACTS.countOnlyNoPayload.note,
];

/**
 * The decision block for a count-only exchange, over the output direction, the
 * acceptor's own resolved outbound set, and the declared payload each case needs.
 * Rendered from the real shared summary, so what is measured is this renderer's
 * own reading of the algorithm and the words it puts behind it.
 */
function renderCountOnlyFacts(
  output: LinkageTerms["output"] = {
    expectsOutput: true,
    shareWithPartner: true,
  },
  ownOutboundSend: ReadonlyArray<string> = [],
  payload: LinkageTerms["payload"] = COUNT_ONLY_PROBE_TERMS.payload,
): string {
  const block: Array<string> = [];
  logDecisionFacts(
    (line) => {
      block.push(line);
    },
    summarizeInvitation({
      ...sampleToken(FUTURE()),
      linkageTerms: { ...COUNT_ONLY_PROBE_TERMS, output, payload },
    }),
    ownOutboundSend,
  );
  return block.join("\n");
}

describe("the count-only tier", () => {
  test("the count-only tier reaches the prompt, on both surfaces, from one terms document", () => {
    // The exchange conducts a count-only run, so what an acceptor reads for a psi-c
    // invitation is the tier stating what it discloses -- never a caveat saying the
    // algorithm is refused, and never the psi consequence that matched identifiers
    // are revealed.
    //
    // apps/web/test/browser/invitationTermsCountOnly pins the same sentences against
    // the same terms document, so the pair cannot drift apart silently.
    const log = getLogger("accept-display-psi-c-test");
    log.setLevel("silent");
    const shaped = renderDisplayInvitation(log, {
      ...sampleToken(FUTURE()),
      linkageTerms: COUNT_ONLY_PROBE_TERMS,
    });
    expect(shaped).toContain("PSI algorithm (enforced): psi-c");
    for (const copy of COUNT_ONLY_TIER_NOTES) expect(shaped).toContain(copy);
    expect(shaped).not.toContain(
      "the shared identifiers of matched records are still revealed",
    );
    expect(shaped).not.toContain("does not yet apply it");
    // The headline is the other class: shared wording each surface places for
    // itself, which this prompt prints beneath the algorithm it names. Asserted for
    // this surface only, so the list above keeps stating the invariant both surfaces
    // hold rather than one this one alone does.
    expect(shaped).toContain(`    ${COUNT_ONLY_STATEMENT}`);
    // Non-vacuous the other way: a `psi` invitation reaches no sentence of the tier,
    // so the presence above is the algorithm's doing.
    const revealing = renderDisplayInvitation(log, {
      ...sampleToken(FUTURE()),
      linkageTerms: CONSENT_PROBE_TERMS,
    });
    for (const copy of COUNT_ONLY_TIER_NOTES)
      expect(revealing).not.toContain(copy);
    expect(revealing).not.toContain(COUNT_ONLY_STATEMENT);
  });

  test("a one-sided count-only invitation states no honest-helper membership disclosure", () => {
    // The membership fact is scoped by the ALGORITHM: by the role rule the
    // non-receiving party of a count-only run is the sender, which computes nothing
    // from the round and is sent no count-report frame, so it learns no membership of
    // its own records. The web consent screen pins the same pair.
    const log = getLogger("accept-display-count-only-membership-test");
    log.setLevel("silent");
    const partnerWithheld: LinkageTerms["output"] = {
      expectsOutput: false,
      shareWithPartner: true,
    };
    const countOnly = renderDisplayInvitation(log, {
      ...sampleToken(FUTURE()),
      linkageTerms: { ...COUNT_ONLY_PROBE_TERMS, output: partnerWithheld },
    });
    expect(countOnly).toContain("PSI algorithm (enforced): psi-c");
    expect(countOnly).not.toContain("what your partner learns either way");
    expect(countOnly).not.toContain(
      CONSENT_FACTS.partnerLearnsOwnMembership.note,
    );
    // Not the whole block going missing: the line the membership fact sits beneath is
    // still stated, on the register it belongs to.
    expect(countOnly).toContain(
      "  the inviting party will receive the result (your partner's word): no",
    );
    // What replaces it, from docs/spec/PROTOCOL.md's PSI-C learn-basis rows rather
    // than from a softened version of the claim: the enforced half that hands neither
    // party a pairing, and what the rounds disclose beside the count.
    expect(countOnly).toContain(`    ${CONSENT_FACTS.countOnlyResult.note}`);
    expect(countOnly).toContain(
      `    ${CONSENT_FACTS.countOnlyRoundDisclosures.note}`,
    );
    // Non-vacuous the other way: the same one-sided pair under `psi` -- the algorithm
    // the fact is true of -- holds it in full, so the absence above is the
    // algorithm's doing and not the output pair's.
    const revealing = renderDisplayInvitation(log, {
      ...sampleToken(FUTURE()),
      linkageTerms: {
        ...CONSENT_PROBE_TERMS,
        output: partnerWithheld,
        payload: { ...CONSENT_PROBE_TERMS.payload, receive: [] },
      },
    });
    expect(revealing).toContain(
      "  what your partner learns either way (enforced):",
    );
    expect(revealing).toContain(
      `    ${CONSENT_FACTS.partnerLearnsOwnMembership.note}`,
    );
  });

  test("a count-only exchange states its disclosure tier on the register the protocol assigns each half", () => {
    // Each line's marker is the one docs/spec/PROTOCOL.md's PSI-C section assigns
    // that row: a party's own
    // count-only outcome and its view of what the partner receives are held by the
    // run, the count a both-entitled party did not compute is the other's report,
    // and the protection a chosen input set defeats rests on the partner
    // contributing a genuine dataset. Marking any of the three the other way is the
    // error the vocabulary exists to prevent.
    const block = renderCountOnlyFacts();
    expect(block).toContain("  PSI algorithm (enforced): psi-c");
    expect(block).toContain(`    ${COUNT_ONLY_STATEMENT}`);
    expect(block).not.toContain("does not yet apply it");
    expect(block).toContain(
      "  what a count-only exchange still discloses (enforced):",
    );
    expect(block).toContain(
      "  how the count reaches each of you (your partner's word):",
    );
    expect(block).toContain(
      "  what a count-only exchange does not bound (your partner's word):",
    );
    expect(block).toContain(`    ${COUNT_ONLY_INPUT_CHOICE_BOUND}`);
    // The acceptor's own outbound line, answered by the algorithm rather than by who
    // receives the count: both parties are entitled here, so the entitlement-driven
    // sentence would have listed columns instead.
    expect(block).toContain("  columns you will send (enforced): (none)");
    expect(block).toContain(`    ${CONSENT_FACTS.countOnlyNoPayload.note}`);
    expect(block).not.toContain("the inviting party receives no result");
  });

  test("a count-only rendering refuses a resolved outbound set rather than state (none) over it", () => {
    // The "(none)" line states a precondition -- psi-c admits no payload in either
    // direction -- rather than a set the renderer read. This set is this party's own
    // resolved metadata, so a column in it is one the accept path already refused
    // (assertCountOnlyTransmitsNoColumn); this throw is the render-side safety check
    // behind it, since printing "(none)" over a column would take the operator's
    // consent to a disclosure that happens, on the one screen where the disclosure IS
    // the decision. Driven with a column in the set, so the check is measured firing
    // rather than assumed.
    expect(() => renderCountOnlyFacts(undefined, ["risk_score"])).toThrow(
      /no payload in either direction/,
    );
    // Non-vacuous the other way: the same call with an empty set renders the line, so
    // the throw above is the column's doing.
    expect(renderCountOnlyFacts()).toContain(
      "  columns you will send (enforced): (none)",
    );
    // And the check is the count-only branch's alone: a psi invitation resolving the
    // same set lists it, which is what makes the refusal a statement about psi-c.
    const log = getLogger("accept-display-count-only-outbound-test");
    log.setLevel("silent");
    expect(
      renderDisplayInvitation(
        log,
        { ...sampleToken(FUTURE()), linkageTerms: CONSENT_PROBE_TERMS },
        ["risk_score"],
      ),
    ).toContain("  columns you will send (enforced):\n    - risk_score");
  });

  test("a count-only rendering refuses terms that declare a payload column", () => {
    // The mirror of the check above, on the partner's side of it: the invitation is
    // partner-controlled, and a psi-c document declaring a send or a receive is one
    // the spec refuses (docs/spec/PROTOCOL.md, PSI-C). Printed, the tier's no-payload
    // sentence would stand above this same prompt's blocks listing the columns that
    // invitation will send or asks for -- a guarantee stated over the declaration
    // contradicting it. Driven on each direction with the flag forced on, so the check
    // is measured firing rather than assumed.
    expect(() =>
      renderCountOnlyFacts(undefined, [], {
        send: [{ name: "risk_score" }],
        receive: [],
      }),
    ).toThrow(/declare a payload column/);
    expect(() =>
      renderCountOnlyFacts(undefined, [], {
        send: [],
        receive: [{ name: "risk_score" }],
      }),
    ).toThrow(/declare a payload column/);
    // Non-vacuous the other way: the conforming document -- the empty pair psi-c
    // requires -- renders the sentence, so the throws above are the declaration's
    // doing and not the flag's.
    expect(renderCountOnlyFacts()).toContain(
      `    ${CONSENT_FACTS.countOnlyNoPayload.note}`,
    );
    // And the check is the count-only branch's alone: a psi invitation declaring the
    // same columns prints them.
    const log = getLogger("accept-display-count-only-declared-payload-test");
    log.setLevel("silent");
    expect(
      renderDisplayInvitation(log, {
        ...sampleToken(FUTURE()),
        linkageTerms: {
          ...CONSENT_PROBE_TERMS,
          payload: { send: [], receive: [{ name: "risk_score" }] },
        },
      }),
    ).toContain("    - risk_score");
  });

  test("the count a party did not compute is caveated only where both parties are entitled to one", () => {
    // Where exactly one party is entitled to the count, that party is the receiver by
    // the role rule and computes its own, so no report crosses and a line saying one
    // does would name a frame the run does not send. The bound on the guarantee is
    // not conditional in the same way and stays.
    const oneSided = renderCountOnlyFacts({
      expectsOutput: false,
      shareWithPartner: true,
    });
    expect(oneSided).not.toContain("how the count reaches each of you");
    expect(oneSided).not.toContain(CONSENT_FACTS.countOnlyReportedCount.note);
    expect(oneSided).toContain("  what a count-only exchange does not bound");
  });
});

/**
 * The probe terms holding a single linkage key whose one element applies
 * `transform`, so a transform-rendering assertion reads that key's detail with no
 * other key's rules at the same indent. The probe's own fields are reused as-is.
 */
function probeTermsWithTransform(
  transform: Array<TransformStep>,
): LinkageTerms {
  return {
    ...CONSENT_PROBE_TERMS,
    linkageKeys: [
      { name: "probe key", elements: [{ field: "given_name", transform }] },
    ],
  };
}

// The two headings the repeated decision block can sit under. Only the framing
// differs: a prompt follows on one path and nothing does on the other.
const REPEAT_HEADING = "Before you accept, repeated from above:";
const REPEAT_HEADING_UNATTENDED = "Repeated from above:";

describe("displayInvitation: linkage-key detail, heading order, and the repeated decision block", () => {
  test("displayInvitation: a transform this version cannot explain is marked as unrecognized", () => {
    // A declared function name core does not recognize has neither a literal slice
    // phrase nor a glossary description, so unmarked it prints in exactly the shape
    // of a recognized rule minus one line -- indistinguishable from a rule psilink
    // understands. A rule this version cannot explain earns the same explicitness as
    // one it cannot apply.
    const log = getLogger("accept-display-unknown-transform-test");
    log.setLevel("silent");
    const render = (transform: Array<TransformStep>): string =>
      renderDisplayInvitation(log, {
        ...sampleToken(FUTURE()),
        linkageTerms: probeTermsWithTransform(transform),
      });

    const unrecognized = render([{ function: "org_internal_rule" }]);
    expect(unrecognized).toContain("          transform: org_internal_rule");
    expect(unrecognized).toContain(
      `            ${UNRECOGNIZED_TRANSFORM_NOTE}`,
    );
    // A recognized function has its plain-language consequence and no marker, so
    // the marker tells the two apart rather than decorating both.
    const recognized = render([{ function: "to_upper_case" }]);
    expect(recognized).toContain(
      "            Upper-cases the value before matching, so values differing only in letter case can match.",
    );
    expect(recognized).not.toContain(UNRECOGNIZED_TRANSFORM_NOTE);
  });

  test("displayInvitation: a coerced transform parameter names the parameter and the value it runs as", () => {
    // `replace_regex` with `replacement: null` executes as the empty string. The
    // declared parameter is shown verbatim and the coercion is its own line, so
    // partner text placed inside a parameter value cannot impersonate it; this pins
    // the CLI's own rendering of that line, including which half is the parameter.
    const log = getLogger("accept-display-coercion-test");
    log.setLevel("silent");
    const lines = renderDisplayInvitation(log, {
      ...sampleToken(FUTURE()),
      linkageTerms: probeTermsWithTransform([
        {
          function: "replace_regex",
          params: { pattern: "-", replacement: null },
        },
      ]),
    }).split("\n");

    const coercion = "            replacement runs as the empty string";
    const param = "            - replacement: null";
    expect(lines).toContain(param);
    expect(lines).toContain(coercion);
    // The parameter names itself first: a swapped interpolation would be treated as
    // a parameter called "the empty string".
    expect(lines).not.toContain(
      "            the empty string runs as replacement",
    );
    expect(lines.indexOf(coercion)).toBeGreaterThan(lines.indexOf(param));
  });

  test("displayInvitation: names the fields matched on, once at the top and under each key", () => {
    // The key `name` is partner free text and would otherwise be the only line at a
    // key's own level, so an operator scanning key headings would read nothing but
    // strings the inviter chose. The derived field one-liner is the accurate anchor,
    // and it has the breadth the rules alone do not spell out.
    const log = getLogger("accept-display-matched-fields-test");
    log.setLevel("silent");
    const lines = renderDisplayInvitation(log, {
      ...sampleToken(FUTURE()),
      linkageTerms: CONSENT_PROBE_TERMS,
    }).split("\n");

    expect(lines).toContain(
      "  matched on (enforced): first name, last name, date of birth",
    );
    // The swap re-attributes each element's marker to its partner's field. Its two
    // positions hold one transform -- the terms refuse a pair whose transforms
    // differ -- so the truncation is shown on both of the fields it reads, and the
    // unswapped date element keeps its own marker.
    const keyIndex = lines.indexOf(
      "    - given name, family name, and date of birth",
    );
    expect(keyIndex).toBeGreaterThanOrEqual(0);
    expect(lines[keyIndex + 1]).toBe(
      "      matches on: first name (partial) - last name (partial) - " +
        "date of birth (fuzzy) (matched in either order)",
    );
    expect(lines[keyIndex + 2]).toBe("      elements:");
  });

  test("displayInvitation: the operator's own outbound heading sits level with the other payload headings", () => {
    // Indentation shows hierarchy in this outline, so the operator's own outbound
    // disclosure must not be the one heading a level below its two counterparts, at
    // the depth of a linkage-key entry.
    const log = getLogger("accept-display-indent-test");
    log.setLevel("silent");
    const lines = renderDisplayInvitation(
      log,
      {
        ...sampleToken(FUTURE()),
        linkageTerms: CONSENT_PROBE_TERMS,
        disclosedPayloadColumns: ["risk_score"],
      },
      ["diagnosis"],
    ).split("\n");

    expect(lines).toContain(`  ${OUTBOUND_SEND_LABEL}:`);
    expect(lines).toContain(
      "  columns you will receive (enforced, 1 declared):",
    );
    expect(lines).toContain(
      "  columns the inviting party requests from you " +
        "(your partner's word, 1 declared):",
    );
    expect(outboundSendEntries(lines)).toEqual(["diagnosis"]);
  });

  test("displayInvitation: the short field list precedes the long key list", () => {
    // The keys enumerate combinations OF the fields and run many times longer, so on
    // a terminal the block printed second is the one that scrolls the first away.
    const log = getLogger("accept-display-order-test");
    log.setLevel("silent");
    const lines = renderDisplayInvitation(log, {
      ...sampleToken(FUTURE()),
      linkageTerms: CONSENT_PROBE_TERMS,
    }).split("\n");

    const fields = lines.indexOf("  personal data used (enforced):");
    const keys = lines.indexOf("  linkage keys (enforced):");
    expect(fields).toBeGreaterThanOrEqual(0);
    expect(keys).toBeGreaterThan(fields);
  });

  test("displayInvitation: the decision facts are repeated verbatim immediately before the prompt", () => {
    // The terms run well past a screen, so an operator answering the prompt reads the
    // tail: the columns they send, who they disclose to, and the algorithm have all
    // scrolled away. They are printed again last, by the same renderer that prints
    // them first, and this measures the property that makes the second printing a
    // repetition rather than a second account -- the two are byte-identical, so
    // neither can state a fact the other does not. A recap composing its own wording
    // is what would need a check that its facts appear above; this needs only that
    // the bytes match.
    const log = getLogger("accept-display-repeat-test");
    log.setLevel("silent");
    const defaultTerms = sampleTerms("Inviter Org");
    const cases: Array<{
      linkageTerms: LinkageTerms;
      ownOutboundSend: ReadonlyArray<string> | undefined;
      inviterRetainsFiles?: boolean;
    }> = [
      { linkageTerms: defaultTerms, ownOutboundSend: ["diagnosis", "notes"] },
      { linkageTerms: defaultTerms, ownOutboundSend: [] },
      { linkageTerms: defaultTerms, ownOutboundSend: undefined },
      { linkageTerms: CONSENT_PROBE_TERMS, ownOutboundSend: ["diagnosis"] },
      { linkageTerms: COUNT_ONLY_PROBE_TERMS, ownOutboundSend: [] },
      // A retaining invitation, whose fact is held in the block while its caveat
      // is printed once between the two printings. That split is exactly what a
      // sliding or prefix comparison would miss, so the case belongs here: the
      // caveat leaking into either printing lengthens it past the independently
      // rendered block and fails.
      {
        linkageTerms: defaultTerms,
        ownOutboundSend: ["diagnosis"],
        inviterRetainsFiles: true,
      },
      // The hostile fixtures, so the repetition is measured on a partner identity
      // holding escapes rather than only on well-behaved text.
      ...hostileVariants.map(({ source }) => ({
        linkageTerms: source.linkageTerms,
        ownOutboundSend: [`own${BEL}column`],
      })),
    ];

    for (const {
      linkageTerms,
      ownOutboundSend,
      inviterRetainsFiles,
    } of cases) {
      const token = {
        ...sampleToken(FUTURE()),
        linkageTerms,
        ...(inviterRetainsFiles === undefined ? {} : { inviterRetainsFiles }),
      };
      // The block is rendered independently rather than read off either printing, so
      // its LENGTH is measured too. Slicing the tail and comparing it to an
      // equal-length window at the head is a sliding comparison: it cannot see a line
      // appended after the repetition that happens to match the head's next line,
      // which leaves the end of the output unmeasured.
      const block: Array<string> = [];
      logDecisionFacts(
        (entry) => block.push(entry),
        summarizeInvitation(token),
        ownOutboundSend,
      );

      // Both paths through the consent decision. The heading differs -- under
      // --consent-to-terms no prompt follows, so a heading framing the block as
      // something to decide on would be asking for a decision already recorded --
      // and the block below it does not, which is what keeps the two printings one
      // wording rather than two.
      for (const [promptFollows, expectedHeading] of [
        [true, REPEAT_HEADING],
        [false, REPEAT_HEADING_UNATTENDED],
      ] as const) {
        const lines = renderDisplayInvitation(
          log,
          token,
          ownOutboundSend,
          promptFollows,
        ).split("\n");

        expect(lines.filter((line) => line === expectedHeading)).toHaveLength(
          1,
        );
        const heading = lines.indexOf(expectedHeading);
        // Exact equality, not a prefix: a line printed after the repetition makes
        // the tail longer than the block and fails here, whatever that line says.
        expect(lines.slice(heading + 1)).toEqual(block);
        // The same block, byte for byte, at the head of the display -- where index 0
        // is the "Invitation details:" heading the facts open under.
        expect(lines.slice(1, 1 + block.length)).toEqual(block);
        // The unattended heading asks nothing, so the prompting path's framing must
        // not survive anywhere on it.
        if (!promptFollows) expect(lines).not.toContain(REPEAT_HEADING);
      }

      // Non-vacuous: the block holds the decisive partner-controlled fact rather
      // than being an empty tail that trivially matches.
      expect(
        block.some((line) => line.startsWith(`  ${INVITING_PARTY_LABEL}: `)),
      ).toBe(true);
      expect(
        block.some((line) => line.startsWith(`  ${OUTBOUND_SEND_LABEL}`)),
      ).toBe(true);
    }
  });

  test("displayInvitation: every linkage key is listed, including one after an entry with nested detail", () => {
    // entriesUnder backs the separator-safety assertions, so it must collect
    // siblings across an entry's own nested block (a key's derived one-liner and its
    // elements) rather than halting there and silently under-checking. The first key
    // also has the list separator in its name, which a joined list would misread
    // as two keys.
    const log = getLogger("accept-display-key-siblings-test");
    log.setLevel("silent");
    const lines = renderDisplayInvitation(log, {
      ...sampleToken(FUTURE()),
      linkageTerms: {
        ...CONSENT_PROBE_TERMS,
        linkageKeys: [
          {
            name: "surname, given name",
            elements: [{ field: "family_name" }, { field: "given_name" }],
          },
          { name: "date of birth", elements: [{ field: "birth_date" }] },
        ],
      },
    }).split("\n");

    expect(entriesUnder(lines, "  linkage keys (enforced):")).toEqual([
      "surname, given name",
      "date of birth",
    ]);
  });

  test.each(hostileVariants)(
    "displayInvitation: every line stays printable ASCII on hostile terms ($name)",
    ({ source }) => {
      // The prompt renders every partner-controlled position the summary holds --
      // transform function names and parameters, the allowed-character class, the
      // legal agreement, the expiry -- so the escaping claim is checked over the
      // whole output rather than the few fields an enumeration would list. The
      // fixture is the same one the web app's consent screen is walked with, so the
      // two surfaces cannot drift on what a hostile invitation looks like. This also
      // pins that a key's raw `id` never reaches the prompt: it has the
      // unsanitized key name, which would fail here.
      const log = getLogger("accept-display-hostile-test");
      log.setLevel("silent");
      const lines = renderDisplayInvitation(
        log,
        { ...sampleToken(FUTURE()), ...source },
        [`own${BEL}column`],
      ).split("\n");
      // Guard against a vacuous pass: the prompt must have reached the nested
      // rules, and each hostile code point must appear in its escaped form -- so
      // an output that collapsed, or one the partner text never flowed into,
      // fails here rather than satisfying the assertion below by having nothing
      // to check.
      expect(lines.length).toBeGreaterThan(20);
      for (const hostile of [ESC, RLO, BEL])
        expect(
          lines.filter((line) => line.includes(sanitizeForDisplay(hostile)))
            .length,
        ).toBeGreaterThan(0);
      expect(lines.filter((line) => !PRINTABLE_ASCII.test(line))).toEqual([]);
    },
  );
});

// --- handler: repeated single-value flag -------------------------------------

describe("handler: repeated single-value flag", () => {
  test("handler: a repeated single-value flag is rejected (exit 64) via runOrExit", async () => {
    // accept has no command-specific single-value flags; it reads them all through
    // parseCommonBootstrapArgs inside runOrExit. A repeated common flag (here
    // --server-port) is therefore rejected with a clean usage error before
    // resolveAcceptPositionals/validateAccept run. runOrExit logs the message via
    // getLogger("accept").error; spying that method is robust because the guard
    // throws inside parseCommonBootstrapArgs, before setDefaultLevel could rebind
    // the logger's methods.
    const logErr = vi
      .spyOn(getLogger("accept"), "error")
      .mockImplementation(() => {});
    const exit = vi
      .spyOn(process, "exit")
      .mockImplementation((() => undefined) as never);
    try {
      await acceptHandler({
        _: [],
        $0: "psilink",
        identity: "Agency B",
        args: ["sftp://host/drop", "INVITATION", "input.csv"],
        "server-port": [2222, 2223],
      } as unknown as Arguments);
      // Assert before restoring the spies: mockRestore clears the recorded calls.
      expect(exit).toHaveBeenCalledWith(64);
      expect(logErr).toHaveBeenCalledWith(
        "--server-port may be given only once",
      );
    } finally {
      logErr.mockRestore();
      exit.mockRestore();
    }
  });

  test("handler: a mistyped --flag exits 64 naming it, before decode/prompt/write", async () => {
    // accept sets unknown-options-as-args (so a `-`-leading invitation survives),
    // which also lands a mistyped --server-usernam in the positionals; it must be
    // rejected before the invitation decode, the confirmation prompt, or any file
    // write -- not absorbed as the invitation positional.
    const dir = fs.mkdtempSync(path.join(tmpdir(), "psilink-accept-unknown-"));
    const configFile = path.join(dir, "psilink.yaml");
    const keyFile = path.join(dir, ".psilink.key");
    const exit = vi
      .spyOn(process, "exit")
      .mockImplementation((() => undefined) as never);
    // Read the rejection where the operator does, at a level that keeps it: the
    // handler applies --log-level to every logger, so `silent` drops this message
    // like any other, and a logger method spied before the run is replaced by the
    // one the level installs.
    const { stderrWrites, restore } = captureStdio();
    try {
      const encoded = await encodeInvitation(
        sampleToken(new Date(Date.now() + 3_600_000).toISOString()),
      );
      await acceptHandler({
        _: [],
        $0: "psilink",
        identity: "Agency B",
        args: ["--server-usernam", "u", encoded, "input.csv"],
        "config-file": configFile,
        "key-file": keyFile,
        "log-level": "error",
        record: false,
      } as unknown as Arguments);
      expect(exit).toHaveBeenCalledWith(64);
      expect(stderrWrites.join("")).toContain("--server-usernam");
      expect(promptConfirmMock).not.toHaveBeenCalled();
      expect(fs.existsSync(configFile)).toBe(false);
      expect(fs.existsSync(keyFile)).toBe(false);
    } finally {
      restore();
      exit.mockRestore();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

// --- handler: `--consent-to-terms` gates the confirmation prompt -------------

/** A temp dir with a satisfiable offline-accept input CSV and config/key paths. */
function offlineAcceptFixture(): {
  dir: string;
  input: string;
  configFile: string;
  keyFile: string;
} {
  const dir = fs.mkdtempSync(path.join(tmpdir(), "psilink-accept-consent-"));
  const input = path.join(dir, "input.csv");
  fs.writeFileSync(
    input,
    "first_name,last_name,dob,ssn\nAlice,Smith,1990-01-02,123456789\n",
  );
  return {
    dir,
    input,
    configFile: path.join(dir, "psilink.yaml"),
    keyFile: path.join(dir, ".psilink.key"),
  };
}

describe("handler: '--consent-to-terms' gates the confirmation prompt", () => {
  test("handler: at a terminal with no --identity, the answer lands in the config it writes", async () => {
    // The whole point of asking: the label reaches the file this acceptance
    // writes, so the later `psilink exchange` over it sends the name the operator
    // gave here. Both questions belong to one session -- the identity first, then
    // the terms and their y/N -- so the consent prompt is answered too.
    const { dir, input, configFile, keyFile } = offlineAcceptFixture();
    promptFreeTextMock.mockResolvedValue("Agency B, Health Dept");
    promptConfirmMock.mockResolvedValue(true);
    const exit = vi
      .spyOn(process, "exit")
      .mockImplementation((() => undefined) as never);
    const stdio = captureStdio();
    try {
      const encoded = await encodeInvitation(
        sampleToken(new Date(Date.now() + 3_600_000).toISOString()),
      );
      await withStdinStream(ttyStream(), () =>
        acceptHandler({
          _: [],
          $0: "psilink",
          args: [encoded, input],
          "config-file": configFile,
          "key-file": keyFile,
          "log-level": "silent",
          record: false,
        } as unknown as Arguments),
      );
      stdio.restore();
      expect(exit).not.toHaveBeenCalled();
      expect(promptFreeTextMock).toHaveBeenCalledTimes(1);
      expect(promptFreeTextMock).toHaveBeenCalledWith(ACCEPT_IDENTITY_QUESTION);
      expect(promptConfirmMock).toHaveBeenCalledTimes(1);
      expect(
        parseExchangeSpec(YAML.parse(fs.readFileSync(configFile, "utf8")))
          .linkageTerms.identity,
      ).toBe("Agency B, Health Dept");
    } finally {
      stdio.restore();
      exit.mockRestore();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("handler: with no terminal, an unnamed acceptance is refused, not left waiting", async () => {
    // The unattended shape -- a pipe, a container run without -t, CI. Nothing is
    // asked, because nothing would answer; what the operator gets is the standing
    // refusal naming the flag, not a run blocked on a read.
    const { dir, input, configFile, keyFile } = offlineAcceptFixture();
    const exit = vi
      .spyOn(process, "exit")
      .mockImplementation((() => undefined) as never);
    const { stderrWrites, restore } = captureStdio();
    try {
      const encoded = await encodeInvitation(
        sampleToken(new Date(Date.now() + 3_600_000).toISOString()),
      );
      await withStdinStream(makeStdin(""), () =>
        acceptHandler({
          _: [],
          $0: "psilink",
          args: [encoded, input],
          "config-file": configFile,
          "key-file": keyFile,
          "log-level": "error",
          record: false,
        } as unknown as Arguments),
      );
      restore();
      expect(exit).toHaveBeenCalledWith(64);
      expect(stderrWrites.join("")).toContain("no identity for this party");
      expect(promptFreeTextMock).not.toHaveBeenCalled();
      expect(fs.existsSync(configFile)).toBe(false);
      expect(fs.existsSync(keyFile)).toBe(false);
    } finally {
      restore();
      exit.mockRestore();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("handler: --consent-to-terms asks nothing, identity question included", async () => {
    // The flag declares the run unattended and frees stdin for a `-` CSV, so
    // neither question may read it: an acceptance with no label takes the standing
    // refusal there even at a terminal, rather than growing a prompt the flag was
    // meant to remove.
    const { dir, input, configFile, keyFile } = offlineAcceptFixture();
    const exit = vi
      .spyOn(process, "exit")
      .mockImplementation((() => undefined) as never);
    const { restore } = captureStdio();
    try {
      const encoded = await encodeInvitation(
        sampleToken(new Date(Date.now() + 3_600_000).toISOString()),
      );
      await withStdinStream(ttyStream(), () =>
        acceptHandler({
          _: [],
          $0: "psilink",
          args: [encoded, input],
          "consent-to-terms": true,
          "config-file": configFile,
          "key-file": keyFile,
          "log-level": "error",
          record: false,
        } as unknown as Arguments),
      );
      restore();
      expect(exit).toHaveBeenCalledWith(64);
      expect(promptFreeTextMock).not.toHaveBeenCalled();
      expect(promptConfirmMock).not.toHaveBeenCalled();
      expect(fs.existsSync(configFile)).toBe(false);
    } finally {
      restore();
      exit.mockRestore();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("handler: --consent-to-terms skips the confirmation prompt and writes the config and key", async () => {
    // With --consent-to-terms the prompt is never consulted (promptConfirm is not
    // called, so stdin is not read for a confirmation) and the offline acceptance
    // proceeds to write both files, on the recorded advance consent.
    const { dir, input, configFile, keyFile } = offlineAcceptFixture();
    // afterEach resets the shared mock, so it starts clean here; this test needs no
    // implementation because it asserts promptConfirm is never called.
    const exit = vi
      .spyOn(process, "exit")
      .mockImplementation((() => undefined) as never);
    try {
      const encoded = await encodeInvitation(
        sampleToken(new Date(Date.now() + 3_600_000).toISOString()),
      );
      await acceptHandler({
        _: [],
        $0: "psilink",
        identity: "Agency B",
        args: [encoded, input],
        "consent-to-terms": true,
        "config-file": configFile,
        "key-file": keyFile,
        "log-level": "silent",
        record: false,
      } as unknown as Arguments);
      expect(exit).not.toHaveBeenCalled();
      expect(promptConfirmMock).not.toHaveBeenCalled();
      expect(fs.existsSync(configFile)).toBe(true);
      expect(fs.existsSync(keyFile)).toBe(true);
    } finally {
      exit.mockRestore();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("handler: an accepted webrtc invitation writes role: acceptor into the config", async () => {
    // What reaches disk is what the later `psilink exchange` reads, so assert the
    // written file rather than the in-memory connection: the field has to survive
    // the spec's snake_case serialization and parse back off the schema. Given no
    // input file this acceptance writes that configuration and stops, which is the
    // path that has a file to assert.
    const { dir, configFile, keyFile } = offlineAcceptFixture();
    const exit = vi
      .spyOn(process, "exit")
      .mockImplementation((() => undefined) as never);
    try {
      const encoded = await encodeInvitation(
        sampleToken(new Date(Date.now() + 3_600_000).toISOString(), {
          channel: "webrtc",
          host: "peer.example.org",
          path: "/psi",
        }),
      );
      await acceptHandler({
        _: [],
        $0: "psilink",
        identity: "Agency B",
        args: [encoded],
        "consent-to-terms": true,
        "config-file": configFile,
        "key-file": keyFile,
        "log-level": "silent",
        record: false,
      } as unknown as Arguments);
      expect(exit).not.toHaveBeenCalled();
      const raw = fs.readFileSync(configFile, "utf8");
      const parsed = parseExchangeSpec(YAML.parse(raw));
      expect(parsed.connection.channel).toBe("webrtc");
      if (parsed.connection.channel !== "webrtc")
        throw new Error("expected webrtc");
      expect(parsed.connection.role).toBe("acceptor");
      expect(raw).toContain("role: acceptor");
    } finally {
      exit.mockRestore();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("handler: a no-input webrtc acceptance points the operator at psilink exchange, not a second accept", async () => {
    // A second `psilink accept` on the key file this run just wrote would hit
    // assertNoProvisionConflicts's unconditional key-conflict gate in
    // validateAccept and refuse, so the guidance must name the command that
    // actually works -- matching docs/CLI.md's "No INPUT_FILE" guidance.
    const { dir, configFile, keyFile } = offlineAcceptFixture();
    const acceptLog = getLogger("accept");
    const priorLevel = acceptLog.getLevel();
    acceptLog.setLevel("info", false);
    const exit = vi
      .spyOn(process, "exit")
      .mockImplementation((() => undefined) as never);
    const stdio = captureStdio();
    try {
      const encoded = await encodeInvitation(
        sampleToken(new Date(Date.now() + 3_600_000).toISOString(), {
          channel: "webrtc",
          host: "peer.example.org",
          path: "/psi",
        }),
      );
      await acceptHandler({
        _: [],
        $0: "psilink",
        identity: "Agency B",
        args: [encoded],
        "consent-to-terms": true,
        "config-file": configFile,
        "key-file": keyFile,
        "log-level": "info",
        record: false,
      } as unknown as Arguments);
      expect(exit).not.toHaveBeenCalled();
      const stderr = stdio.stderrWrites.join("");
      expect(stderr).toContain(
        "Run 'psilink exchange' with your input file to conduct the exchange.",
      );
      expect(stderr).not.toContain("accept' to accept and run it in one");
    } finally {
      stdio.restore();
      exit.mockRestore();
      acceptLog.setLevel(priorLevel, false);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("handler: a webrtc acceptance given an input file accepts and runs the exchange", async () => {
    // The one-command acceptance: the same bootstrap the URL-driven mode reaches,
    // handed the invitation's own coordination server, this party's end of the
    // rendezvous, the token's secret, and the acceptance's two consent records --
    // so the configuration, key file, record, and result are the ones a
    // two-command acceptance would have written.
    const { dir, input, configFile, keyFile } = offlineAcceptFixture();
    const runOnlineBootstrapMock = vi.mocked(runOnlineBootstrap);
    runOnlineBootstrapMock.mockResolvedValue({ configWriteError: undefined });
    const exit = vi
      .spyOn(process, "exit")
      .mockImplementation((() => undefined) as never);
    const output = path.join(dir, "results.csv");
    try {
      const token = sampleToken(FUTURE(), {
        channel: "webrtc",
        host: "peer.example.org",
        path: "/psi",
      });
      const encoded = await encodeInvitation({
        ...token,
        disclosedPayloadColumns: ["diagnosis"],
      });
      await acceptHandler({
        _: [],
        $0: "psilink",
        identity: "Agency B",
        args: [encoded, input, output],
        "consent-to-terms": true,
        "config-file": configFile,
        "key-file": keyFile,
        "log-level": "silent",
        record: false,
      } as unknown as Arguments);
      expect(exit).not.toHaveBeenCalled();
      expect(runOnlineBootstrapMock).toHaveBeenCalledTimes(1);
      const passed = runOnlineBootstrapMock.mock.calls[0][0];
      expect(passed.connection).toMatchObject({
        channel: "webrtc",
        role: "acceptor",
        server: { host: "peer.example.org", path: "/psi" },
      });
      expect(passed.sharedSecret).toBe(token.sharedSecret);
      expect(passed.configPath).toBe(configFile);
      expect(passed.keyPath).toBe(keyFile);
      expect(passed.output).toBe(output);
      // The acceptance's own records ride the same write the URL-driven mode makes.
      expect(passed.receivedPayloadLockIn).toEqual({
        consentedColumns: ["diagnosis"],
      });
      expect(passed.expectedPartnerDeduplicate).toBe(
        token.linkageTerms.deduplicate,
      );
      expect(passed.reuseExistingConfig).toBe(false);
      // The acceptor observes nothing it must crystallize: its received set is the
      // one the invitation declared, which it already has.
      expect(passed.persistObservedReceivedPayload).toBeUndefined();
    } finally {
      exit.mockRestore();
      runOnlineBootstrapMock.mockReset();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("handler: the consent gate stands on the one-command path", async () => {
    // Unchanged by the run: the terms are displayed and the prompt asked before
    // anything is written or dialed, and a decline leaves both files unwritten and
    // opens no connection.
    const { dir, input, configFile, keyFile } = offlineAcceptFixture();
    const runOnlineBootstrapMock = vi.mocked(runOnlineBootstrap);
    runOnlineBootstrapMock.mockResolvedValue({ configWriteError: undefined });
    promptConfirmMock.mockResolvedValue(false);
    const stdio = captureStdio();
    const exit = vi
      .spyOn(process, "exit")
      .mockImplementation((() => undefined) as never);
    try {
      const encoded = await encodeInvitation(
        sampleToken(FUTURE(), {
          channel: "webrtc",
          host: "peer.example.org",
          path: "/psi",
        }),
      );
      await acceptHandler({
        _: [],
        $0: "psilink",
        identity: "Agency B",
        args: [encoded, input],
        "config-file": configFile,
        "key-file": keyFile,
        "log-level": "silent",
        record: false,
      } as unknown as Arguments);
      expect(exit).not.toHaveBeenCalled();
      expect(promptConfirmMock).toHaveBeenCalledTimes(1);
      expect(runOnlineBootstrapMock).not.toHaveBeenCalled();
      expect(fs.existsSync(configFile)).toBe(false);
      expect(fs.existsSync(keyFile)).toBe(false);
    } finally {
      stdio.restore();
      exit.mockRestore();
      runOnlineBootstrapMock.mockReset();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("handler: an accepted sftp invitation writes no role", async () => {
    // The complement of the webrtc case: `role` belongs to the WebRTC channel
    // alone, so a file-sync acceptance's connection block has none.
    const { dir, input, configFile, keyFile } = offlineAcceptFixture();
    const exit = vi
      .spyOn(process, "exit")
      .mockImplementation((() => undefined) as never);
    try {
      const encoded = await encodeInvitation(
        sampleToken(new Date(Date.now() + 3_600_000).toISOString(), {
          channel: "sftp",
          host: "sftp.example.org",
          path: "/exchange",
        }),
      );
      await acceptHandler({
        _: [],
        $0: "psilink",
        identity: "Agency B",
        args: [encoded, input],
        "consent-to-terms": true,
        "config-file": configFile,
        "key-file": keyFile,
        "log-level": "silent",
        record: false,
      } as unknown as Arguments);
      expect(exit).not.toHaveBeenCalled();
      const raw = fs.readFileSync(configFile, "utf8");
      // Read the connection block itself: `metadata` has a `role` of its own
      // (the column's linkage/payload role), so a whole-file search would confuse
      // the two.
      const written = YAML.parse(raw) as {
        connection: Record<string, unknown>;
      };
      expect(written.connection["channel"]).toBe("sftp");
      expect(Object.keys(written.connection)).not.toContain("role");
    } finally {
      exit.mockRestore();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("handler: a declared inviterRetainsFiles does not reach the acceptor's own connection options", async () => {
    // FILE_SYNC.md states this boundary as critical: a declared flag on the
    // invitation stays disclosure-only, and an accept path that reads it into the
    // acceptor's own configuration -- even to pre-fill it -- has crossed from
    // disclosure into adaptation. Pin it on a non-split sftp endpoint (a single
    // `path`, no inbound/outbound pair), so the endpoint-shape seed -- which does
    // legitimately write the retain trio, derived from the endpoint's SHAPE rather
    // than from the declared flag -- never fires and cannot confound the assertion.
    const endpoint: ConnectionEndpoint = {
      channel: "sftp",
      host: "sftp.example.org",
      path: "/exchange",
    };
    const base = sampleToken(
      new Date(Date.now() + 3_600_000).toISOString(),
      endpoint,
    );

    async function acceptAndReadConnection(
      token: InvitationToken,
    ): Promise<Record<string, unknown>> {
      const { dir, input, configFile, keyFile } = offlineAcceptFixture();
      const exit = vi
        .spyOn(process, "exit")
        .mockImplementation((() => undefined) as never);
      try {
        const encoded = await encodeInvitation(token);
        await acceptHandler({
          _: [],
          $0: "psilink",
          identity: "Agency B",
          args: [encoded, input],
          "consent-to-terms": true,
          "config-file": configFile,
          "key-file": keyFile,
          "log-level": "silent",
          record: false,
        } as unknown as Arguments);
        expect(exit).not.toHaveBeenCalled();
        const raw = fs.readFileSync(configFile, "utf8");
        const written = YAML.parse(raw) as {
          connection: Record<string, unknown>;
        };
        return written.connection;
      } finally {
        exit.mockRestore();
        fs.rmSync(dir, { recursive: true, force: true });
      }
    }

    const declaring = await acceptAndReadConnection({
      ...base,
      inviterRetainsFiles: true,
    });
    const silent = await acceptAndReadConnection(base);

    expect(Object.keys(declaring)).not.toContain("options");
    expect(declaring).toEqual(silent);
  });

  test("handler: without --consent-to-terms the prompt runs and a decline writes no files", async () => {
    // The unchanged default: the prompt runs, and a "no" (here the mocked decline,
    // which an EOF/non-TTY stdin also produces) leaves both files unwritten.
    const { dir, input, configFile, keyFile } = offlineAcceptFixture();
    // afterEach reset the mock to a clean slate; set the decline impl this test needs.
    promptConfirmMock.mockResolvedValue(false);
    // A prompting run at a level that drops info shows the terms at the prompt
    // regardless (the surface tests below measure that); capture stdio so they land
    // here rather than in the suite's own output.
    const stdio = captureStdio();
    const exit = vi
      .spyOn(process, "exit")
      .mockImplementation((() => undefined) as never);
    try {
      const encoded = await encodeInvitation(
        sampleToken(new Date(Date.now() + 3_600_000).toISOString()),
      );
      await acceptHandler({
        _: [],
        $0: "psilink",
        identity: "Agency B",
        args: [encoded, input],
        "config-file": configFile,
        "key-file": keyFile,
        "log-level": "silent",
        record: false,
      } as unknown as Arguments);
      expect(exit).not.toHaveBeenCalled();
      expect(promptConfirmMock).toHaveBeenCalledTimes(1);
      expect(fs.existsSync(configFile)).toBe(false);
      expect(fs.existsSync(keyFile)).toBe(false);
    } finally {
      stdio.restore();
      exit.mockRestore();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("handler: a config appearing during the prompt is refused, not overwritten", async () => {
    // The acceptance reads the configuration path once, before the terms are
    // displayed, so a file that appears while the operator is answering the y/N
    // was never reconciled against this invitation. The write refuses rather than
    // clobbering it: exit 64 naming the path, the planted bytes untouched, and no
    // key file left beside a configuration this run never agreed with.
    const { dir, input, configFile, keyFile } = offlineAcceptFixture();
    const planted = "# authored while the prompt was open\n";
    promptConfirmMock.mockImplementation(async () => {
      fs.writeFileSync(configFile, planted);
      return true;
    });
    const exit = vi
      .spyOn(process, "exit")
      .mockImplementation((() => undefined) as never);
    const { stderrWrites, restore } = captureStdio();
    try {
      const encoded = await encodeInvitation(sampleToken(FUTURE()));
      await acceptHandler({
        _: [],
        $0: "psilink",
        identity: "Agency B",
        args: [encoded, input],
        "config-file": configFile,
        "key-file": keyFile,
        "log-level": "error",
        record: false,
      } as unknown as Arguments);
      restore();
      expect(promptConfirmMock).toHaveBeenCalledTimes(1);
      expect(exit).toHaveBeenCalledWith(64);
      expect(stderrWrites.join("")).toContain("refusing to overwrite");
      expect(stderrWrites.join("")).toContain(configFile);
      expect(fs.readFileSync(configFile, "utf8")).toBe(planted);
      expect(fs.existsSync(keyFile)).toBe(false);
    } finally {
      restore();
      exit.mockRestore();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

// --- handler: the consent surface reaches wherever the prompt asks ------------

const SURFACE_HEADING = "Invitation details:";

// The first line the handler writes after the consent surface, one per path
// through the consent decision: the bypass note under --consent-to-terms, the
// decline note when the prompt answers no. What lies between the heading and
// whichever of these follows is the surface itself.
const POST_SURFACE_PREFIXES = [
  "--consent-to-terms given:",
  "invitation declined",
];

/**
 * Everything the run wrote to stderr, one entry per line, with the
 * `[ISO] [LEVEL] [context]` prefix stripped -- so a line the log put there and a
 * line written straight to the prompt's sink compare as the same line.
 */
function stderrLines(writes: ReadonlyArray<string>): Array<string> {
  const lines = writes.join("").split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines.map((line) =>
    line.replace(/^\[[^\]]*\] \[[A-Z]+\] \[[^\]]*\] /, ""),
  );
}

/**
 * The consent surface as stderr received it: the run of lines from the display's
 * heading to the first line the handler writes after it. Empty when the surface
 * never reached stderr at all.
 */
function surfaceOnStderr(writes: ReadonlyArray<string>): Array<string> {
  const lines = stderrLines(writes);
  const start = lines.indexOf(SURFACE_HEADING);
  if (start < 0) return [];
  const rest = lines.slice(start);
  const end = rest.findIndex(
    (line, index) =>
      index > 0 && POST_SURFACE_PREFIXES.some((p) => line.startsWith(p)),
  );
  return end < 0 ? rest : rest.slice(0, end);
}

/**
 * The consent surface the handler renders for `encoded` over the offline fixture,
 * produced by displayInvitation itself so an assertion compares the operator's
 * terminal against the whole surface rather than a few lines chosen for the test.
 * The fixture CSV discloses no payload columns -- pinned here, since a fixture
 * that started disclosing some would otherwise silently change what the handler
 * renders and leave every comparison below trivially true.
 */
async function expectedConsentSurface(
  encoded: string,
  promptFollows = true,
): Promise<Array<string>> {
  const lines: Array<string> = [];
  displayInvitation({
    token: await decodeAndValidateInvitation(encoded),
    ownOutboundSend: [],
    emit: (line) => lines.push(line),
    promptFollows,
  });
  expect(lines).toContain(
    `  ${OUTBOUND_SEND_LABEL}: (none) -- only matched records`,
  );
  expect(lines.length).toBeGreaterThan(20);
  return lines;
}

/**
 * Run the offline accept handler over `fixture` with `flags` folded into its
 * argv, capturing both standard streams -- so a test can assert what the terminal
 * received, and the mirrored surface never lands in the suite's own output.
 *
 * `onPrompt` answers the confirmation prompt and is handed everything stderr has
 * received at the instant it is called -- both routes to the operator in one
 * ordered transcript, since the log's own sink and the prompt's own writes land on
 * the same descriptor. That instant is the only place the "nothing intervenes
 * between the terms and the question" property can be read: by the time the
 * handler returns, its own post-decision lines have been written.
 */
async function runOfflineAcceptCapturingStdio(params: {
  encoded: string;
  fixture: ReturnType<typeof offlineAcceptFixture>;
  /**
   * The positionals after the invitation, defaulting to the fixture's input CSV.
   * An empty array is the acceptance given no input file, which writes a
   * configuration and runs nothing.
   */
  positionals?: Array<string>;
  flags?: Record<string, unknown>;
  onPrompt?: (stderrWrites: ReadonlyArray<string>) => boolean;
}): Promise<{ stderrWrites: Array<string>; stdoutWrites: Array<string> }> {
  const { encoded, fixture, positionals, flags, onPrompt } = params;
  // A real invocation creates getLogger("accept") after applying --log-level, so
  // the command's logger has the level the flag names. This suite runs many
  // invocations in one process, where that logger already exists and loglevel's
  // setDefaultLevel does not reach an existing named logger (driven against
  // loglevel 1.9.2: an existing logger keeps the level it was created with), so
  // the flag is applied to it here too and restored afterwards.
  const acceptLog = getLogger("accept");
  const priorLevel = acceptLog.getLevel();
  acceptLog.setLevel(
    ((flags?.["log-level"] as string | undefined) ??
      "info") as logLibrary.LogLevelDesc,
    false,
  );
  const exit = vi
    .spyOn(process, "exit")
    .mockImplementation((() => undefined) as never);
  const stdio = captureStdio();
  if (onPrompt !== undefined)
    promptConfirmMock.mockImplementation(() =>
      Promise.resolve(onPrompt(stdio.stderrWrites)),
    );
  try {
    await acceptHandler({
      _: [],
      $0: "psilink",
      identity: "Agency B",
      args: [encoded, ...(positionals ?? [fixture.input])],
      "config-file": fixture.configFile,
      "key-file": fixture.keyFile,
      record: false,
      ...flags,
    } as unknown as Arguments);
    expect(exit).not.toHaveBeenCalled();
    return {
      stderrWrites: [...stdio.stderrWrites],
      stdoutWrites: [...stdio.stdoutWrites],
    };
  } finally {
    stdio.restore();
    exit.mockRestore();
    acceptLog.setLevel(priorLevel, false);
  }
}

/** The line a declined confirmation leaves the operator with. */
const DECLINE_LINE = "invitation declined; no files were written";

describe("handler: the consent surface reaches wherever the prompt asks", () => {
  test("handler: nothing reaches the operator between the terms and the question", async () => {
    // The repeated decision block is the last thing printed, so the y/N is answered
    // against those facts rather than the tail of the key list. A line added between
    // displayInvitation and promptConfirm would push the block off a short terminal
    // with nothing turning red -- so the property is a check rather than a comment.
    //
    // It reads what the OPERATOR saw, not what one route emitted: on every routing
    // that asks, the surface reaches them through the prompt's own stream on
    // stderr, and under --log-file the log's copy lands in the file rather than
    // beside it. A check watching only the logger would pass while a direct
    // prompt-stream write scrolled the block away. Both routings are driven here,
    // and in each the transcript is snapshotted at the instant the prompt is called.
    const fixture = offlineAcceptFixture();
    const logFile = path.join(fixture.dir, "accept.log");
    try {
      const encoded = await encodeInvitation(sampleToken(FUTURE()));
      const surface = await expectedConsentSurface(encoded);
      // The repeated block with its heading: everything from the heading to the end
      // of the display. Taken from the renderer rather than restated, so the check
      // measures the block's whole length and not a line or two chosen for it.
      const repeated = surface.slice(surface.indexOf(REPEAT_HEADING));
      expect(repeated.length).toBeGreaterThan(1);
      for (const flags of [{}, { "log-file": logFile }]) {
        let atPrompt: Array<string> | undefined;
        await runOfflineAcceptCapturingStdio({
          encoded,
          fixture,
          flags,
          onPrompt: (stderrWrites) => {
            atPrompt = stderrLines([...stderrWrites]);
            return false;
          },
        });
        expect(promptConfirmMock).toHaveBeenCalledTimes(1);
        expect(atPrompt).toBeDefined();
        // The last thing on the operator's terminal when the question arrives is the
        // repeated block, entire and in order. Anything written in that window --
        // by either route -- lands after it and fails this.
        expect(atPrompt!.slice(-repeated.length)).toEqual(repeated);
        promptConfirmMock.mockReset();
      }
    } finally {
      fs.rmSync(fixture.dir, { recursive: true, force: true });
    }
  });

  test("the rendered server has the display brand, not a bare string", () => {
    // Both sinks that name the server interpolate the value into a first-party
    // line, so neither demands a `Displayable` and nothing but this annotation
    // holds the brand on the return type. It is the check, not documentation:
    // widening that type back to `string` fails `tsc -p apps/cli/tsconfig.test.json`,
    // which is a CI check because that config includes the test tree.
    const named: Displayable = renderDialedBroker({
      host: "peer.example.org",
      port: 443,
    });
    // And the brand adds no bytes: the line is what the plain template produced.
    expect(named).toBe("peer.example.org:443");
  });

  test("handler: the one-command path names the coordination server it will dial before it asks", async () => {
    // On this path the confirmation is the last checkpoint before data moves, and
    // the locator is one the operator never typed: the surface states that this
    // acceptance runs the exchange and names the server it resolves to dial, and
    // the question has that server too, since the terms between the two run
    // past a screen.
    const fixture = offlineAcceptFixture();
    const runOnlineBootstrapMock = vi.mocked(runOnlineBootstrap);
    runOnlineBootstrapMock.mockResolvedValue({ configWriteError: undefined });
    try {
      const encoded = await encodeInvitation(
        sampleToken(FUTURE(), WEBRTC_ENDPOINT),
      );
      let atPrompt: Array<string> | undefined;
      await runOfflineAcceptCapturingStdio({
        encoded,
        fixture,
        onPrompt: (stderrWrites) => {
          atPrompt = stderrLines([...stderrWrites]);
          return false;
        },
      });
      expect(atPrompt).toBeDefined();
      const beforeThePrompt = atPrompt!.join("\n");
      // The endpoint has no port, so the line resolves the default the dial
      // would use rather than leaving it to be inferred from a scheme it does not
      // print.
      expect(beforeThePrompt).toContain(
        "This acceptance runs the exchange itself, through the coordination " +
          "server this invitation names: peer.example.org:443",
      );
      expect(beforeThePrompt).toContain(
        "Confirming connects to that server immediately and runs the exchange " +
          "from your input file, transmitting your linkage data on the terms " +
          "below",
      );
      expect(promptConfirmMock).toHaveBeenCalledWith(
        "Accept this invitation and run the exchange now, through " +
          "peer.example.org:443?",
      );
      // The gate still holds what it always did: declining dials nothing and
      // writes nothing.
      expect(runOnlineBootstrapMock).not.toHaveBeenCalled();
      expect(fs.existsSync(fixture.configFile)).toBe(false);
      expect(fs.existsSync(fixture.keyFile)).toBe(false);
    } finally {
      runOnlineBootstrapMock.mockReset();
      fs.rmSync(fixture.dir, { recursive: true, force: true });
    }
  });

  test("handler: the server named on both surfaces keeps its port at any host length", async () => {
    // The port is the reason this line has more than the plain authority, and
    // a host is partner-supplied at up to the length the whole display budget
    // allows -- so escaping a joined "host:port" would cut away exactly the value
    // the line exists to add. Driven at the longest host an invitation can hold,
    // on both surfaces that name the server: the endpoint schema's maximum is
    // inclusive, and it is exactly the per-value display cap, so an admissible
    // host of that length is the equality case of the escape's own comparison.
    // One character short of it leaves that case undriven.
    const fixture = offlineAcceptFixture();
    const runOnlineBootstrapMock = vi.mocked(runOnlineBootstrap);
    runOnlineBootstrapMock.mockResolvedValue({ configWriteError: undefined });
    const host = `${"h".repeat(MAX_ENDPOINT_HOST_LENGTH - 4)}.org`;
    expect(host).toHaveLength(MAX_ENDPOINT_HOST_LENGTH);
    try {
      const encoded = await encodeInvitation(
        sampleToken(FUTURE(), { ...WEBRTC_ENDPOINT, host }),
      );
      let atPrompt: Array<string> | undefined;
      await runOfflineAcceptCapturingStdio({
        encoded,
        fixture,
        onPrompt: (stderrWrites) => {
          atPrompt = stderrLines([...stderrWrites]);
          return false;
        },
      });
      expect(atPrompt).toBeDefined();
      const beforeThePrompt = atPrompt!.join("\n");
      expect(beforeThePrompt).toContain(
        `server this invitation names: ${host}:443`,
      );
      expect(beforeThePrompt).not.toContain(DISPLAY_TRUNCATION_MARKER);
      expect(promptConfirmMock).toHaveBeenCalledWith(
        `Accept this invitation and run the exchange now, through ${host}:443?`,
      );
    } finally {
      runOnlineBootstrapMock.mockReset();
      fs.rmSync(fixture.dir, { recursive: true, force: true });
    }
  });

  test("handler: the unattended one-command path states the run it is about to make", async () => {
    // Nothing asks under --consent-to-terms, so the statement is made in the tense
    // of a consent already recorded: the run and the server it reaches are still
    // named, in the unattended run's own record, and the wording that invites an
    // answer never reaches a run that takes none.
    const fixture = offlineAcceptFixture();
    const logFile = path.join(fixture.dir, "accept.log");
    const runOnlineBootstrapMock = vi.mocked(runOnlineBootstrap);
    runOnlineBootstrapMock.mockResolvedValue({ configWriteError: undefined });
    try {
      const encoded = await encodeInvitation(
        sampleToken(FUTURE(), WEBRTC_ENDPOINT),
      );
      await runOfflineAcceptCapturingStdio({
        encoded,
        fixture,
        flags: { "consent-to-terms": true, "log-file": logFile },
      });
      expect(promptConfirmMock).not.toHaveBeenCalled();
      expect(runOnlineBootstrapMock).toHaveBeenCalledTimes(1);
      const logged = fs.readFileSync(logFile, "utf8");
      expect(logged).toContain(
        "This acceptance runs the exchange itself, through the coordination " +
          "server this invitation names: peer.example.org:443",
      );
      expect(logged).toContain(
        "--consent-to-terms recorded that consent in advance",
      );
      expect(logged).not.toContain("Confirming connects to that server");
    } finally {
      runOnlineBootstrapMock.mockReset();
      fs.rmSync(fixture.dir, { recursive: true, force: true });
    }
  });

  test("handler: an acceptance that runs no exchange names no server and states no run", async () => {
    // The two shapes that keep the two-command form -- no input file to exchange,
    // and an invitation naming no webrtc coordination server -- dial nothing, so
    // neither surface has a locator or the run statement, and each asks the
    // question about writing files that it always asked.
    const fixture = offlineAcceptFixture();
    try {
      for (const { encoded, positionals } of [
        {
          encoded: await encodeInvitation(
            sampleToken(FUTURE(), WEBRTC_ENDPOINT),
          ),
          positionals: [] as Array<string>,
        },
        {
          encoded: await encodeInvitation(sampleToken(FUTURE())),
          positionals: undefined,
        },
      ]) {
        let atPrompt: Array<string> | undefined;
        await runOfflineAcceptCapturingStdio({
          encoded,
          fixture,
          positionals,
          onPrompt: (stderrWrites) => {
            atPrompt = stderrLines([...stderrWrites]);
            return false;
          },
        });
        expect(atPrompt).toBeDefined();
        const beforeThePrompt = atPrompt!.join("\n");
        expect(beforeThePrompt).not.toContain("peer.example.org");
        expect(beforeThePrompt).not.toContain("runs the exchange itself");
        expect(promptConfirmMock).toHaveBeenCalledWith(
          "Accept this invitation and write configuration?",
        );
        promptConfirmMock.mockReset();
      }
    } finally {
      fs.rmSync(fixture.dir, { recursive: true, force: true });
    }
  });

  test("handler: --log-file records the terms and still shows them where the prompt asks", async () => {
    // The file sink replaces stderr outright, so the log's copy of the terms lands
    // nowhere near the terminal the question is asked on. Both destinations receive
    // them: the file for the operator's record, the terminal for the decision.
    const fixture = offlineAcceptFixture();
    const logFile = path.join(fixture.dir, "accept.log");
    promptConfirmMock.mockResolvedValue(false);
    try {
      const encoded = await encodeInvitation(sampleToken(FUTURE()));
      const expected = await expectedConsentSurface(encoded);
      const { stderrWrites, stdoutWrites } =
        await runOfflineAcceptCapturingStdio({
          encoded,
          fixture,
          flags: { "log-file": logFile },
        });
      expect(promptConfirmMock).toHaveBeenCalledTimes(1);
      // The terminal the question is asked on received the whole surface, in order,
      // and plain: the prefix belongs to the log's record of it, not to text sitting
      // beside a prompt.
      expect(surfaceOnStderr(stderrWrites)).toEqual(expected);
      expect(stderrWrites.join("")).not.toContain("[INFO]");
      // stdout stays reserved for result data, the reason the prompt is on stderr.
      expect(stdoutWrites.join("")).toBe("");
      // The operator's chosen routing is untouched: the file still holds every line.
      const logged = fs.readFileSync(logFile, "utf8");
      for (const line of expected)
        expect(logged).toContain(`[INFO] [accept] ${line}\n`);
    } finally {
      fs.rmSync(fixture.dir, { recursive: true, force: true });
    }
  });

  test.each(["warn", "error", "silent"])(
    "handler: --log-level %s still shows the terms where the prompt asks",
    async (level) => {
      // Each level that drops info drops the surface from the log; the prompt asks
      // either way, so the surface reaches the prompt's own sink either way.
      const fixture = offlineAcceptFixture();
      promptConfirmMock.mockResolvedValue(false);
      try {
        const encoded = await encodeInvitation(sampleToken(FUTURE()));
        const expected = await expectedConsentSurface(encoded);
        const { stderrWrites, stdoutWrites } =
          await runOfflineAcceptCapturingStdio({
            encoded,
            fixture,
            flags: { "log-level": level },
          });
        expect(promptConfirmMock).toHaveBeenCalledTimes(1);
        expect(surfaceOnStderr(stderrWrites)).toEqual(expected);
        // The level still governs the log itself: no info line was emitted.
        expect(stderrWrites.join("")).not.toContain("[INFO]");
        expect(stdoutWrites.join("")).toBe("");
      } finally {
        fs.rmSync(fixture.dir, { recursive: true, force: true });
      }
    },
  );

  test("handler: the terms and the decline read identically at every level", async () => {
    // What the operator reads to answer the question cannot depend on a diagnostic
    // setting, so the comparison is of BYTES rather than of lines with the prefix
    // taken off: the run from the heading to the decline is one string, the same
    // under the default level, a level that drops it from the log, and one that
    // turns the log up -- which holds only while no copy of it has the log's
    // own prefix at any of them.
    const fixture = offlineAcceptFixture();
    promptConfirmMock.mockResolvedValue(false);
    try {
      const encoded = await encodeInvitation(sampleToken(FUTURE()));
      const expected = await expectedConsentSurface(encoded);
      const shown: Array<string> = [];
      for (const flags of [
        {},
        { "log-level": "silent" },
        { "log-level": "debug" },
      ]) {
        const { stderrWrites, stdoutWrites } =
          await runOfflineAcceptCapturingStdio({ encoded, fixture, flags });
        expect(promptConfirmMock).toHaveBeenCalledTimes(1);
        promptConfirmMock.mockClear();
        expect(stdoutWrites.join("")).toBe("");
        const stderr = stderrWrites.join("");
        const start = stderr.indexOf(SURFACE_HEADING);
        expect(start).toBeGreaterThanOrEqual(0);
        shown.push(stderr.slice(start));
      }
      for (const level of shown)
        expect(level).toBe(`${expected.join("\n")}\n${DECLINE_LINE}\n`);
      // The level that drops every log line is the one the outcome has to survive:
      // there it is all that tells this run from an acceptance, which writes files
      // and runs rather than saying anything here.
      expect(shown[1]).toContain(`\n${DECLINE_LINE}\n`);
    } finally {
      fs.rmSync(fixture.dir, { recursive: true, force: true });
    }
  });

  test("handler: the default prompting path prints each line of the terms exactly once", async () => {
    // The prompt's copy and the log's own would land on the same terminal here, so
    // writing both would print the whole multi-screen outline twice. Every line
    // appears exactly as many times as the renderer emitted it -- twice for the
    // decision facts it repeats, once for everything else.
    const fixture = offlineAcceptFixture();
    promptConfirmMock.mockResolvedValue(false);
    try {
      const encoded = await encodeInvitation(sampleToken(FUTURE()));
      const expected = await expectedConsentSurface(encoded);
      const { stderrWrites, stdoutWrites } =
        await runOfflineAcceptCapturingStdio({
          encoded,
          fixture,
        });
      expect(stdoutWrites.join("")).toBe("");
      const lines = stderrLines(stderrWrites);
      for (const line of new Set(expected))
        expect(lines.filter((seen) => seen === line)).toHaveLength(
          expected.filter((rendered) => rendered === line).length,
        );
      expect(surfaceOnStderr(stderrWrites)).toEqual(expected);
      // The one copy is the prompt's, so the surface reaches the operator plain:
      // the prefix belongs to a diagnostic record, not to the terms a question is
      // asked about.
      expect(stderrWrites.join("")).not.toContain("[INFO]");
    } finally {
      fs.rmSync(fixture.dir, { recursive: true, force: true });
    }
  });
});

// --- handler: the prompt's copy has the redaction on its own -------------
// Nothing between summarizeInvitation's composition and the operator's terminal
// redacts key material on this routing: the prompt's own stream runs no pass, and
// with no --log-file the log sink -- where core's prefixer would have been a
// second chance -- is never called. These drive hostile terms through the whole
// prompting path and hold the transcript to what that composition boundary owes.

/**
 * Private-key armor in the two forms the redaction rule distinguishes: a whole
 * block, and a BEGIN marker with no END, whose fail-closed rule takes everything
 * composed behind it. Each is one line, so either can stand as a declared name or
 * a CSV heading.
 */
const ARMOR_WHOLE =
  "-----BEGIN RSA PRIVATE KEY-----MIIEowIBAAKCAQEA-----END RSA PRIVATE KEY-----";
const ARMOR_DANGLING =
  "-----BEGIN OPENSSH PRIVATE KEY-----b3BlbnNzaC1rZXktdjEA";

/** The key bodies themselves: the bytes a leak puts on the operator's terminal. */
const ARMOR_BODIES = ["MIIEowIBAAKCAQEA", "b3BlbnNzaC1rZXktdjEA"];

// One planting per partner-declared value the consent surface renders, each
// holding a distinctive prefix so the assertion that it arrived reads the value
// rather than the label beside it.
const ARMORED_IDENTITY = `Inviter Org ${ARMOR_WHOLE}`;
const ARMORED_REFERENCE = `MOU-2026-0042 ${ARMOR_WHOLE}`;
const ARMORED_PURPOSE = `Program evaluation ${ARMOR_DANGLING}`;
const ARMORED_SEND_COLUMN = `sent_column ${ARMOR_WHOLE}`;
const ARMORED_KEY_NAME = `SSN + LN + DOB ${ARMOR_WHOLE}`;
const ARMORED_FIELD_NAME = `first_name ${ARMOR_DANGLING}`;
/** The column this party's own file discloses, and the one the partner requests. */
const ARMORED_COLUMN = `diagnosis ${ARMOR_DANGLING}`;

/**
 * The plantings the surface renders as text. Each must reach the transcript in
 * exactly its redacted form, so the check below is reading a fixture that arrived
 * rather than a surface that dropped it. {@link ARMORED_FIELD_NAME} is not among
 * them: a declared linkage field is rendered by the label of its semantic type
 * rather than by the name the partner gave it.
 */
const ARMORED_RENDERED = [
  ARMORED_IDENTITY,
  ARMORED_REFERENCE,
  ARMORED_PURPOSE,
  ARMORED_SEND_COLUMN,
  ARMORED_KEY_NAME,
  ARMORED_COLUMN,
];

/**
 * An invitation holding key material in the partner-declared values the
 * consent surface renders that this fixture plants (the rule-set citation names
 * and the transform names and parameters are left plain): the inviting party's
 * identity, the payload names declared in each direction, a linkage key's name,
 * a linkage field's name (with the keys citing it), and the legal agreement's
 * reference and purpose. The declared `receive` names the column {@link
 * armoredFixture} discloses, so the acceptance renders it in this party's own
 * outbound set too.
 */
function armoredToken(): InvitationToken {
  const base = sampleToken(FUTURE());
  const terms = base.linkageTerms;
  const renamed = (field: string) =>
    field === "first_name" ? ARMORED_FIELD_NAME : field;
  return {
    ...base,
    linkageTerms: {
      ...terms,
      identity: ARMORED_IDENTITY,
      legalAgreement: {
        reference: ARMORED_REFERENCE,
        purpose: ARMORED_PURPOSE,
        expirationDate: "2099-12-31",
      },
      linkageFields: terms.linkageFields.map((field) => ({
        ...field,
        name: renamed(field.name),
      })),
      linkageKeys: terms.linkageKeys.map((key, index) => ({
        ...key,
        ...(index === 0 ? { name: ARMORED_KEY_NAME } : {}),
        elements: key.elements.map((element) => ({
          ...element,
          field: renamed(element.field),
        })),
        ...(key.swap !== undefined
          ? {
              swap: [renamed(key.swap[0]), renamed(key.swap[1])] as [
                string,
                string,
              ],
            }
          : {}),
      })),
      payload: {
        send: [{ name: ARMORED_SEND_COLUMN }],
        receive: [{ name: ARMORED_COLUMN }],
      },
    },
  };
}

/** The offline fixture whose input file discloses {@link ARMORED_COLUMN}. */
function armoredFixture(): ReturnType<typeof offlineAcceptFixture> {
  const fixture = offlineAcceptFixture();
  fs.writeFileSync(
    fixture.input,
    `first_name,last_name,dob,ssn,${ARMORED_COLUMN}\n` +
      "Alice,Smith,1990-01-02,123456789,A\n",
  );
  return fixture;
}

describe("handler: the prompt's copy has the redaction on its own", () => {
  test("handler: hostile terms leave the sink-level pass nothing to do", async () => {
    // The invariant the prompting path rests on: every partner-declared value
    // is redacted where it is composed, so the pass the log sink would have applied
    // -- core's prefixer, over the whole composed line -- changes nothing on the
    // operator's transcript. A field composed with a plain escape instead fails
    // here rather than putting key material on a terminal.
    const fixture = armoredFixture();
    promptConfirmMock.mockResolvedValue(false);
    try {
      const encoded = await encodeInvitation(armoredToken());
      const { stderrWrites, stdoutWrites } =
        await runOfflineAcceptCapturingStdio({ encoded, fixture });
      expect(stdoutWrites.join("")).toBe("");
      const transcript = stderrWrites.join("");
      expect(transcript).toContain(SURFACE_HEADING);
      // No line has the log's prefix, so no sink-level pass ran over any of
      // this: a routing that sent the surface through the log as well would fail
      // here rather than leave the prefixer masking a composition site that
      // stopped redacting.
      expect(transcript).not.toMatch(/^\[[^\]]*\] \[[A-Z]+\] \[/m);
      for (const line of transcript.split("\n"))
        expect(redactPrivateKeyMaterial(line)).toBe(line);
      for (const body of ARMOR_BODIES) expect(transcript).not.toContain(body);
      expect(transcript).not.toContain("PRIVATE KEY");
      for (const planted of ARMORED_RENDERED)
        expect(transcript).toContain(redactPrivateKeyMaterial(planted));
    } finally {
      fs.rmSync(fixture.dir, { recursive: true, force: true });
    }
  });

  test("handler: an armored allowed-character class is refused at the decode", async () => {
    // The one rendered partner value the fixture above cannot plant: an
    // allowed-character class is validated as a regex character class, and armor's
    // run of dashes does not compile as one. So the surface never sees such a class
    // -- the refusal is the check, and it too reaches the operator redacted.
    const base = sampleToken(FUTURE());
    const crafted = await encodeRaw({
      ...base,
      linkageTerms: {
        ...base.linkageTerms,
        linkageFields: base.linkageTerms.linkageFields.map((field) =>
          field.type === "first_name"
            ? {
                ...field,
                constraints: {
                  ...field.constraints,
                  allowedCharacters: `A-Z ${ARMOR_DANGLING}`,
                },
              }
            : field,
        ),
      },
    });
    const err = await decodeAndValidateInvitation(crafted).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(UsageError);
    const message = (err as Error).message;
    expect(message).toContain("allowedCharacters");
    expect(redactPrivateKeyMaterial(message)).toBe(message);
  });

  test("handler: --consent-to-terms leaves the terms in the --log-file, not on the terminal", async () => {
    // Nothing asks on the unattended path, so nothing is mirrored: the surface is
    // ordinary diagnostic output following the routing the operator chose.
    const fixture = offlineAcceptFixture();
    const logFile = path.join(fixture.dir, "accept.log");
    try {
      const encoded = await encodeInvitation(sampleToken(FUTURE()));
      // Rendered for the unattended path, which is the one the handler takes here:
      // no prompt follows, so the repeated decision block sits under a heading that
      // repeats rather than asks.
      const expected = await expectedConsentSurface(encoded, false);
      const { stderrWrites, stdoutWrites } =
        await runOfflineAcceptCapturingStdio({
          encoded,
          fixture,
          flags: { "consent-to-terms": true, "log-file": logFile },
        });
      expect(promptConfirmMock).not.toHaveBeenCalled();
      expect(surfaceOnStderr(stderrWrites)).toEqual([]);
      expect(stdoutWrites.join("")).toBe("");
      const logged = fs.readFileSync(logFile, "utf8");
      for (const line of expected)
        expect(logged).toContain(`[INFO] [accept] ${line}\n`);
      // The framing the prompting path uses never reaches an unattended run, where
      // there is nothing to accept and nothing to answer.
      expect(logged).not.toContain(REPEAT_HEADING);
      expect(logged).toContain(
        `[INFO] [accept] ${REPEAT_HEADING_UNATTENDED}\n`,
      );
    } finally {
      fs.rmSync(fixture.dir, { recursive: true, force: true });
    }
  });

  test("handler: --consent-to-terms keeps --log-level silent silencing the terms", async () => {
    // The other half of the unattended path: a level that drops the surface still
    // drops it, on the terminal as well as in the log.
    const fixture = offlineAcceptFixture();
    try {
      const encoded = await encodeInvitation(sampleToken(FUTURE()));
      const { stderrWrites, stdoutWrites } =
        await runOfflineAcceptCapturingStdio({
          encoded,
          fixture,
          flags: { "consent-to-terms": true, "log-level": "silent" },
        });
      expect(promptConfirmMock).not.toHaveBeenCalled();
      expect(stderrWrites.join("")).toBe("");
      expect(stdoutWrites.join("")).toBe("");
      expect(fs.existsSync(fixture.configFile)).toBe(true);
    } finally {
      fs.rmSync(fixture.dir, { recursive: true, force: true });
    }
  });

  test("handler: hostile terms stay printable ASCII on the prompt's own sink", async () => {
    // The mirror is a second route from partner-controlled text to the operator's
    // terminal, so the escaping claim the renderer's tests make through the log sink
    // is measured on this route too. --log-level silent leaves the mirrored copy as
    // the only thing on stderr, so every line asserted here came through it.
    const fixture = offlineAcceptFixture();
    promptConfirmMock.mockResolvedValue(false);
    try {
      // Unlike the render-boundary walk, this route goes through the token's own
      // validation, so the hostile code points ride the fields a decoded token can
      // still hold: the key name takes the two control characters, since the terms'
      // free text is refused one at parse, and the identity takes the bidi
      // override, which is not a control character.
      const encoded = await encodeInvitation({
        ...sampleToken(FUTURE()),
        linkageTerms: {
          ...sampleTerms(`InviterOrg${RLO}`),
          linkageKeys: [
            { name: `ssn${BEL}${ESC}[31m`, elements: [{ field: "ssn" }] },
          ],
        },
      });
      const { stderrWrites, stdoutWrites } =
        await runOfflineAcceptCapturingStdio({
          encoded,
          fixture,
          flags: { "log-level": "silent" },
        });
      expect(stdoutWrites.join("")).toBe("");
      const lines = stderrLines(stderrWrites);
      // Non-vacuous: the terms reached the terminal, and each hostile code point
      // arrived in its escaped form rather than never arriving at all.
      expect(lines.length).toBeGreaterThan(20);
      for (const hostile of [ESC, RLO, BEL])
        expect(
          lines.filter((line) => line.includes(sanitizeForDisplay(hostile)))
            .length,
        ).toBeGreaterThan(0);
      expect(lines.filter((line) => !PRINTABLE_ASCII.test(line))).toEqual([]);
    } finally {
      fs.rmSync(fixture.dir, { recursive: true, force: true });
    }
  });
});

// --- handler: online accept threads the token commitment to the persistence layer

describe("handler: online accept threads the token commitment to the persistence layer", () => {
  test("handler: online accept forwards the token's disclosed set to runOnlineBootstrap", async () => {
    // The accept-side wiring: the online handler must pass
    // token.disclosedPayloadColumns to runOnlineBootstrap as the acceptance's
    // receivedPayloadLockIn, so the config records the consented received-column
    // commitment (runOnlineBootstrap's own tests cover the write). It is mocked here so
    // no connection is opened; --consent-to-terms skips the prompt.
    const { dir, input, configFile, keyFile } = offlineAcceptFixture();
    const runOnlineBootstrapMock = vi.mocked(runOnlineBootstrap);
    runOnlineBootstrapMock.mockResolvedValue({ configWriteError: undefined });
    const exit = vi
      .spyOn(process, "exit")
      .mockImplementation((() => undefined) as never);
    try {
      const encoded = await encodeInvitation({
        ...sampleToken(FUTURE()),
        disclosedPayloadColumns: ["diagnosis", "notes"],
      });
      await acceptHandler({
        _: [],
        $0: "psilink",
        identity: "Agency B",
        args: ["sftp://host/drop", encoded, input],
        "consent-to-terms": true,
        "config-file": configFile,
        "key-file": keyFile,
        "log-level": "silent",
        record: false,
      } as unknown as Arguments);
      expect(exit).not.toHaveBeenCalled();
      expect(runOnlineBootstrapMock).toHaveBeenCalledTimes(1);
      const passed = runOnlineBootstrapMock.mock.calls[0][0];
      expect(passed.receivedPayloadLockIn).toEqual({
        consentedColumns: ["diagnosis", "notes"],
      });
      // A fresh (non-reuse) config, so the commitment is actually written.
      expect(passed.reuseExistingConfig).toBe(false);
    } finally {
      exit.mockRestore();
      // Module-level mock: reset so no later test inherits this call/impl.
      runOnlineBootstrapMock.mockReset();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("handler: online accept-reuse forwards the commitment the kept config must be refreshed to", async () => {
    // A re-accept over a config that reconciles for reuse still passes this
    // acceptance's consented set to the persistence layer, which refreshes the kept
    // config's field in place -- the reuse branch must not be a no-op, or the next
    // recurring exchange would enforce the previous acceptance's set against an
    // honest partner. A subset-less invitation forwards the decision with no columns,
    // which removes the stale field rather than leaving it.
    const { dir, input, configFile, keyFile } = offlineAcceptFixture();
    const runOnlineBootstrapMock = vi.mocked(runOnlineBootstrap);
    runOnlineBootstrapMock.mockResolvedValue({ configWriteError: undefined });
    const exit = vi
      .spyOn(process, "exit")
      .mockImplementation((() => undefined) as never);
    try {
      // A config whose linkage terms and connection agree with the invitation and the
      // URL below, so reconciliation keeps it.
      writeExistingConfig(configFile, {
        connection: { channel: "filedrop", path: "/mnt/share" },
      });
      for (const disclosed of [["diagnosis", "notes"], undefined]) {
        runOnlineBootstrapMock.mockClear();
        const encoded = await encodeInvitation({
          ...sampleToken(FUTURE()),
          disclosedPayloadColumns: disclosed,
        });
        await acceptHandler({
          _: [],
          $0: "psilink",
          identity: "Agency B",
          args: ["file:///mnt/share", encoded, input],
          "consent-to-terms": true,
          "config-file": configFile,
          "key-file": keyFile,
          "log-level": "silent",
          record: false,
        } as unknown as Arguments);
        expect(exit).not.toHaveBeenCalled();
        expect(runOnlineBootstrapMock).toHaveBeenCalledTimes(1);
        const passed = runOnlineBootstrapMock.mock.calls[0][0];
        expect(passed.reuseExistingConfig).toBe(true);
        // Strict: the subset-less case must forward the DECISION with no columns,
        // which removes the field, not an absent decision, which leaves it standing.
        expect(passed.receivedPayloadLockIn).toStrictEqual({
          consentedColumns: disclosed,
        });
      }
    } finally {
      exit.mockRestore();
      runOnlineBootstrapMock.mockReset();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

// --- handler: offline accept-reuse refreshes the received-payload commitment -----

/**
 * Run the offline accept handler over a pre-existing config, with
 * --consent-to-terms so the confirmation prompt is skipped (its own tests cover
 * the prompt gate). The token holds `disclosed`, the disclosed subset the
 * operator consents to on this acceptance. Returns the config file's raw text and
 * the exit spy so the caller can assert the on-disk refresh.
 */
async function runOfflineAcceptReuse(params: {
  configFile: string;
  input?: string;
  disclosed: string[] | undefined;
  token?: InvitationToken;
}): Promise<string> {
  const exit = vi
    .spyOn(process, "exit")
    .mockImplementation((() => undefined) as never);
  try {
    const encoded = await encodeInvitation({
      ...(params.token ?? sampleToken(FUTURE())),
      disclosedPayloadColumns: params.disclosed,
    });
    await acceptHandler({
      _: [],
      $0: "psilink",
      identity: "Agency B",
      args: params.input !== undefined ? [encoded, params.input] : [encoded],
      "consent-to-terms": true,
      "config-file": params.configFile,
      "key-file": path.join(path.dirname(params.configFile), ".psilink.key"),
      "log-level": "silent",
      record: false,
    } as unknown as Arguments);
    expect(exit).not.toHaveBeenCalled();
    return fs.readFileSync(params.configFile, "utf8");
  } finally {
    exit.mockRestore();
  }
}

describe("handler: offline accept-reuse refreshes the received-payload commitment", () => {
  test("handler: offline accept-reuse refreshes a stale commitment, preserving operator content", async () => {
    // A reused config holding an OLD consented set is re-accepted over an invitation
    // whose disclosed subset changed. The surgical refresh overwrites the stale
    // value, preserving the operator's connection block, linkage terms, and a
    // hand-authored comment.
    const { dir, input, configFile } = offlineAcceptFixture();
    try {
      // A config whose linkage terms agree with the invitation's defaults (so it
      // reconciles for reuse), then a hand-authored comment and a stale commitment
      // appended so the surgical write has operator content to preserve.
      writeExistingConfig(configFile);
      fs.appendFileSync(
        configFile,
        "# operator-authored note\nexpected_payload_columns:\n  - old_col\n",
      );
      const raw = await runOfflineAcceptReuse({
        configFile,
        input,
        disclosed: ["diagnosis", "notes"],
      });
      // The operator's comment and connection block survive the surgical write.
      expect(raw).toContain("# operator-authored note");
      expect(raw).toContain("/mnt/share");
      expect(raw).not.toContain("old_col");
      const parsed = parseExchangeSpec(YAML.parse(raw));
      expect(parsed.expectedPayloadColumns).toEqual(["diagnosis", "notes"]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("handler: accept-reuse leaves the kept configuration's identity untouched", async () => {
    // The other half of the stored label winning: the acceptance runs under the
    // file's label and leaves the file as it found it. A flag that rewrote the
    // field here would rename the party for every later `psilink exchange`, out of
    // a run whose one intended effect is a new key file.
    const { dir, input, configFile } = offlineAcceptFixture();
    try {
      writeExistingConfig(configFile);
      const raw = await runOfflineAcceptReuse({
        configFile,
        input,
        disclosed: ["diagnosis"],
      });
      expect(parseExchangeSpec(YAML.parse(raw)).linkageTerms.identity).toBe(
        "Acceptor Org",
      );
      expect(raw).not.toContain("Agency B");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("handler: offline accept-reuse fixes the false-abort a stale commitment would have caused", async () => {
    // The end-to-end failure this task closes. Before the refresh the config holds
    // the partner's OLD disclosed set; the partner now discloses a new set, so a
    // recurring exchange's reconcileReceivedPayload would abort the honest exchange.
    // After the re-accept the config holds the NEW set, so the same reconcile passes;
    // asserting the stale set would have thrown proves the config actually changed
    // the outcome.
    const { dir, input, configFile } = offlineAcceptFixture();
    try {
      writeExistingConfig(configFile);
      // Seed the stale commitment the operator originally consented to.
      fs.appendFileSync(configFile, "expected_payload_columns:\n  - old_col\n");
      const staleSpec = parseExchangeSpec(
        YAML.parse(fs.readFileSync(configFile, "utf8")),
      );
      expect(staleSpec.expectedPayloadColumns).toEqual(["old_col"]);

      const raw = await runOfflineAcceptReuse({
        configFile,
        input,
        disclosed: ["diagnosis", "notes"],
      });
      const refreshedSpec = parseExchangeSpec(YAML.parse(raw));
      // What the partner actually transmits now: its new disclosed set.
      const partnerPayload = {
        columns: ["diagnosis", "notes"],
        rowIndices: [],
        rows: [],
      };
      // The refreshed commitment matches the partner's transmission -> no abort.
      expect(() =>
        reconcileReceivedPayload(
          partnerPayload,
          refreshedSpec.expectedPayloadColumns,
        ),
      ).not.toThrow();
      // The stale commitment would have aborted the same honest exchange.
      expect(() =>
        reconcileReceivedPayload(
          partnerPayload,
          staleSpec.expectedPayloadColumns,
        ),
      ).toThrow(/payload disclosure mismatch/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("handler: offline accept-reuse removes the commitment when the invitation holds no disclosed subset", async () => {
    // A re-accept whose invitation held no disclosed subset (an older or
    // metadata-unknown mint) records no consented set: the prior commitment is cleared
    // so the recurring exchange reconciles lazily, not left stale.
    const { dir, input, configFile } = offlineAcceptFixture();
    try {
      writeExistingConfig(configFile);
      fs.appendFileSync(configFile, "expected_payload_columns:\n  - old_col\n");
      const raw = await runOfflineAcceptReuse({
        configFile,
        input,
        disclosed: undefined,
      });
      expect(raw).not.toContain("expected_payload_columns");
      expect(raw).not.toContain("old_col");
      const parsed = parseExchangeSpec(YAML.parse(raw));
      expect(parsed.expectedPayloadColumns).toBeUndefined();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("handler: offline accept-reuse writes an empty consented set verbatim (strict receive-nothing)", async () => {
    // An empty disclosed subset is a real consent ("receive nothing"), distinct from
    // absent: it must be written as an empty list so a later non-empty payload aborts.
    const { dir, input, configFile } = offlineAcceptFixture();
    try {
      writeExistingConfig(configFile);
      fs.appendFileSync(configFile, "expected_payload_columns:\n  - old_col\n");
      const raw = await runOfflineAcceptReuse({
        configFile,
        input,
        disclosed: [],
      });
      expect(raw).not.toContain("old_col");
      const parsed = parseExchangeSpec(YAML.parse(raw));
      expect(parsed.expectedPayloadColumns).toEqual([]);
      // Strict "receive nothing": any transmitted column aborts.
      expect(() =>
        reconcileReceivedPayload(
          { columns: ["diagnosis"], rowIndices: [], rows: [] },
          parsed.expectedPayloadColumns,
        ),
      ).toThrow(/payload disclosure mismatch/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

// --- the acceptance's terms-side commitment reaches the config ------------------

describe("the acceptance's terms-side commitment reaches the config", () => {
  test("handler: offline accept writes the invitation's declared deduplicate to the config", async () => {
    // Offline accept writes a config and stops, so the binding the invitation
    // declared has to reach DISK or the later `psilink exchange` holds the partner
    // to nothing. Both booleans, and read back off the schema so the snake_case
    // serialization is part of what is pinned: `false` is a real declaration, and
    // the one a hostile inviter would widen away from.
    for (const declared of [false, true]) {
      const { dir, input, configFile, keyFile } = offlineAcceptFixture();
      const exit = vi
        .spyOn(process, "exit")
        .mockImplementation((() => undefined) as never);
      try {
        const base = sampleToken(FUTURE());
        const encoded = await encodeInvitation({
          ...base,
          linkageTerms: { ...base.linkageTerms, deduplicate: declared },
        });
        await acceptHandler({
          _: [],
          $0: "psilink",
          identity: "Agency B",
          args: [encoded, input],
          "consent-to-terms": true,
          "config-file": configFile,
          "key-file": keyFile,
          "log-level": "silent",
          record: false,
        } as unknown as Arguments);
        expect(exit).not.toHaveBeenCalled();
        const parsed = parseExchangeSpec(
          YAML.parse(fs.readFileSync(configFile, "utf8")),
        );
        expect(parsed.expectedPartnerDeduplicate).toBe(declared);
        // The written config states this party's OWN side as the mirror's false,
        // separately from the partner's declaration: one is not read off the other.
        expect(parsed.linkageTerms.deduplicate).toBe(false);
      } finally {
        exit.mockRestore();
        fs.rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  test("handler: offline accept-reuse refreshes a stale declaration, preserving operator content", async () => {
    // A kept config holding a PRIOR acceptance's declaration, re-accepted over an
    // invitation declaring the other value. Leaving the stale `true` would refuse
    // the honest partner now presenting `false`; the surgical refresh overwrites it
    // and leaves the operator's comment and connection block alone.
    const { dir, input, configFile } = offlineAcceptFixture();
    try {
      writeExistingConfig(configFile);
      fs.appendFileSync(
        configFile,
        "# operator-authored note\nexpected_partner_deduplicate: true\n",
      );
      const base = sampleToken(FUTURE());
      const raw = await runOfflineAcceptReuse({
        configFile,
        input,
        disclosed: undefined,
        token: {
          ...base,
          linkageTerms: { ...base.linkageTerms, deduplicate: false },
        },
      });
      expect(raw).toContain("# operator-authored note");
      expect(raw).toContain("/mnt/share");
      expect(
        parseExchangeSpec(YAML.parse(raw)).expectedPartnerDeduplicate,
      ).toBe(false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("handler: online accept forwards the invitation's declared deduplicate to runOnlineBootstrap", async () => {
    // The online wiring, fresh and reuse alike: the handler must hand the
    // declaration to the persistence layer (runOnlineBootstrap's own tests cover
    // the write), or a config born of an online acceptance runs its later recurring
    // exchanges unbound. Mocked, so no connection is opened.
    const { dir, input, configFile, keyFile } = offlineAcceptFixture();
    const runOnlineBootstrapMock = vi.mocked(runOnlineBootstrap);
    runOnlineBootstrapMock.mockResolvedValue({ configWriteError: undefined });
    const exit = vi
      .spyOn(process, "exit")
      .mockImplementation((() => undefined) as never);
    try {
      for (const declared of [false, true]) {
        runOnlineBootstrapMock.mockClear();
        const base = sampleToken(FUTURE());
        const encoded = await encodeInvitation({
          ...base,
          linkageTerms: { ...base.linkageTerms, deduplicate: declared },
        });
        await acceptHandler({
          _: [],
          $0: "psilink",
          identity: "Agency B",
          args: ["sftp://host/drop", encoded, input],
          "consent-to-terms": true,
          "config-file": configFile,
          "key-file": keyFile,
          "log-level": "silent",
          record: false,
        } as unknown as Arguments);
        expect(exit).not.toHaveBeenCalled();
        expect(runOnlineBootstrapMock).toHaveBeenCalledTimes(1);
        expect(
          runOnlineBootstrapMock.mock.calls[0][0].expectedPartnerDeduplicate,
        ).toBe(declared);
      }
    } finally {
      exit.mockRestore();
      runOnlineBootstrapMock.mockReset();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

// --- accept-reuse warns when the re-acceptance drops the commitment -------------

// The distinctive clause of the removal warning, kept apart from the column list
// and the remedy the assertions check separately.
const DROPPED_LOCK_IN_CLAUSE =
  "clears the list of columns you previously agreed to receive";

/**
 * Every warning a reuse acceptance emits over a config recording `recorded` as
 * its received-payload commitment, re-accepted from an invitation holding
 * `disclosed`. Both accept-reuse paths reconcile the same kept config, so `mode`
 * drives either through one fixture; the saved connection agrees with the online
 * URL, so the reuse verdict has no connection warning of its own.
 */
async function reuseLockInWarnings(params: {
  recorded: string[] | undefined;
  disclosed: string[] | undefined;
  loggerName: string;
  mode?: "online" | "offline";
}): Promise<string[]> {
  const { recorded, disclosed, loggerName, mode = "offline" } = params;
  const dir = fs.mkdtempSync(path.join(tmpdir(), "psilink-accept-lockin-"));
  const configFile = path.join(dir, "psilink.yaml");
  const keyFile = path.join(dir, ".psilink.key");
  const input = path.join(dir, "input.csv");
  fs.writeFileSync(
    input,
    "first_name,last_name,dob,ssn\nAlice,Smith,1990-01-02,123456789\n",
  );
  saveConfig(configFile, {
    connection: { channel: "sftp", server: { host: "host" } },
    linkageTerms: sampleTerms("Acceptor Org"),
    ...(recorded !== undefined ? { expectedPayloadColumns: recorded } : {}),
  });
  const log = getLogger(loggerName);
  log.setLevel("silent");
  const warnSpy = vi.spyOn(log, "warn");
  // These options have the default flag identity, which the kept file does not
  // match, so every case here also raises the no-effect notice on the prompt's
  // own sink; capture it rather than leaving it in the suite's output.
  const stdio = captureStdio();
  try {
    const encoded = await encodeInvitation({
      ...sampleToken(FUTURE()),
      disclosedPayloadColumns: disclosed,
    });
    const ready = await validateAccept({
      resolved:
        mode === "online"
          ? {
              mode: "online",
              url: new URL("sftp://host"),
              invitation: encoded,
              input,
            }
          : { mode: "offline", invitation: encoded, input },
      options: testOptions({ configFile, keyFile }),
      log,
    });
    // Every case here is a reuse: a warning about the kept config's commitment is
    // meaningless if the config was not kept.
    expect(ready.reuseExistingConfig).toBe(true);
    return warnSpy.mock.calls.map((c) => String(c[0]));
  } finally {
    stdio.restore();
    warnSpy.mockRestore();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** The one dropped-commitment warning in `warnings`, asserted to be exactly one. */
function droppedLockInWarning(warnings: string[]): string {
  const dropped = warnings.filter((m) => m.includes(DROPPED_LOCK_IN_CLAUSE));
  expect(dropped).toHaveLength(1);
  return dropped[0];
}

describe("accept-reuse warns when the re-acceptance drops the commitment", () => {
  test("validateAccept: offline reuse warns, naming the columns, when the re-acceptance drops the commitment", async () => {
    // The kept config records what the operator consented to receive; this
    // invitation has no disclosed subset, so accepting it removes that record
    // and leaves the next exchange reconciling lazily. One warning, naming the
    // columns being given up, while the operator can still decline.
    const warnings = await reuseLockInWarnings({
      recorded: ["diagnosis", "notes"],
      disclosed: undefined,
      loggerName: "accept-lockin-drop-offline",
    });
    const dropped = droppedLockInWarning(warnings);
    // One column per line, so a name holding the list separator cannot be misread
    // as two entries.
    expect(dropped).toContain("\n  - diagnosis");
    expect(dropped).toContain("\n  - notes");
    expect(dropped).toContain("accepts whatever columns the partner transmits");
  });

  test("validateAccept: online reuse warns when the re-acceptance drops the commitment", async () => {
    // The second accept-reuse path: the online acceptance refreshes the same kept
    // config, so the same removal must be visible there -- and it lands before any
    // network activity, so the operator sees it at the same prompt.
    const warnings = await reuseLockInWarnings({
      recorded: ["diagnosis"],
      disclosed: undefined,
      loggerName: "accept-lockin-drop-online",
      mode: "online",
    });
    expect(droppedLockInWarning(warnings)).toContain("\n  - diagnosis");
  });

  test("validateAccept: reuse stays silent when the acceptance records a commitment of its own", async () => {
    // Nothing is dropped when this acceptance consents to a set: an unchanged set
    // leaves the record as it stands, and a changed one is a refresh the operator
    // just consented to. Neither loses the check, so neither warns.
    const unchanged = await reuseLockInWarnings({
      recorded: ["diagnosis"],
      disclosed: ["diagnosis"],
      loggerName: "accept-lockin-unchanged",
    });
    expect(unchanged.filter((m) => m.includes(DROPPED_LOCK_IN_CLAUSE))).toEqual(
      [],
    );
    const changed = await reuseLockInWarnings({
      recorded: ["diagnosis"],
      disclosed: ["notes"],
      loggerName: "accept-lockin-changed",
    });
    expect(changed.filter((m) => m.includes(DROPPED_LOCK_IN_CLAUSE))).toEqual(
      [],
    );
  });

  test("validateAccept: reuse stays silent when the acceptance newly sets the commitment", async () => {
    // A kept config that recorded no commitment loses nothing by gaining one.
    const warnings = await reuseLockInWarnings({
      recorded: undefined,
      disclosed: ["diagnosis"],
      loggerName: "accept-lockin-newly-set",
    });
    expect(warnings.filter((m) => m.includes(DROPPED_LOCK_IN_CLAUSE))).toEqual(
      [],
    );
  });

  test("validateAccept: reuse warns that a recorded receive-nothing consent is dropped", async () => {
    // The strictest commitment of all -- an empty recorded set, which aborts on any
    // transmitted column -- has no column names to list, so the warning has to name
    // the consent itself rather than fall silent on an empty list.
    const warnings = await reuseLockInWarnings({
      recorded: [],
      disclosed: undefined,
      loggerName: "accept-lockin-drop-empty",
    });
    expect(droppedLockInWarning(warnings)).toContain(
      "no columns at all (a strict receive-nothing consent)",
    );
  });

  test("validateAccept: the dropped commitment's column names are escaped for display", async () => {
    // The recorded set is the partner's namespace, brought into the config by an
    // earlier acceptance, so a name planted with a terminal escape must not reach
    // the operator raw when this warning reads it back out.
    const hostile = `notes${ESC}[0m`;
    const warnings = await reuseLockInWarnings({
      recorded: [hostile],
      disclosed: undefined,
      loggerName: "accept-lockin-drop-escaping",
    });
    const dropped = droppedLockInWarning(warnings);
    expect(dropped).toContain(sanitizeForDisplay(hostile));
    expect(dropped).not.toContain(ESC);
  });
});

// --- handler: the acceptance records consent to its OWN outbound set ---------

// The acceptor's outbound column set is authored by no party: the invitation
// authors the inviter's send, the mirror leaves the acceptor's own send absent,
// and the set comes from its input columns. These pin that the acceptance records
// what it showed, in each of the three shapes an acceptance can be in, so a later
// run has something to hold itself to.

/** An offline-accept CSV whose header discloses one payload column. */
function fixtureWithPayloadColumn(): ReturnType<typeof offlineAcceptFixture> {
  const fixture = offlineAcceptFixture();
  fs.writeFileSync(
    fixture.input,
    "first_name,last_name,dob,ssn,diagnosis\n" +
      "Alice,Smith,1990-01-02,123456789,A\n",
  );
  return fixture;
}

/**
 * Run the offline accept handler on a fresh config (no pre-existing file), with
 * --consent-to-terms so the confirmation prompt is skipped, and return the written
 * config's text. `input` is omitted for the accept-with-no-input-file case.
 */
async function runOfflineAcceptFresh(params: {
  configFile: string;
  keyFile: string;
  input?: string;
  token?: InvitationToken;
}): Promise<string> {
  const exit = vi
    .spyOn(process, "exit")
    .mockImplementation((() => undefined) as never);
  try {
    const encoded = await encodeInvitation(
      params.token ?? sampleToken(FUTURE()),
    );
    await acceptHandler({
      _: [],
      $0: "psilink",
      identity: "Agency B",
      args: params.input !== undefined ? [encoded, params.input] : [encoded],
      "consent-to-terms": true,
      "config-file": params.configFile,
      "key-file": params.keyFile,
      "log-level": "silent",
      record: false,
    } as unknown as Arguments);
    expect(exit).not.toHaveBeenCalled();
    return fs.readFileSync(params.configFile, "utf8");
  } finally {
    exit.mockRestore();
  }
}

describe("handler: the acceptance records consent to its OWN outbound set", () => {
  test("handler: an acceptance that resolves its outbound set records it as confirmed", async () => {
    // The set is resolvable here, so what the display showed is what is recorded --
    // and it is the disclosed set, not every column in the file: the four linkage
    // columns are not transmitted, diagnosis is.
    const { dir, input, configFile, keyFile } = fixtureWithPayloadColumn();
    try {
      const raw = await runOfflineAcceptFresh({ configFile, keyFile, input });
      expect(parseExchangeSpec(YAML.parse(raw)).outboundPayloadConsent).toEqual(
        {
          status: "confirmed",
          columns: ["diagnosis"],
        },
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("handler: an acceptance with no input file records the set as pending", async () => {
    // The case the display forward-references: nothing here can resolve the set, so
    // the record says so rather than being absent (which would leave the run lazy)
    // or guessing a set. The first run that can resolve it asks.
    const { dir, configFile, keyFile } = offlineAcceptFixture();
    try {
      const raw = await runOfflineAcceptFresh({ configFile, keyFile });
      expect(parseExchangeSpec(YAML.parse(raw)).outboundPayloadConsent).toEqual(
        {
          status: "pending",
        },
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("handler: an acceptance that transmits nothing records no consent", async () => {
    // An invitation that gives the inviting party no result: the payload step
    // transmits nothing whatever the input holds, so there is no disclosure to
    // consent to and no record to enforce -- matching the display, which names no
    // column set for this shape either.
    const { dir, input, configFile, keyFile } = fixtureWithPayloadColumn();
    try {
      const base = sampleToken(FUTURE());
      const raw = await runOfflineAcceptFresh({
        configFile,
        keyFile,
        input,
        token: {
          ...base,
          linkageTerms: {
            ...base.linkageTerms,
            output: { expectsOutput: false, shareWithPartner: true },
          },
        },
      });
      expect(raw).not.toContain("outbound_payload_consent");
      expect(
        parseExchangeSpec(YAML.parse(raw)).outboundPayloadConsent,
      ).toBeUndefined();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("handler: offline accept-reuse refreshes the outbound consent, preserving operator content", async () => {
    // A re-acceptance is a fresh consent to a freshly displayed set, so the kept
    // config's record is rewritten to it rather than left at a prior acceptance's
    // value -- the same reasoning as the received-payload commitment beside it, and the
    // same surgical write.
    const { dir, input, configFile } = fixtureWithPayloadColumn();
    try {
      writeExistingConfig(configFile);
      fs.appendFileSync(
        configFile,
        "# operator-authored note\n" +
          "outbound_payload_consent:\n  status: confirmed\n  columns:\n" +
          "    - stale_col\n",
      );
      const raw = await runOfflineAcceptReuse({
        configFile,
        input,
        disclosed: undefined,
      });
      expect(raw).toContain("# operator-authored note");
      expect(raw).not.toContain("stale_col");
      expect(parseExchangeSpec(YAML.parse(raw)).outboundPayloadConsent).toEqual(
        {
          status: "confirmed",
          columns: ["diagnosis"],
        },
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("handler: a no-output invitation cannot strip the record from a kept config that shares", async () => {
    // The partner-controlled shape the reuse derivation exists for: reconciliation
    // compares no output field, so an invitation holding expects_output: false
    // reconciles as matching a kept config that still shares. The mirror then
    // yields no record -- and deleting the existing one would leave the later run
    // ungated (the gate no-ops on an absent record). The record falls to pending
    // instead: nothing about the outbound set was displayed or confirmed for a
    // config that will transmit.
    const { dir, input, configFile } = fixtureWithPayloadColumn();
    try {
      writeExistingConfig(configFile);
      fs.appendFileSync(
        configFile,
        "outbound_payload_consent:\n  status: confirmed\n  columns:\n" +
          "    - stale_col\n",
      );
      const base = sampleToken(FUTURE());
      const raw = await runOfflineAcceptReuse({
        configFile,
        input,
        disclosed: undefined,
        token: {
          ...base,
          linkageTerms: {
            ...base.linkageTerms,
            output: { expectsOutput: false, shareWithPartner: true },
          },
        },
      });
      expect(parseExchangeSpec(YAML.parse(raw)).outboundPayloadConsent).toEqual(
        {
          status: "pending",
        },
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("handler: the record is removed on reuse only where the kept config does not share", async () => {
    // The inert case: the kept config's own terms admit no transmission, so a
    // leftover record describes nothing the run can send and is removed as
    // hygiene rather than left stale.
    const { dir, input, configFile } = fixtureWithPayloadColumn();
    try {
      const terms = sampleTerms("Acceptor Org");
      writeExistingConfig(configFile, {
        terms: {
          ...terms,
          output: { ...terms.output, shareWithPartner: false },
        },
      });
      fs.appendFileSync(
        configFile,
        "outbound_payload_consent:\n  status: confirmed\n  columns:\n" +
          "    - stale_col\n",
      );
      const base = sampleToken(FUTURE());
      const raw = await runOfflineAcceptReuse({
        configFile,
        input,
        disclosed: undefined,
        token: {
          ...base,
          linkageTerms: {
            ...base.linkageTerms,
            output: { expectsOutput: false, shareWithPartner: true },
          },
        },
      });
      expect(raw).not.toContain("outbound_payload_consent");
      expect(
        parseExchangeSpec(YAML.parse(raw)).outboundPayloadConsent,
      ).toBeUndefined();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("handler: offline accept-reuse without an input file overwrites a confirmed record with pending", async () => {
    // The unresolvable shape through the reuse writer: this acceptance displayed no
    // set, so a prior acceptance's confirmed columns must not stand as if they were
    // confirmed here -- pending makes the first resolving run show and ask.
    const { dir, configFile } = fixtureWithPayloadColumn();
    try {
      writeExistingConfig(configFile);
      fs.appendFileSync(
        configFile,
        "outbound_payload_consent:\n  status: confirmed\n  columns:\n" +
          "    - stale_col\n",
      );
      const raw = await runOfflineAcceptReuse({
        configFile,
        disclosed: undefined,
      });
      expect(parseExchangeSpec(YAML.parse(raw)).outboundPayloadConsent).toEqual(
        {
          status: "pending",
        },
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("handler: online accept forwards its own outbound consent to runOnlineBootstrap", async () => {
    // The online sibling of the offline write: the set is known before the handshake
    // (it is what the display showed), so it rides the acceptance's first config
    // write. runOnlineBootstrap is mocked here so no connection is opened; its own
    // tests cover the write.
    const { dir, input, configFile, keyFile } = fixtureWithPayloadColumn();
    const runOnlineBootstrapMock = vi.mocked(runOnlineBootstrap);
    runOnlineBootstrapMock.mockResolvedValue({ configWriteError: undefined });
    const exit = vi
      .spyOn(process, "exit")
      .mockImplementation((() => undefined) as never);
    try {
      const encoded = await encodeInvitation(sampleToken(FUTURE()));
      await acceptHandler({
        _: [],
        $0: "psilink",
        identity: "Agency B",
        args: ["sftp://host/drop", encoded, input],
        "consent-to-terms": true,
        "config-file": configFile,
        "key-file": keyFile,
        "log-level": "silent",
        record: false,
      } as unknown as Arguments);
      expect(exit).not.toHaveBeenCalled();
      expect(
        runOnlineBootstrapMock.mock.calls[0][0].outboundPayloadConsent,
      ).toEqual({ status: "confirmed", columns: ["diagnosis"] });
    } finally {
      exit.mockRestore();
      runOnlineBootstrapMock.mockReset();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("handler: online accept whose config write failed keeps exit 73 and says so", async () => {
    // The unattended half of the outcome: a wrapper gating on exit status must not
    // read a rotated key with no configuration as a completed setup. The
    // persistence-loss code is set where the write failed (runProtocol's hook
    // handling), so the mocked runOnlineBootstrap stands in for that run by
    // leaving 73 behind, and what is asserted here is that the handler passes it
    // through untouched -- a summary that assigned the exit code itself would
    // overwrite exactly this. No connection is opened; --log-level error is the
    // level the summary is written at, and the level the underlying error it
    // points back to is shown at.
    const { dir, input, configFile, keyFile } = offlineAcceptFixture();
    const runOnlineBootstrapMock = vi.mocked(runOnlineBootstrap);
    runOnlineBootstrapMock.mockImplementation(async () => {
      process.exitCode = 73;
      return { configWriteError: new Error("permission denied") };
    });
    const exit = vi
      .spyOn(process, "exit")
      .mockImplementation((() => undefined) as never);
    const stdio = captureStdio();
    const previousExitCode = process.exitCode;
    process.exitCode = undefined;
    try {
      const encoded = await encodeInvitation(sampleToken(FUTURE()));
      await acceptHandler({
        _: [],
        $0: "psilink",
        identity: "Agency B",
        args: ["sftp://host/drop", encoded, input],
        "consent-to-terms": true,
        "config-file": configFile,
        "key-file": keyFile,
        "log-level": "error",
        record: false,
      } as unknown as Arguments);
      // Read before the finally block restores the exit code and the stdio spies.
      const exitCode = process.exitCode;
      const stderr = stdio.stderrWrites.join("");
      expect(exit).not.toHaveBeenCalled();
      expect(runOnlineBootstrapMock).toHaveBeenCalledTimes(1);
      expect(exitCode).toBe(73);
      // The operator is told which half landed, at error level: the key is saved,
      // the config is not.
      expect(stderr).toContain("[ERROR] [accept] ");
      expect(stderr).toContain(`could not be written to ${configFile}`);
      expect(stderr).toContain(`rotated key was saved to ${keyFile}`);
    } finally {
      process.exitCode = previousExitCode;
      stdio.restore();
      exit.mockRestore();
      runOnlineBootstrapMock.mockReset();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("handler: a clean config write leaves the exchange's own exit 73 in place", async () => {
    // The exchange completed but could not write an audit artifact, so runProtocol
    // left the persistence-loss code behind; the config write that followed then
    // succeeded. The outcome summary moves no process state, so the run an
    // unattended supervisor sees still reports the lost record rather than a clean
    // 0. runOnlineBootstrap stands in for that exchange, setting the exit code the
    // way runProtocol does and reporting a written config.
    const { dir, input, configFile, keyFile } = offlineAcceptFixture();
    const runOnlineBootstrapMock = vi.mocked(runOnlineBootstrap);
    runOnlineBootstrapMock.mockImplementation(async () => {
      process.exitCode = 73;
      return { configWriteError: undefined };
    });
    const exit = vi
      .spyOn(process, "exit")
      .mockImplementation((() => undefined) as never);
    const stdio = captureStdio();
    const previousExitCode = process.exitCode;
    process.exitCode = undefined;
    try {
      const encoded = await encodeInvitation(sampleToken(FUTURE()));
      await acceptHandler({
        _: [],
        $0: "psilink",
        identity: "Agency B",
        args: ["sftp://host/drop", encoded, input],
        "consent-to-terms": true,
        "config-file": configFile,
        "key-file": keyFile,
        "log-level": "info",
        record: true,
      } as unknown as Arguments);
      // Read before the finally block restores the exit code and the stdio spies.
      const exitCode = process.exitCode;
      const stderr = stdio.stderrWrites.join("");
      expect(exit).not.toHaveBeenCalled();
      expect(runOnlineBootstrapMock).toHaveBeenCalledTimes(1);
      expect(exitCode).toBe(73);
      // The setup summary is still reported; only the clean exit code is withheld.
      expect(stderr).toContain(`saved config to ${configFile}`);
    } finally {
      process.exitCode = previousExitCode;
      stdio.restore();
      exit.mockRestore();
      runOnlineBootstrapMock.mockReset();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
