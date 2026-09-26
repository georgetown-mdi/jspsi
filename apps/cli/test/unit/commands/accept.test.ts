import fs from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";

import { afterEach, describe, expect, test, vi } from "vitest";
import type { Arguments } from "yargs";
import logLibrary from "loglevel";
import YAML from "yaml";
import {
  CONNECTION_BLOCK_DOC_URL,
  CONNECTION_BLOCK_NOTICE,
  DEFAULT_LINKAGE_RULE_SET,
  DEFAULT_POLLING_FREQUENCY_MS,
  DISPLAY_TRUNCATION_MARKER,
  encodeInvitation,
  getDefaultLinkageTerms,
  getDiagnosticSink,
  getLogger,
  parseExchangeSpec,
  reconcileReceivedPayload,
  redactPrivateKeyMaterial,
  sanitizeErrorForDisplay,
  sanitizeForDisplay,
  setDiagnosticSink,
  UsageError,
} from "@alcove/core";
import {
  BEL,
  ESC,
  MAX_ENDPOINT_HOST_LENGTH,
  MAX_RAW_INVITATION_LENGTH,
  PRINTABLE_ASCII,
  RLO,
} from "@alcove/core/testing";
import type {
  ConnectionConfig,
  ConnectionEndpoint,
  Displayable,
  InvitationToken,
  LinkageRuleSetReference,
  LinkageTerms,
} from "@alcove/core";

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
import { webRtcDialFrom } from "../../../src/protocol";
import { exitCodeForError } from "../../../src/util/exit";
import { promptConfirm, promptFreeText } from "../../../src/util/prompt";
import { captureProcessExit } from "../../exitCapture";
import {
  encodeRaw,
  FUTURE,
  LINKAGE_COLUMNS,
  OUTBOUND_SEND_LABEL,
  REPEAT_HEADING,
  REPEAT_HEADING_UNATTENDED,
  renderDisplayInvitation,
  sampleTerms,
  sampleToken,
} from "../../invitationDisplayTestSupport";
import { captureStdio } from "../../loggingTestSupport";
import { ttyStream } from "../../stdinStream";
import {
  pathAsDisplayed,
  platformAbsolutePath,
  platformFileUrl,
} from "../../platformPaths";

const promptConfirmMock = vi.mocked(promptConfirm);
const promptFreeTextMock = vi.mocked(promptFreeText);

// Beside the ESC, RLO and BEL the shared fixtures hold: an invisible character
// every terms field admits, for a case whose value is read back through the
// schema. Written as an escape so this source holds no raw invisible byte.
const ZWJ = "\u200d";

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
    configFile: path.join(tmpdir(), `alcove-accept-test-${id}.yaml`),
    keyFile: path.join(tmpdir(), `alcove-accept-test-${id}.key`),
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
      "alcove accept --identity IDENTITY INVITATION [INPUT_FILE] [OUTPUT_FILE]",
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
      "alcove accept --identity IDENTITY URL INVITATION INPUT_FILE " +
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
      path.join(tmpdir(), "alcove-accept-invitation-atfile-"),
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

  test("validateAccept: an element transform that cannot compile is refused before the prompt", async () => {
    // A `pad_left` with no `length` parses, decodes, and prepares: the factory
    // reads its params only when the pipeline is built, which on a run is key
    // realization. validateAccept compiles the invitation's element transforms
    // where it derives this party's terms, ahead of the input, the connection,
    // and the consent display, so the operator is never asked to consent to an
    // exchange the run cannot start.
    const base = sampleToken(FUTURE());
    const terms = base.linkageTerms;
    const encoded = await encodeInvitation({
      ...base,
      linkageTerms: {
        ...terms,
        linkageKeys: [
          {
            ...terms.linkageKeys[0],
            elements: [
              {
                ...terms.linkageKeys[0].elements[0],
                transform: [{ function: "pad_left" }],
              },
            ],
          },
          ...terms.linkageKeys.slice(1),
        ],
      },
    });

    await expect(
      validateAccept({
        resolved: { mode: "offline", invitation: encoded },
        options: testOptions(),
        log: silentLog,
      }),
    ).rejects.toThrow(/pad_left/);
    expect(promptConfirmMock).not.toHaveBeenCalled();
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
          input: "/nonexistent/alcove-input.csv",
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
// emits a CSV then EOF, mirroring `cat data.csv | alcove accept --consent-to-terms - INVITE`.

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
      path.join(tmpdir(), "alcove-accept-online-stdin-"),
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
            configFile: path.join(dir, "alcove.yaml"),
            keyFile: path.join(dir, ".alcove.key"),
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
          input: "/nonexistent/alcove-input.csv",
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
      path.join(tmpdir(), "alcove-accept-cpp-filedrop-"),
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
          configFile: path.join(dir, "alcove.yaml"),
          keyFile: path.join(dir, ".alcove.key"),
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
    const dir = fs.mkdtempSync(path.join(tmpdir(), "alcove-accept-cpp-sftp-"));
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
          configFile: path.join(dir, "alcove.yaml"),
          keyFile: path.join(dir, ".alcove.key"),
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

// Write a temp CSV with the given header columns (one filler data row; the
// pre-flight reasons about column names, not values). Returns the path.
function writeInputCSV(columns: string[]): string {
  const id = `${process.pid}-${optionsCounter++}`;
  const file = path.join(tmpdir(), `alcove-accept-input-${id}.csv`);
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
    // A zero-width joiner rather than an ESC: this name comes from the CSV
    // header, which the read strips every control character from, and the
    // joiner is outside that class and still needs escaping here.
    const hostile = `notes\u200d[0m`;
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
    expect(refused).not.toContain("\u200d");
    // Offline acceptance completes, so it says where the refusal actually arrives.
    expect(refused).toContain("alcove exchange");
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
    expect(refused).not.toContain("alcove exchange");
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

  test("validateAccept: offline reports an ignored --server-* override before an aborting input read", async () => {
    // The warning is emitted ahead of the config reconciliation and the input
    // read, both of which abort: an operator whose accept fails on the CSV still
    // reads that the --server-* flags they passed have no effect, rather than
    // rerunning with a fixed CSV to learn it.
    const missingInput = path.join(
      tmpdir(),
      `alcove-accept-absent-${process.pid}-${optionsCounter++}.csv`,
    );
    const log = getLogger("accept-offline-override-warn-before-abort");
    log.setLevel("silent");
    const warnSpy = vi.spyOn(log, "warn");
    try {
      const encoded = await encodeInvitation(sampleToken(FUTURE()));
      await expect(
        validateAccept({
          resolved: {
            mode: "offline",
            invitation: encoded,
            input: missingInput,
          },
          options: testOptions({ serverUsername: "alice" }),
          log,
        }),
      ).rejects.toThrow(/does not exist/);
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
    }
  });

  test("validateAccept: online does not warn about a --server-* override (it is applied)", async () => {
    // The online path builds the connection from the URL through
    // applyConnectionOverrides, so the override takes effect and no
    // ignored-override warning is emitted.
    const dir = fs.mkdtempSync(
      path.join(tmpdir(), "alcove-accept-online-override-"),
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
          configFile: path.join(dir, "alcove.yaml"),
          keyFile: path.join(dir, ".alcove.key"),
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
      path.join(tmpdir(), "alcove-accept-online-opt-override-"),
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
          configFile: path.join(dir, "alcove.yaml"),
          keyFile: path.join(dir, ".alcove.key"),
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
    // `alcove exchange` can learn which side it is on -- the operator never
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

  test("validateAccept: a column the invitation discloses twice is expected once", async () => {
    // The acceptance writes the invitation's disclosed set as what it will
    // receive, and the run aborts when the partner's transmitted set differs
    // (reconcileReceivedPayload). A name written twice is one declaration;
    // encodeInvitation collapses it once at mint, so this test pins that
    // mint-side collapse. The decode-side case, a raw partner token minted
    // outside encodeInvitation, is pinned by
    // packages/core/test/config/invitation.test.ts's encodeRaw test.
    const input = writeInputCSV(["first_name", "last_name", "dob", "ssn"]);
    try {
      const encoded = await encodeInvitation({
        ...sampleToken(FUTURE(), WEBRTC_ENDPOINT),
        disclosedPayloadColumns: ["diagnosis", "diagnosis"],
      });
      const ready = await validateAccept({
        resolved: { mode: "offline", invitation: encoded, input },
        options: testOptions(),
        log: silentLog,
      });
      expect(ready.mode).toBe("endpointRun");
      if (ready.mode !== "endpointRun") return;
      expect(ready.prepared.expectedPayloadColumns).toEqual(["diagnosis"]);
    } finally {
      fs.rmSync(input, { force: true });
    }
  });

  test("validateAccept: --peer-timeout bounds the acceptance that runs the exchange", async () => {
    // This acceptance conducts the exchange itself, so the budget flag is the
    // operator's only lever on how long it waits for a partner who never
    // arrives; it is applied to the connection rather than reported ignored.
    const input = writeInputCSV(["first_name", "last_name", "dob", "ssn"]);
    const messages: string[] = [];
    try {
      const encoded = await encodeInvitation(
        sampleToken(FUTURE(), WEBRTC_ENDPOINT),
      );
      const ready = await validateAccept({
        resolved: { mode: "offline", invitation: encoded, input },
        options: testOptions({ peerTimeout: 10 }),
        log: recordingLog(messages),
      });
      expect(ready.mode).toBe("endpointRun");
      if (ready.mode !== "endpointRun") return;
      // Seconds at the flag, milliseconds in the connection this run dials and
      // the bootstrap writes.
      expect(ready.connection.options?.peerTimeoutMs).toBe(10_000);
      expect(
        messages.some((m) => m.includes("--peer-timeout")),
        "the running acceptance reported the flag it just applied as ignored",
      ).toBe(false);
      // What that one value buys on this transport: the wait for the partner to
      // arrive, the wait for the channel to open, and the peer silence after.
      const { options } = webRtcDialFrom(
        ready.connection,
        generateSharedSecret(),
      );
      expect(options.rendezvousTimeoutMs).toBe(10_000);
      expect(options.channelOpenTimeoutMs).toBe(10_000);
      expect(options.inactivityTimeoutMs).toBe(10_000);
    } finally {
      fs.rmSync(input, { force: true });
    }
  });

  test("validateAccept: --peer-timeout stays reported ignored on an acceptance that writes a configuration", async () => {
    // The write-only branch applies no connection override: the block it writes
    // is one the operator edits, so a budget flag would be silently dropped and
    // is named instead. Both shapes that reach it -- no input file to exchange,
    // and an endpoint on a channel whose credentials the operator supplies --
    // report it.
    const input = writeInputCSV(["first_name", "last_name", "dob", "ssn"]);
    try {
      for (const resolved of [
        {
          invitation: await encodeInvitation(
            sampleToken(FUTURE(), WEBRTC_ENDPOINT),
          ),
        },
        {
          invitation: await encodeInvitation(
            sampleToken(FUTURE(), {
              channel: "sftp" as const,
              host: "sftp.example.org",
              path: "/exchange",
            }),
          ),
          input,
        },
      ]) {
        const messages: string[] = [];
        const ready = await validateAccept({
          resolved: { mode: "offline", ...resolved },
          options: testOptions({ peerTimeout: 10 }),
          log: recordingLog(messages),
        });
        expect(ready.mode).toBe("offline");
        if (ready.mode !== "offline") return;
        expect(ready.connection.options?.peerTimeoutMs).toBeUndefined();
        expect(
          messages.some(
            (m) =>
              m.includes("--peer-timeout") && m.includes("connection.options"),
          ),
        ).toBe(true);
      }
    } finally {
      fs.rmSync(input, { force: true });
    }
  });

  test("validateAccept: a webrtc invitation with no input file keeps the two-command shape", async () => {
    // No dataset, so there is no exchange to run: the acceptance writes the
    // configuration and key file, and `alcove exchange` conducts it later.
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
    // The kept configuration governs its own exchange -- `alcove exchange` loads
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
            m.includes("alcove exchange"),
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
  const dir = fs.mkdtempSync(path.join(tmpdir(), "alcove-accept-kept-"));
  const configFile = path.join(dir, "alcove.yaml");
  const keyFile = path.join(dir, ".alcove.key");
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

/**
 * A configuration at `configPath` whose linkage terms name `reference` and
 * write no `linkage_fields` or `linkage_keys` of their own -- the short form
 * `readExistingAcceptConfig` fills in from the named set before the reconcile
 * compares the file against the invitation.
 */
function writeRuleSetNamingConfig(
  configPath: string,
  reference: LinkageRuleSetReference,
): void {
  const {
    linkageFields: _fields,
    linkageKeys: _keys,
    ...rest
  } = getDefaultLinkageTerms("Acceptor Org");
  fs.writeFileSync(
    configPath,
    YAML.stringify({
      connection: { channel: "filedrop", path: "/mnt/share" },
      linkage_terms: { ...rest, linkageRuleSet: reference },
    }),
  );
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
    // Neither value is Alcove's: one was typed at the command line and one read
    // out of a file, and the consent-surface sink this notice takes is their
    // display boundary.
    const flag = `Agency B${ESC}[0m`;
    // The stored label is read back through the config schema, which refuses a
    // control character and a text-direction one in an identity, so the value
    // that needs escaping here is the zero-width joiner: invisible, outside both
    // refused classes, and stored exactly as the operator typed it.
    const stored = `Acceptor Org${ZWJ}`;
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
    expect(notice).not.toContain(ZWJ);
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

  test("validateAccept: a reused config naming the shipped rule set reconciles", async () => {
    // The kept file writes no rules, so the reconcile has terms to compare only
    // because the named set was resolved into them first. The invitation
    // declares that same whole set.
    const options = testOptions();
    writeRuleSetNamingConfig(
      options.configFile,
      DEFAULT_LINKAGE_RULE_SET.reference,
    );
    const stdio = captureStdio();
    try {
      const encoded = await encodeInvitation({
        ...sampleToken(FUTURE()),
        linkageTerms: getDefaultLinkageTerms("Inviter Org"),
      });
      const ready = await validateAccept({
        resolved: { mode: "offline", invitation: encoded },
        options,
        log: silentLog,
      });
      expect(ready.reuseExistingConfig).toBe(true);
    } finally {
      stdio.restore();
      fs.rmSync(options.configFile, { force: true });
    }
  });

  test("validateAccept: a reused config naming a set this build lacks refuses", async () => {
    // Nothing fills the rules in, and the file writes none to fall back to, so
    // the acceptance stops on the citation rather than on a terms diff.
    const options = testOptions();
    writeRuleSetNamingConfig(options.configFile, {
      fieldSet: { name: "no-such-fields", version: "9.9.9" },
      keySet: { name: "no-such-keys", version: "9.9.9" },
    });
    try {
      const encoded = await encodeInvitation({
        ...sampleToken(FUTURE()),
        linkageTerms: getDefaultLinkageTerms("Inviter Org"),
      });
      const run = () =>
        validateAccept({
          resolved: { mode: "offline", invitation: encoded },
          options,
          log: silentLog,
        });
      await expect(run()).rejects.toBeInstanceOf(UsageError);
      await expect(run()).rejects.toThrow("ships no such rule set");
      await expect(run()).rejects.toThrow(options.configFile);
    } finally {
      fs.rmSync(options.configFile, { force: true });
    }
  });

  test("validateAccept: a matching config is reconciled but a pre-existing key file still hard-aborts", async () => {
    // The reconcile path makes a pre-existing CONFIG reusable, but a
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
            input: "/nonexistent/alcove-input.csv",
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
    const dir = fs.mkdtempSync(path.join(tmpdir(), "alcove-accept-online-"));
    const input = path.join(dir, "input.csv");
    fs.writeFileSync(
      input,
      "first_name,last_name,dob,ssn\nAlice,Smith,1990-01-02,123456789\n",
    );
    const configFile = path.join(dir, "alcove.yaml");
    const keyFile = path.join(dir, ".alcove.key");
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

  // --- the CSV field delimiter over a kept configuration ---------------------
  // The kept file runs every later exchange, so its csv_delimiter reads this
  // acceptance's input where the command line names none, and is reported
  // where a flag reads the run another way.

  /** A configuration already at the path holding `csvDelimiter` (or none),
   *  beside a pipe-delimited input file. */
  function keptDelimiterConfig(csvDelimiter: string | undefined): {
    dir: string;
    configFile: string;
    keyFile: string;
    input: string;
  } {
    const dir = fs.mkdtempSync(path.join(tmpdir(), "alcove-accept-delim-"));
    const configFile = path.join(dir, "alcove.yaml");
    saveConfig(configFile, {
      connection: { channel: "filedrop", path: "/mnt/share" },
      linkageTerms: sampleTerms("Acceptor Org"),
      ...(csvDelimiter !== undefined && { csvDelimiter }),
    });
    const input = path.join(dir, "input.csv");
    fs.writeFileSync(
      input,
      "first_name|last_name|dob|ssn\nAlice|Smith|1990-01-02|123456789\n",
    );
    return { dir, configFile, keyFile: path.join(dir, ".alcove.key"), input };
  }

  test("validateAccept: the kept configuration's csv_delimiter reads this acceptance's input", async () => {
    const pipes = keptDelimiterConfig("|");
    try {
      const ready = await validateAccept({
        resolved: {
          mode: "offline",
          invitation: await encodeInvitation(sampleToken(FUTURE())),
          input: pipes.input,
        },
        options: testOptions({
          configFile: pipes.configFile,
          keyFile: pipes.keyFile,
          identity: undefined,
        }),
        log: silentLog,
      });
      expect(ready.reuseExistingConfig).toBe(true);
      // What the run reads and writes by, with no flag anywhere on the command
      // line: the kept file's own value.
      expect(ready.dataSpec.csvDelimiter).toBe("|");
    } finally {
      fs.rmSync(pipes.dir, { recursive: true, force: true });
    }
    // The discriminating case: the same file under a kept config that reads
    // commas parses as one column, which satisfies no linkage key. An
    // acceptance that ignored the file would read the pipes it shows and accept
    // terms the exchange that file governs cannot satisfy.
    const commas = keptDelimiterConfig(",");
    try {
      await expect(
        validateAccept({
          resolved: {
            mode: "offline",
            invitation: await encodeInvitation(sampleToken(FUTURE())),
            input: commas.input,
          },
          options: testOptions({
            configFile: commas.configFile,
            keyFile: commas.keyFile,
            identity: undefined,
          }),
          log: silentLog,
        }),
      ).rejects.toThrow(UsageError);
    } finally {
      fs.rmSync(commas.dir, { recursive: true, force: true });
    }
  });

  test("validateAccept: --csv-delimiter reads this acceptance's input over the kept configuration's value", async () => {
    const { dir, configFile, keyFile, input } = keptDelimiterConfig(";");
    const log = getLogger("accept-kept-delimiter-test");
    log.setLevel("silent");
    const warnSpy = vi.spyOn(log, "warn");
    try {
      const ready = await validateAccept({
        resolved: {
          mode: "offline",
          invitation: await encodeInvitation(sampleToken(FUTURE())),
          input,
        },
        options: testOptions({ configFile, keyFile, identity: undefined }),
        csvDelimiter: "|",
        log,
      });
      // The run proceeds under the flag -- a semicolon read of this input, what
      // the kept file alone would have taken, refuses on the satisfiability
      // check above.
      expect(ready.dataSpec.csvDelimiter).toBe("|");
      const reported = warnSpy.mock.calls
        .map((call) => String(call[0]))
        .filter((message) => message.includes("--csv-delimiter"));
      expect(reported).toHaveLength(1);
      expect(reported[0]).toContain('--csv-delimiter "|" applies to this run');
      expect(reported[0]).toContain('csv_delimiter (";")');
      expect(reported[0]).toContain(configFile);
    } finally {
      warnSpy.mockRestore();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("validateAccept: a --csv-delimiter the kept configuration already records is not reported", async () => {
    const { dir, configFile, keyFile, input } = keptDelimiterConfig("|");
    const log = getLogger("accept-kept-delimiter-match-test");
    log.setLevel("silent");
    const warnSpy = vi.spyOn(log, "warn");
    try {
      const ready = await validateAccept({
        resolved: {
          mode: "offline",
          invitation: await encodeInvitation(sampleToken(FUTURE())),
          input,
        },
        options: testOptions({ configFile, keyFile, identity: undefined }),
        csvDelimiter: "|",
        log,
      });
      expect(ready.dataSpec.csvDelimiter).toBe("|");
      expect(
        warnSpy.mock.calls
          .map((call) => String(call[0]))
          .filter((message) => message.includes("--csv-delimiter")),
      ).toEqual([]);
    } finally {
      warnSpy.mockRestore();
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
  const dir = fs.mkdtempSync(path.join(tmpdir(), "alcove-accept-split-"));
  const input = path.join(dir, "input.csv");
  fs.writeFileSync(
    input,
    "first_name,last_name,dob,ssn\nAlice,Smith,1990-01-02,123456789\n",
  );
  return {
    dir,
    input,
    configFile: path.join(dir, "alcove.yaml"),
    keyFile: path.join(dir, ".alcove.key"),
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
        $0: "alcove",
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
    const dir = fs.mkdtempSync(path.join(tmpdir(), "alcove-accept-unknown-"));
    const configFile = path.join(dir, "alcove.yaml");
    const keyFile = path.join(dir, ".alcove.key");
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
        $0: "alcove",
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
  const dir = fs.mkdtempSync(path.join(tmpdir(), "alcove-accept-consent-"));
  const input = path.join(dir, "input.csv");
  fs.writeFileSync(
    input,
    "first_name,last_name,dob,ssn\nAlice,Smith,1990-01-02,123456789\n",
  );
  return {
    dir,
    input,
    configFile: path.join(dir, "alcove.yaml"),
    keyFile: path.join(dir, ".alcove.key"),
  };
}

describe("handler: '--consent-to-terms' gates the confirmation prompt", () => {
  test("handler: at a terminal with no --identity, the answer lands in the config it writes", async () => {
    // The whole point of asking: the label reaches the file this acceptance
    // writes, so the later `alcove exchange` over it sends the name the operator
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
          $0: "alcove",
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
          $0: "alcove",
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
          $0: "alcove",
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
        $0: "alcove",
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
    // What reaches disk is what the later `alcove exchange` reads, so assert the
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
        $0: "alcove",
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

  test("handler: an accepted webrtc invitation's relay is written as invitation_relay, leaving turn and stun unset", async () => {
    // The configuration is where the partner's signaling endpoint is kept for
    // every later `alcove exchange`, so the relay is kept there too -- beside
    // this party's own relay settings, not in them.
    const { dir, configFile, keyFile } = offlineAcceptFixture();
    const exit = vi
      .spyOn(process, "exit")
      .mockImplementation((() => undefined) as never);
    const relay = {
      turn: ["turns:relay.example.org:443?transport=tcp"],
      stun: ["stun:relay.example.org:3478"],
    };
    try {
      const encoded = await encodeInvitation(
        sampleToken(new Date(Date.now() + 3_600_000).toISOString(), {
          channel: "webrtc",
          host: "peer.example.org",
          path: "/psi",
          relay,
        }),
      );
      await acceptHandler({
        _: [],
        $0: "alcove",
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
      expect(raw).toContain("invitation_relay:");
      const parsed = parseExchangeSpec(YAML.parse(raw));
      if (parsed.connection.channel !== "webrtc")
        throw new Error("expected webrtc");
      expect(parsed.connection.invitationRelay).toEqual(relay);
      expect(parsed.connection.turn).toBeUndefined();
      expect(parsed.connection.stun).toBeUndefined();
    } finally {
      exit.mockRestore();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("handler: a no-input webrtc acceptance points the operator at alcove exchange, not a second accept", async () => {
    // A second `alcove accept` on the key file this run just wrote would hit
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
        $0: "alcove",
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
        "Run 'alcove exchange' with your input file to conduct the exchange.",
      );
      expect(stderr).not.toContain("accept' to accept and run it in one");
    } finally {
      stdio.restore();
      exit.mockRestore();
      acceptLog.setLevel(priorLevel, false);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("handler: a seeded sftp acceptance names where each channel's block is", async () => {
    // The acceptor's seeded block still needs a credential, and it is the block
    // the operator edits from here on, so the notice names the reference section
    // holding one runnable block per channel and the written file repeats it
    // beside the tuning defaults.
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
          channel: "sftp",
          host: "sftp.example.org",
          path: "/drop",
        }),
      );
      await acceptHandler({
        _: [],
        $0: "alcove",
        identity: "Agency B",
        args: [encoded],
        "consent-to-terms": true,
        "config-file": configFile,
        "key-file": keyFile,
        "log-level": "info",
        record: false,
      } as unknown as Arguments);
      expect(exit).not.toHaveBeenCalled();
      expect(stdio.stderrWrites.join("")).toContain(CONNECTION_BLOCK_NOTICE);
      const raw = fs.readFileSync(configFile, "utf8");
      expect(raw).toContain(CONNECTION_BLOCK_DOC_URL);
      expect(raw).toContain(
        `#   poll_interval_ms: ${DEFAULT_POLLING_FREQUENCY_MS}`,
      );
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
        $0: "alcove",
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

  test("handler: --peer-timeout reaches the run and the configuration it writes", async () => {
    // One connection is both the run's and the bootstrap's, so the value the
    // dial waits on is the peer_timeout_ms the written configuration holds and
    // a later unattended `alcove exchange` inherits. No run-only override is
    // passed, which is what keeps the two the same value.
    const { dir, input, configFile, keyFile } = offlineAcceptFixture();
    const runOnlineBootstrapMock = vi.mocked(runOnlineBootstrap);
    runOnlineBootstrapMock.mockResolvedValue({ configWriteError: undefined });
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
        $0: "alcove",
        identity: "Agency B",
        args: [encoded, input, path.join(dir, "results.csv")],
        "consent-to-terms": true,
        "config-file": configFile,
        "key-file": keyFile,
        "peer-timeout": "10s",
        "log-level": "silent",
        record: false,
      } as unknown as Arguments);
      expect(exit).not.toHaveBeenCalled();
      const passed = runOnlineBootstrapMock.mock.calls[0][0];
      expect(passed.connection.options?.peerTimeoutMs).toBe(10_000);
      expect(passed.runOnlyPeerTimeoutSeconds).toBeUndefined();
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
        $0: "alcove",
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
        $0: "alcove",
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
          $0: "alcove",
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
        $0: "alcove",
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
        $0: "alcove",
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
      expect(stderrWrites.join("")).toContain(pathAsDisplayed(configFile));
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
  /** The URL an online acceptance names ahead of the invitation. */
  url?: string;
  /**
   * The positionals after the invitation, defaulting to the fixture's input CSV.
   * An empty array is the acceptance given no input file, which writes a
   * configuration and runs nothing.
   */
  positionals?: Array<string>;
  flags?: Record<string, unknown>;
  onPrompt?: (stderrWrites: ReadonlyArray<string>) => boolean;
}): Promise<{ stderrWrites: Array<string>; stdoutWrites: Array<string> }> {
  const { encoded, fixture, url, positionals, flags, onPrompt } = params;
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
      $0: "alcove",
      identity: "Agency B",
      args: [
        ...(url !== undefined ? [url] : []),
        encoded,
        ...(positionals ?? [fixture.input]),
      ],
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

describe("handler: an acceptance names the directories its invitation supplies", () => {
  // The inviter's pair; this party reads where the inviter writes and writes
  // where the inviter reads.
  const inviterIn = platformAbsolutePath("/srv/exchange/inviter-in");
  const inviterOut = platformAbsolutePath("/srv/exchange/inviter-out");
  const splitEndpoint: ConnectionEndpoint = {
    channel: "filedrop",
    inboundPath: inviterIn,
    outboundPath: inviterOut,
  };
  const directoriesHeading =
    "This acceptance runs the exchange in the two directories this " +
    "invitation names, in place of the path in your URL:";
  const inboundLine =
    "  inbound directory, where you read your partner's files: " +
    pathAsDisplayed(inviterOut);
  const outboundLine =
    "  outbound directory, where you write your files: " +
    pathAsDisplayed(inviterIn);
  const url = platformFileUrl("/mnt/share").href;

  test("handler: both directories are shown before the question, which states the run", async () => {
    const fixture = offlineAcceptFixture();
    try {
      const encoded = await encodeInvitation(
        splitEndpointToken(FUTURE(), splitEndpoint),
      );
      let atPrompt: Array<string> | undefined;
      await runOfflineAcceptCapturingStdio({
        encoded,
        fixture,
        url,
        onPrompt: (stderrWrites) => {
          atPrompt = stderrLines([...stderrWrites]);
          return false;
        },
      });
      expect(atPrompt).toBeDefined();
      const heading = atPrompt!.indexOf(directoriesHeading);
      expect(heading).toBeGreaterThanOrEqual(0);
      expect(atPrompt!.slice(heading + 1, heading + 4)).toEqual([
        inboundLine,
        outboundLine,
        "  Confirming runs the exchange in these directories, and your " +
          "configuration keeps them for later exchanges. To use your own " +
          "directories, decline and run again with --outbound-path.",
      ]);
      expect(heading).toBeLessThan(atPrompt!.indexOf(SURFACE_HEADING));
      // Repeated as the last lines before the question, so the paths are on
      // screen when it is asked.
      expect(atPrompt!.slice(-2)).toEqual([inboundLine, outboundLine]);
      expect(promptConfirmMock).toHaveBeenCalledWith(
        "Accept this invitation and run the exchange now, in the directories " +
          "named above?",
      );
    } finally {
      fs.rmSync(fixture.dir, { recursive: true, force: true });
    }
  });

  test("handler: an offline acceptance names the directories its configuration will record", async () => {
    const fixture = offlineAcceptFixture();
    try {
      const encoded = await encodeInvitation(
        splitEndpointToken(FUTURE(), splitEndpoint),
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
      expect(atPrompt).not.toContain(directoriesHeading);
      const heading = atPrompt!.indexOf(
        "The configuration this acceptance writes uses the two directories " +
          "this invitation names:",
      );
      expect(heading).toBeGreaterThanOrEqual(0);
      expect(atPrompt!.slice(heading + 1, heading + 4)).toEqual([
        inboundLine,
        outboundLine,
        "  Confirming records these directories in your configuration, where " +
          "'alcove exchange' reads and writes the exchange files. To use your " +
          "own directories, edit the configuration's connection block before " +
          "running 'alcove exchange'.",
      ]);
      expect(heading).toBeLessThan(atPrompt!.indexOf(SURFACE_HEADING));
      expect(atPrompt!.slice(-2)).toEqual([inboundLine, outboundLine]);
      expect(promptConfirmMock).toHaveBeenCalledWith(
        "Accept this invitation and write configuration?",
      );
    } finally {
      fs.rmSync(fixture.dir, { recursive: true, force: true });
    }
  });

  test("handler: an online acceptance on its own URL's path asks to run the exchange", async () => {
    const fixture = offlineAcceptFixture();
    try {
      const encoded = await encodeInvitation(sampleToken(FUTURE()));
      let atPrompt: Array<string> | undefined;
      await runOfflineAcceptCapturingStdio({
        encoded,
        fixture,
        url,
        onPrompt: (stderrWrites) => {
          atPrompt = stderrLines([...stderrWrites]);
          return false;
        },
      });
      expect(atPrompt).toBeDefined();
      expect(atPrompt).not.toContain(directoriesHeading);
      expect(promptConfirmMock).toHaveBeenCalledWith(
        "Accept this invitation and run the exchange now?",
      );
    } finally {
      fs.rmSync(fixture.dir, { recursive: true, force: true });
    }
  });

  test("handler: under --consent-to-terms the default-level log names both directories before the run", async () => {
    const fixture = offlineAcceptFixture();
    const runStarted = "run started";
    const runOnlineBootstrapMock = vi.mocked(runOnlineBootstrap);
    runOnlineBootstrapMock.mockImplementation(() => {
      process.stderr.write(`${runStarted}\n`);
      return Promise.resolve({ configWriteError: undefined });
    });
    try {
      const encoded = await encodeInvitation(
        splitEndpointToken(FUTURE(), splitEndpoint),
      );
      const { stderrWrites } = await runOfflineAcceptCapturingStdio({
        encoded,
        fixture,
        url,
        flags: { "consent-to-terms": true },
      });
      expect(promptConfirmMock).not.toHaveBeenCalled();
      expect(runOnlineBootstrapMock).toHaveBeenCalledTimes(1);
      const lines = stderrLines(stderrWrites);
      const started = lines.indexOf(runStarted);
      expect(started).toBeGreaterThan(0);
      const heading = lines.indexOf(directoriesHeading);
      expect(heading).toBeGreaterThanOrEqual(0);
      expect(lines.slice(heading + 1, heading + 3)).toEqual([
        inboundLine,
        outboundLine,
      ]);
      expect(heading).toBeLessThan(started);
      expect(lines[heading + 3]).toContain(
        "--consent-to-terms recorded that consent in advance",
      );
    } finally {
      runOnlineBootstrapMock.mockReset();
      fs.rmSync(fixture.dir, { recursive: true, force: true });
    }
  });
});

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
 * rather than a surface that dropped it. Two values are not among them.
 * {@link ARMORED_FIELD_NAME}: a declared linkage field is rendered by the label
 * of its semantic type rather than by the name the partner gave it.
 * {@link ARMORED_IDENTITY}: the party identity refuses key material at the
 * decode, so no surface ever renders one (the case below pins that refusal).
 */
const ARMORED_RENDERED = [
  ARMORED_REFERENCE,
  ARMORED_PURPOSE,
  ARMORED_SEND_COLUMN,
  ARMORED_KEY_NAME,
  ARMORED_COLUMN,
];

/**
 * An invitation holding key material in the partner-declared values the
 * consent surface renders that this fixture plants (the rule-set citation names
 * and the transform names and parameters are left plain): the payload names
 * declared in each direction, a linkage key's name, a linkage field's name (with
 * the keys citing it), and the legal agreement's reference and purpose. The
 * inviting party's identity is left plain because the decode refuses one holding
 * key material. The declared `receive` names the column {@link armoredFixture}
 * discloses, so the acceptance renders it in this party's own outbound set too.
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

  test("handler: an armored inviting-party identity is refused at the decode", async () => {
    // The other rendered partner value the fixture above cannot plant. The
    // surface would have shown the redaction marker where the partner names
    // itself, which a reader cannot tell from a marker Alcove placed, so the
    // decode refuses the invitation and the refusal reaches the operator
    // redacted.
    const base = sampleToken(FUTURE());
    const crafted = await encodeRaw({
      ...base,
      linkageTerms: { ...base.linkageTerms, identity: ARMORED_IDENTITY },
    });
    const err = await decodeAndValidateInvitation(crafted).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(UsageError);
    const message = (err as Error).message;
    expect(message).toContain("identity");
    expect(redactPrivateKeyMaterial(message)).toBe(message);
    for (const body of ARMOR_BODIES) expect(message).not.toContain(body);
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
      // validation, so the hostile code points ride the one field a decoded token
      // can still hold them in: a transform param value, a data value the schema
      // length-bounds and holds to no character rule. Everything else is out --
      // every name is held to NAME_SHAPE_PATTERN, and the identity, the purpose
      // and a payload description refuse the control characters and the bidi
      // override alike.
      const encoded = await encodeInvitation({
        ...sampleToken(FUTURE()),
        linkageTerms: {
          ...sampleTerms("InviterOrg"),
          linkageKeys: [
            {
              name: "ssn",
              elements: [
                {
                  field: "ssn",
                  transform: [
                    {
                      function: "replace_regex",
                      params: {
                        pattern: "-",
                        replacement: `${BEL}${ESC}[31m${RLO}`,
                      },
                    },
                  ],
                },
              ],
            },
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
        $0: "alcove",
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
        connection: {
          channel: "filedrop",
          path: platformAbsolutePath("/mnt/share"),
        },
      });
      for (const disclosed of [["diagnosis", "notes"], undefined]) {
        runOnlineBootstrapMock.mockClear();
        const encoded = await encodeInvitation({
          ...sampleToken(FUTURE()),
          disclosedPayloadColumns: disclosed,
        });
        await acceptHandler({
          _: [],
          $0: "alcove",
          identity: "Agency B",
          args: [platformFileUrl("/mnt/share").href, encoded, input],
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
      $0: "alcove",
      identity: "Agency B",
      args: params.input !== undefined ? [encoded, params.input] : [encoded],
      "consent-to-terms": true,
      "config-file": params.configFile,
      "key-file": path.join(path.dirname(params.configFile), ".alcove.key"),
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
    // field here would rename the party for every later `alcove exchange`, out of
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

// --- offline accept-reuse refreshes the invitation's relay -----------------------

describe("handler: offline accept-reuse refreshes the invitation's relay", () => {
  const OWN_TURN = [
    {
      url: "turns:own-relay.example.org:443?transport=tcp",
      username: "own-user",
      credential: "own-credential",
    },
  ];
  const OWN_STUN = ["stun:own-stun.example.org:3478"];
  const NEW_RELAY = {
    turn: ["turns:new-relay.example.org:443?transport=tcp"],
    stun: ["stun:new-relay.example.org:3478"],
  };

  function writeKeptWebrtcConfig(
    configFile: string,
    invitationRelay?: { turn?: string[]; stun?: string[] },
  ): void {
    writeExistingConfig(configFile, {
      connection: {
        channel: "webrtc",
        server: { host: "peer.example.org", path: "/psi" },
        role: "acceptor",
        turn: OWN_TURN,
        stun: OWN_STUN,
        ...(invitationRelay !== undefined ? { invitationRelay } : {}),
      },
    });
  }

  async function acceptOver(
    fixture: ReturnType<typeof offlineAcceptFixture>,
    relay: { turn?: string[]; stun?: string[] } | undefined,
  ): Promise<{ connection: ConnectionConfig; stderr: string }> {
    const encoded = await encodeInvitation(
      sampleToken(FUTURE(), {
        ...WEBRTC_ENDPOINT,
        ...(relay !== undefined ? { relay } : {}),
      }),
    );
    const { stderrWrites } = await runOfflineAcceptCapturingStdio({
      encoded,
      fixture,
      flags: { "consent-to-terms": true },
    });
    const raw = fs.readFileSync(fixture.configFile, "utf8");
    return {
      connection: parseExchangeSpec(YAML.parse(raw)).connection,
      stderr: stderrWrites.join(""),
    };
  }

  test("handler: a kept configuration takes the relay the invitation names", async () => {
    const fixture = offlineAcceptFixture();
    try {
      writeKeptWebrtcConfig(fixture.configFile, {
        turn: ["turns:stale-relay.example.org:443"],
      });
      const { connection, stderr } = await acceptOver(fixture, NEW_RELAY);
      expect(connection).toMatchObject({
        channel: "webrtc",
        invitationRelay: NEW_RELAY,
        turn: OWN_TURN,
        stun: OWN_STUN,
      });
      expect(stderr).toContain(
        "its invitation_relay is set to the relay this invitation names",
      );
    } finally {
      fs.rmSync(fixture.dir, { recursive: true, force: true });
    }
  });

  test("handler: a kept configuration's stale relay is removed when the invitation names none", async () => {
    const fixture = offlineAcceptFixture();
    try {
      writeKeptWebrtcConfig(fixture.configFile, {
        turn: ["turns:stale-relay.example.org:443"],
      });
      const { connection, stderr } = await acceptOver(fixture, undefined);
      expect(connection).toMatchObject({
        channel: "webrtc",
        turn: OWN_TURN,
        stun: OWN_STUN,
      });
      expect(connection).not.toHaveProperty("invitationRelay");
      expect(stderr).toContain(
        "its invitation_relay is removed, since this invitation names no relay",
      );
    } finally {
      fs.rmSync(fixture.dir, { recursive: true, force: true });
    }
  });
});

// --- the acceptance's terms-side commitment reaches the config ------------------

describe("the acceptance's terms-side commitment reaches the config", () => {
  test("handler: offline accept writes the invitation's declared deduplicate to the config", async () => {
    // Offline accept writes a config and stops, so the binding the invitation
    // declared has to reach DISK or the later `alcove exchange` holds the partner
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
          $0: "alcove",
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
          $0: "alcove",
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
  const dir = fs.mkdtempSync(path.join(tmpdir(), "alcove-accept-lockin-"));
  const configFile = path.join(dir, "alcove.yaml");
  const keyFile = path.join(dir, ".alcove.key");
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
    // earlier acceptance, so a name planted to disturb the terminal must not
    // reach the operator raw when this warning reads it back out. A zero-width
    // joiner rather than an ESC: the recorded list holds the name shape, which
    // refuses a control character outright (the case below), and the joiner is
    // outside that class and still needs escaping here.
    const hostile = "notes\u200d[0m";
    const warnings = await reuseLockInWarnings({
      recorded: [hostile],
      disclosed: undefined,
      loggerName: "accept-lockin-drop-escaping",
    });
    const dropped = droppedLockInWarning(warnings);
    expect(dropped).toContain(sanitizeForDisplay(hostile));
    expect(dropped).not.toContain("\u200d");
  });

  test("validateAccept: a recorded commitment holding the name class is refused", async () => {
    // The class the header read strips and every name field refuses cannot sit
    // in the recorded set either: the config read this reuse path makes holds
    // the list to the same shape, so the acceptance stops at the config rather
    // than warning about a name no honest writer could have put there. The
    // refusal names the field and prints none of the value.
    await expect(
      reuseLockInWarnings({
        recorded: [`notes${ESC}[0m`],
        disclosed: undefined,
        loggerName: "accept-lockin-drop-refused",
      }),
    ).rejects.toThrow(/expected_payload_columns\.0: a linkage terms name/);
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
      $0: "alcove",
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
        $0: "alcove",
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
        $0: "alcove",
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
        $0: "alcove",
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

// --- kept configuration in a read-only directory -------------------------------

test.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
  "handler: an accept keeping a config in a read-only directory writes no key, and the rerun succeeds",
  async () => {
    const root = fs.mkdtempSync(path.join(tmpdir(), "alcove-accept-ro-"));
    const confDir = path.join(root, "conf");
    fs.mkdirSync(confDir);
    const configFile = path.join(confDir, "alcove.yaml");
    const keyFile = path.join(root, ".alcove.key");
    const input = path.join(root, "input.csv");
    fs.writeFileSync(
      input,
      "first_name,last_name,dob,ssn\nAlice,Smith,1990-01-02,123456789\n",
    );
    writeExistingConfig(configFile);
    const encoded = await encodeInvitation({
      ...sampleToken(new Date(Date.now() + 3_600_000).toISOString()),
      disclosedPayloadColumns: ["diagnosis"],
    });
    const accept = () =>
      acceptHandler({
        _: [],
        $0: "alcove",
        args: [encoded, input],
        "consent-to-terms": true,
        "config-file": configFile,
        "key-file": keyFile,
        "log-level": "silent",
        record: false,
      } as unknown as Arguments);
    const exitSpy = captureProcessExit();
    const stdio = captureStdio();
    try {
      fs.chmodSync(confDir, 0o555);
      try {
        await expect(accept()).rejects.toThrow(/exit:/);
      } finally {
        fs.chmodSync(confDir, 0o755);
      }
      expect(fs.existsSync(keyFile)).toBe(false);
      await accept();
      expect(exitSpy).not.toHaveBeenCalledWith(64);
      expect(fs.existsSync(keyFile)).toBe(true);
      expect(
        parseExchangeSpec(YAML.parse(fs.readFileSync(configFile, "utf8")))
          .expectedPayloadColumns,
      ).toEqual(["diagnosis"]);
    } finally {
      stdio.restore();
      exitSpy.mockRestore();
      fs.rmSync(root, { recursive: true, force: true });
    }
  },
);
