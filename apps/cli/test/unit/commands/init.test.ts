import fs from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { Arguments } from "yargs";
import YAML from "yaml";
import {
  ExchangeSpecSchema,
  StandardizationSchema,
  UsageError,
  getLogger,
  parseExchangeSpec,
  safeParseMetadata,
} from "@psilink/core";

import {
  FIELD_DOCS,
  INFERRED_SECTIONS_HINT,
  OPTIONAL_SECTIONS,
  renderConfigTemplate,
} from "../../../src/configTemplate";
import {
  buildTemplateData,
  decideOverwrite,
  handler as initHandler,
  resolveInitInput,
} from "../../../src/commands/init";
import { buildDataSpec, loadInputRows } from "../../../src/onlineBootstrap";
import {
  IDENTITY_PROMPT_PREAMBLE,
  INIT_IDENTITY_QUESTION,
  optionalIdentity,
  PLACEHOLDER_IDENTITY,
  resolveIdentity,
  resolveInvitationIdentity,
} from "../../../src/partyIdentity";
import { captureStdio } from "../../loggingTestSupport";
import { streamOf, ttyStream, withStdin } from "../../stdinStream";

// Both terminal reads are mocked so the handler's interactive branches are
// deterministic -- neither the overwrite confirmation nor the identity question
// drives a real readline over the test runner's stdin; everything else stays
// real.
vi.mock("../../../src/util/prompt", async () => {
  const actual = await vi.importActual<
    typeof import("../../../src/util/prompt")
  >("../../../src/util/prompt");
  return { ...actual, promptConfirm: vi.fn(), promptFreeText: vi.fn() };
});
const { promptConfirm, promptFreeText } =
  await import("../../../src/util/prompt");
const promptConfirmMock = vi.mocked(promptConfirm);
const promptFreeTextMock = vi.mocked(promptFreeText);

// writeFileOwnerOnly is wrapped in a spy that delegates to the real impl, so most
// tests write for real and the fail-closed test can force a FileExistsError (the
// post-decision race) without an actual filesystem race.
vi.mock("../../../src/fileUtils", async () => {
  const actual = await vi.importActual<typeof import("../../../src/fileUtils")>(
    "../../../src/fileUtils",
  );
  return { ...actual, writeFileOwnerOnly: vi.fn(actual.writeFileOwnerOnly) };
});
const { writeFileOwnerOnly, FileExistsError } =
  await import("../../../src/fileUtils");
const writeFileOwnerOnlyMock = vi.mocked(writeFileOwnerOnly);

const log = getLogger("init");
log.setLevel("silent");

const tmpDirs: string[] = [];
function scratchDir(): string {
  const dir = fs.mkdtempSync(path.join(tmpdir(), "psilink-init-"));
  tmpDirs.push(dir);
  return dir;
}

const SAMPLE_CSV =
  "first_name,last_name,dob,ssn,member_id\n" +
  "Alice,Smith,1990-01-02,123456789,M-1\n";

beforeEach(() => {
  // An unanswered question by default: the identity prompt resolves blank, which
  // is the placeholder-writing path every test that is not about the question
  // itself expects, whatever the runner's own stdin reports.
  promptFreeTextMock.mockResolvedValue("");
});

afterEach(() => {
  for (const dir of tmpDirs.splice(0))
    fs.rmSync(dir, { recursive: true, force: true });
  promptConfirmMock.mockReset();
  promptFreeTextMock.mockReset();
  // Clear call history but keep writeFileOwnerOnly delegating to the real impl
  // (a mockReset would strip that and silently no-op every later write).
  writeFileOwnerOnlyMock.mockClear();
  vi.restoreAllMocks();
});

// --- renderConfigTemplate: a no-input template -------------------------------

test("renderConfigTemplate: every exchange-spec section is represented", async () => {
  const template = renderConfigTemplate(
    await buildTemplateData(undefined, "Org"),
  );

  // The drift guard: every top-level ExchangeSpec section must appear in the
  // template, active or commented. A new section added to the schema fails this
  // until the template documents it (the spec-sync requirement in the issue).
  for (const camelKey of Object.keys(ExchangeSpecSchema.shape)) {
    const snakeKey = camelKey.replace(/([A-Z])/g, (m) => `_${m.toLowerCase()}`);
    expect(template, `section ${snakeKey} missing from template`).toContain(
      `${snakeKey}:`,
    );
  }
  // Opt-in sections that have no default are commented out, not active.
  expect(template).toContain("# authentication:");
  expect(template).toContain("# signing:");
  expect(template).toContain("# retention_disposition:");
  expect(template).toContain("# expected_payload_columns:");
  expect(template).toContain("# disclosed_payload_columns:");
  expect(template).toContain("# expected_partner_deduplicate:");
  // With no input file, metadata/standardization are documented as commented
  // examples rather than written active.
  expect(template).toContain("# metadata:");
  expect(template).toContain("# standardization:");
});

test("renderConfigTemplate: defaults are pre-filled and the active body parses", async () => {
  const data = await buildTemplateData(undefined, "Org");
  const template = renderConfigTemplate(data);

  // Comments are stripped on parse, so the active body must round-trip through
  // the live schema -- this is what catches a structural drift in the sections
  // init writes.
  const parsed = parseExchangeSpec(YAML.parse(template));
  expect(parsed.connection.channel).toBe("sftp");
  expect(parsed.linkageTerms.linkageStrategy).toBe("cascade");
  expect(parsed.linkageTerms.algorithm).toBe("psi");
  // No input: metadata/standardization are not written active.
  expect(parsed.metadata).toBeUndefined();
  expect(parsed.standardization).toBeUndefined();
  // Default connection options are present and pre-filled.
  expect(template).toContain("server_connect_timeout_ms: 30000");
  expect(template).toContain("port: 22");
});

test("renderConfigTemplate: an input file populates metadata and standardization", async () => {
  const dir = scratchDir();
  const file = path.join(dir, "in.csv");
  fs.writeFileSync(file, SAMPLE_CSV);
  const data = await buildTemplateData(file, "Org");
  const template = renderConfigTemplate(data);

  const parsed = parseExchangeSpec(YAML.parse(template));
  expect(parsed.metadata).toBeDefined();
  expect(parsed.standardization).toBeDefined();
  // The inferred linkage fields reflect the CSV's columns.
  expect(parsed.linkageTerms.linkageFields.map((f) => f.name)).toContain("ssn");
  expect(parsed.metadata?.some((m) => m.name === "ssn")).toBe(true);
  expect(parsed.standardization?.some((s) => s.output === "ssn")).toBe(true);
});

test("renderConfigTemplate: every FIELD_DOCS entry lands a comment in the document", async () => {
  // With an input file all documented sections (including metadata and
  // standardization) are present, so every FIELD_DOCS path must resolve and its
  // comment must appear. commentKey no-ops on a miss, so this guards against a
  // renamed field silently dropping its inline documentation.
  const dir = scratchDir();
  const file = path.join(dir, "in.csv");
  fs.writeFileSync(file, SAMPLE_CSV);
  const template = renderConfigTemplate(await buildTemplateData(file, "Org"));
  for (const { path: docPath, lines } of FIELD_DOCS) {
    expect(template, `comment for ${docPath.join(".")} missing`).toContain(
      lines[0],
    );
  }
});

test("the commented metadata/standardization hint is valid when uncommented", () => {
  // An operator who follows the no-input hint to hand-author these sections must
  // get a config the loader accepts. Drop the leading prose, un-comment the YAML
  // example, and validate each half against the real schema -- this guards the
  // class of bug where a commented example is syntactically fine but
  // schema-invalid (e.g. metadata missing the required is_payload).
  const lines = INFERRED_SECTIONS_HINT.split("\n");
  const start = lines.findIndex((l) => /^#\s*metadata:/.test(l));
  expect(start).toBeGreaterThanOrEqual(0);
  const yaml = lines
    .slice(start)
    .map((l) => l.replace(/^#\s?/, ""))
    .join("\n");
  const parsed = YAML.parse(yaml) as {
    metadata: unknown;
    standardization: unknown;
  };
  expect(safeParseMetadata(parsed.metadata).success).toBe(true);
  expect(() =>
    StandardizationSchema.parse(parsed.standardization),
  ).not.toThrow();
});

test("every commented OPTIONAL section is valid when uncommented", async () => {
  // The four opt-in sections are documented as commented YAML; an operator who
  // enables one must get a loadable config. Un-comment each example, merge it
  // onto the active base, and validate against the production schema -- the same
  // guard the metadata/standardization hint has, extended to these so a future
  // schema change (e.g. a new required field, or a strictObject rejecting a
  // typo) cannot drift the examples to invalid without a failing test.
  const base = YAML.parse(
    renderConfigTemplate(await buildTemplateData(undefined, "Org")),
  ) as Record<string, unknown>;
  for (const key of [
    "authentication",
    "signing",
    "retention_disposition",
    "expected_payload_columns",
  ]) {
    const section = YAML.parse(
      uncommentOptionalSection(OPTIONAL_SECTIONS, key),
    ) as Record<string, unknown>;
    // Guard against a vacuous pass: the extraction must actually yield the
    // section, or merging nothing onto a valid base would parse regardless.
    expect(section?.[key], `${key} not extracted`).toBeDefined();
    expect(
      () => parseExchangeSpec({ ...base, ...section }),
      `${key} invalid when uncommented`,
    ).not.toThrow();
  }
});

// --- buildTemplateData: inference --------------------------------------------

test("buildTemplateData: no input yields the default linkage terms only", async () => {
  const data = await buildTemplateData(undefined, "Org");
  expect(data.metadata).toBeUndefined();
  expect(data.standardization).toBeUndefined();
  expect(data.linkageTerms.identity).toBe("Org");
  expect(data.linkageTerms.linkageKeys.length).toBeGreaterThan(0);
});

test("buildTemplateData: the bounded read infers the same terms (incl. DOB format) as a full read", async () => {
  // The acceptance constraint: init's lighter read must author terms identical to
  // a full read of the same file. Use a non-default DOB format (MM/DD/YYYY) so the
  // date inference is doing real work, and pin metadata, linkage fields, the
  // standardization, and the inferred DOB format -- comparing init's path against
  // buildDataSpec over a full loadInputRows of the same file.
  const dir = scratchDir();
  const file = path.join(dir, "in.csv");
  fs.writeFileSync(
    file,
    "first_name,last_name,dob,ssn\n" +
      "Alice,Smith,03/14/1990,123456789\n" +
      "Bob,Jones,11/02/1985,234567891\n",
  );
  const data = await buildTemplateData(file, "Org");
  const full = buildDataSpec({
    identity: "Org",
    rows: await loadInputRows(file),
  });

  expect(data.metadata).toEqual(full.metadata);
  expect(data.linkageTerms.linkageFields).toEqual(
    full.linkageTerms.linkageFields,
  );
  expect(data.standardization).toEqual(full.standardization);
  const parseDate = (data.standardization ?? [])
    .flatMap((s) => s.steps ?? [])
    .find((s) => s.function === "parse_date");
  expect(
    (parseDate?.params as { inputFormat?: string } | undefined)?.inputFormat,
  ).toBe("MM/DD/YYYY");
});

test("buildTemplateData: `-` reads the CSV from stdin", async () => {
  const data = await withStdin(streamOf(SAMPLE_CSV), () =>
    buildTemplateData("-", "Org"),
  );
  expect(data.metadata?.map((m) => m.name)).toContain("ssn");
});

test("buildTemplateData: `-` at an interactive terminal with nothing piped is a usage error", async () => {
  await withStdin(ttyStream(), async () => {
    await expect(buildTemplateData("-", "Org")).rejects.toBeInstanceOf(
      UsageError,
    );
    await expect(buildTemplateData("-", "Org")).rejects.toThrow(/stdin/);
  });
});

test("buildTemplateData: an unreadable input file is a usage error (exit 64)", async () => {
  await expect(
    buildTemplateData("/nonexistent/psilink-init-input.csv", "Org"),
  ).rejects.toBeInstanceOf(UsageError);
});

// --- resolveInitInput --------------------------------------------------------

test("resolveInitInput: no positional, a file, and `-` all resolve", () => {
  expect(resolveInitInput([])).toBeUndefined();
  expect(resolveInitInput(["data.csv"])).toBe("data.csv");
  expect(resolveInitInput(["-"])).toBe("-");
});

test("resolveInitInput: a second positional is a usage error", () => {
  expect(() => resolveInitInput(["data.csv", "out.csv"])).toThrow(UsageError);
});

// --- decideOverwrite ---------------------------------------------------------

test("decideOverwrite: a free path is a create, without prompting", async () => {
  const dir = scratchDir();
  const confirm = vi.fn(async () => true);
  const decision = await decideOverwrite(path.join(dir, "psilink.yaml"), {
    interactive: true,
    confirm,
  });
  expect(decision).toBe("create");
  expect(confirm).not.toHaveBeenCalled();
});

test("decideOverwrite: an existing path is an overwrite on an interactive yes", async () => {
  const dir = scratchDir();
  const target = path.join(dir, "psilink.yaml");
  fs.writeFileSync(target, "old\n");
  const decision = await decideOverwrite(target, {
    interactive: true,
    confirm: async () => true,
  });
  expect(decision).toBe("overwrite");
});

test("decideOverwrite: declining preserves the file (skip)", async () => {
  const dir = scratchDir();
  const target = path.join(dir, "psilink.yaml");
  fs.writeFileSync(target, "old\n");
  const decision = await decideOverwrite(target, {
    interactive: true,
    confirm: async () => false,
  });
  expect(decision).toBe("skip");
});

test("decideOverwrite: an existing path with no interactive prompt fails closed (exit 64)", async () => {
  const dir = scratchDir();
  const target = path.join(dir, "psilink.yaml");
  fs.writeFileSync(target, "old\n");
  await expect(
    decideOverwrite(target, { interactive: false, confirm: async () => true }),
  ).rejects.toBeInstanceOf(UsageError);
});

// --- handler -----------------------------------------------------------------

// The handler applies its --log-level to every logger, so a run leaves the
// command's diagnostics on stderr unless it is asked for silence; default to
// silence here to keep the suite's output clean, and let a case that reads the
// command's own message override the level and capture stderr.
function argvFor(overrides: Record<string, unknown>): Arguments {
  return {
    _: [],
    $0: "psilink",
    "log-level": "silent",
    ...overrides,
  } as unknown as Arguments;
}

test("handler: writes a parseable template and no key file, then exits 0", async () => {
  const dir = scratchDir();
  const configFile = path.join(dir, "psilink.yaml");
  const exit = vi
    .spyOn(process, "exit")
    .mockImplementation((() => {}) as never);

  await initHandler(argvFor({ "config-file": configFile }));

  expect(exit).not.toHaveBeenCalled();
  expect(fs.existsSync(configFile)).toBe(true);
  // No key file is created by init.
  expect(fs.readdirSync(dir)).toEqual(["psilink.yaml"]);
  // The written file is a valid config skeleton.
  parseExchangeSpec(YAML.parse(fs.readFileSync(configFile, "utf8")));
});

test("handler: the identity it writes unasked is one no resolver accepts", async () => {
  // The drift tie, read off the written file rather than off the constant: the
  // template's own bytes have to be what the guard refuses, or a template
  // hand-edited everywhere but this field mints an invitation under it. Run
  // against a non-interactive stdin, which is what leaves the field unasked.
  const dir = scratchDir();
  const configFile = path.join(dir, "psilink.yaml");
  vi.spyOn(process, "exit").mockImplementation((() => {}) as never);

  await withStdin(streamOf(""), () =>
    initHandler(argvFor({ "config-file": configFile })),
  );

  const written = parseExchangeSpec(
    YAML.parse(fs.readFileSync(configFile, "utf8")),
  );
  const identity = written.linkageTerms.identity;
  expect(identity).toBeDefined();
  expect(() => resolveIdentity(identity)).toThrow(UsageError);
  expect(() => optionalIdentity(identity)).toThrow(UsageError);
  expect(() => resolveInvitationIdentity(identity, configFile)).toThrow(
    UsageError,
  );

  // A template written WITH --identity has the operator's own label, and
  // that one resolves -- the guard refuses the placeholder, not the field.
  const named = path.join(dir, "named.yaml");
  await withStdin(streamOf(""), () =>
    initHandler(
      argvFor({ "config-file": named, identity: "Jane Smith, Agency A" }),
    ),
  );
  const namedTerms = parseExchangeSpec(
    YAML.parse(fs.readFileSync(named, "utf8")),
  ).linkageTerms;
  expect(resolveInvitationIdentity(namedTerms.identity, named)).toBe(
    "Jane Smith, Agency A",
  );
});

test("handler: at a terminal with no --identity, it asks and writes the answer", async () => {
  const dir = scratchDir();
  const configFile = path.join(dir, "psilink.yaml");
  promptFreeTextMock.mockResolvedValue("  Jane Smith, Agency A  ");
  const exit = vi
    .spyOn(process, "exit")
    .mockImplementation((() => {}) as never);
  const { stdoutWrites, stderrWrites, restore } = captureStdio();

  await withStdin(ttyStream(), () =>
    initHandler(argvFor({ "config-file": configFile })),
  );

  restore();
  expect(exit).not.toHaveBeenCalled();
  expect(promptFreeTextMock).toHaveBeenCalledTimes(1);
  expect(promptFreeTextMock).toHaveBeenCalledWith(INIT_IDENTITY_QUESTION);
  // Why psilink asks rather than naming the party itself, on the terminal the
  // question is asked on -- and never on stdout, which holds result data.
  expect(stderrWrites.join("")).toContain(IDENTITY_PROMPT_PREAMBLE);
  expect(stdoutWrites.join("")).toBe("");
  const { identity } = parseExchangeSpec(
    YAML.parse(fs.readFileSync(configFile, "utf8")),
  ).linkageTerms;
  // Trimmed as a flag value is, and a label the resolvers take: the answer the
  // operator typed is what a later `psilink invite` over this file mints under.
  expect(identity).toBe("Jane Smith, Agency A");
  expect(resolveInvitationIdentity(identity, configFile)).toBe(
    "Jane Smith, Agency A",
  );
});

test("handler: with no terminal it asks nothing and writes the placeholder", async () => {
  // The unattended path -- a pipe, a container run without -t, CI -- is
  // untouched by the question: nothing is asked and the scaffold has the
  // placeholder, so a scripted init behaves as it did before there was a prompt.
  const dir = scratchDir();
  const configFile = path.join(dir, "psilink.yaml");
  const exit = vi
    .spyOn(process, "exit")
    .mockImplementation((() => {}) as never);

  await withStdin(streamOf(""), () =>
    initHandler(argvFor({ "config-file": configFile })),
  );

  expect(exit).not.toHaveBeenCalled();
  expect(promptFreeTextMock).not.toHaveBeenCalled();
  expect(
    parseExchangeSpec(YAML.parse(fs.readFileSync(configFile, "utf8")))
      .linkageTerms.identity,
  ).toBe(PLACEHOLDER_IDENTITY);
});

test("handler: --identity at a terminal is answered by the flag, not a question", async () => {
  // The flag stays the scripted path: supplying it is what keeps the question
  // from being asked, terminal or not.
  const dir = scratchDir();
  const configFile = path.join(dir, "psilink.yaml");
  const exit = vi
    .spyOn(process, "exit")
    .mockImplementation((() => {}) as never);

  await withStdin(ttyStream(), () =>
    initHandler(argvFor({ "config-file": configFile, identity: "Agency A" })),
  );

  expect(exit).not.toHaveBeenCalled();
  expect(promptFreeTextMock).not.toHaveBeenCalled();
  expect(
    parseExchangeSpec(YAML.parse(fs.readFileSync(configFile, "utf8")))
      .linkageTerms.identity,
  ).toBe("Agency A");
});

test("handler: a blank answer leaves the placeholder to fill in by hand", async () => {
  // Blank is absence, not a label -- and init's answer to absence is the
  // scaffold it has always written, so an operator who has not settled the
  // wording still gets a template rather than a refusal.
  const dir = scratchDir();
  const configFile = path.join(dir, "psilink.yaml");
  promptFreeTextMock.mockResolvedValue("   ");
  const exit = vi
    .spyOn(process, "exit")
    .mockImplementation((() => {}) as never);
  const { restore } = captureStdio();

  await withStdin(ttyStream(), () =>
    initHandler(argvFor({ "config-file": configFile })),
  );

  restore();
  expect(exit).not.toHaveBeenCalled();
  expect(promptFreeTextMock).toHaveBeenCalledTimes(1);
  expect(
    parseExchangeSpec(YAML.parse(fs.readFileSync(configFile, "utf8")))
      .linkageTerms.identity,
  ).toBe(PLACEHOLDER_IDENTITY);
});

test("handler: the placeholder typed at the question is refused, writing nothing", async () => {
  // An answer takes the treatment a flag value takes, so the one string that is
  // not a name is refused wherever it comes from -- typing it back at the
  // question is not a way around the guard.
  const dir = scratchDir();
  const configFile = path.join(dir, "psilink.yaml");
  promptFreeTextMock.mockResolvedValue(`  ${PLACEHOLDER_IDENTITY}  `);
  const exit = vi
    .spyOn(process, "exit")
    .mockImplementation((() => {}) as never);
  const { stderrWrites, restore } = captureStdio();

  await withStdin(ttyStream(), () =>
    initHandler(argvFor({ "config-file": configFile, "log-level": "error" })),
  );

  restore();
  expect(exit).toHaveBeenCalledWith(64);
  expect(stderrWrites.join("")).toContain(PLACEHOLDER_IDENTITY);
  expect(fs.existsSync(configFile)).toBe(false);
});

test("handler: declining the overwrite asks for no identity", async () => {
  // Nothing is asked on a path that writes no file: psilink remembers an answer
  // only in the configuration it was already going to write, so a run that
  // leaves the existing one alone has nowhere to put one.
  const dir = scratchDir();
  const configFile = path.join(dir, "psilink.yaml");
  fs.writeFileSync(configFile, "old contents\n");
  promptConfirmMock.mockResolvedValue(false);
  const exit = vi
    .spyOn(process, "exit")
    .mockImplementation((() => {}) as never);

  await withStdin(ttyStream(), () =>
    initHandler(argvFor({ "config-file": configFile })),
  );

  expect(exit).not.toHaveBeenCalled();
  expect(promptConfirmMock).toHaveBeenCalled();
  expect(promptFreeTextMock).not.toHaveBeenCalled();
  expect(fs.readFileSync(configFile, "utf8")).toBe("old contents\n");
});

test("handler: --log-file is accepted and the config is still written", async () => {
  const dir = scratchDir();
  const configFile = path.join(dir, "psilink.yaml");
  const logFile = path.join(dir, "init.log");
  const exit = vi
    .spyOn(process, "exit")
    .mockImplementation((() => {}) as never);

  await initHandler(
    argvFor({ "config-file": configFile, "log-file": logFile }),
  );

  expect(exit).not.toHaveBeenCalled();
  expect(fs.existsSync(configFile)).toBe(true);
  // configureLogFile opens (creates) the file; the redirect lifecycle ran.
  expect(fs.existsSync(logFile)).toBe(true);
});

test("handler: an input file infers metadata and standardization into the file", async () => {
  const dir = scratchDir();
  const configFile = path.join(dir, "psilink.yaml");
  const input = path.join(dir, "in.csv");
  fs.writeFileSync(input, SAMPLE_CSV);
  const exit = vi
    .spyOn(process, "exit")
    .mockImplementation((() => {}) as never);

  await initHandler(argvFor({ "config-file": configFile, args: [input] }));

  expect(exit).not.toHaveBeenCalled();
  const parsed = parseExchangeSpec(
    YAML.parse(fs.readFileSync(configFile, "utf8")),
  );
  expect(parsed.metadata?.some((m) => m.name === "ssn")).toBe(true);
  expect(parsed.standardization?.some((s) => s.output === "ssn")).toBe(true);
});

test("handler: a file appearing after the check fails closed (exit 64)", async () => {
  // The post-decision exclusive-write race: decideOverwrite returns "create"
  // (path free), but a file appears before the write. writeFileOwnerOnly exposes
  // that as a FileExistsError, which the handler must map to a fail-closed usage
  // error rather than clobber. Forced via the write mock since a real filesystem
  // race is not reproducible in a unit test.
  const dir = scratchDir();
  const configFile = path.join(dir, "psilink.yaml");
  writeFileOwnerOnlyMock.mockImplementationOnce(() => {
    throw new FileExistsError(configFile);
  });
  const exit = vi
    .spyOn(process, "exit")
    .mockImplementation((() => {}) as never);
  // Read the message where the operator does: the handler's level reaches every
  // logger, so a logger method spied before the run is replaced by the one the
  // level installs.
  const { stderrWrites, restore } = captureStdio();

  await initHandler(
    argvFor({ "config-file": configFile, "log-level": "error" }),
  );

  restore();
  expect(exit).toHaveBeenCalledWith(64);
  expect(stderrWrites.join("")).toContain("after the overwrite check");
});

test("handler: an existing file with no terminal fails closed (exit 64), unchanged", async () => {
  const dir = scratchDir();
  const configFile = path.join(dir, "psilink.yaml");
  fs.writeFileSync(configFile, "old contents\n");
  const exit = vi
    .spyOn(process, "exit")
    .mockImplementation((() => {}) as never);

  // vitest's process.stdin is not a TTY, so the handler cannot prompt.
  await initHandler(argvFor({ "config-file": configFile }));

  expect(exit).toHaveBeenCalledWith(64);
  expect(fs.readFileSync(configFile, "utf8")).toBe("old contents\n");
});

test("handler: declining the interactive overwrite leaves the file untouched", async () => {
  const dir = scratchDir();
  const configFile = path.join(dir, "psilink.yaml");
  fs.writeFileSync(configFile, "old contents\n");
  promptConfirmMock.mockResolvedValue(false);
  const exit = vi
    .spyOn(process, "exit")
    .mockImplementation((() => {}) as never);

  await withInteractiveStdin(async () => {
    await initHandler(argvFor({ "config-file": configFile }));
  });

  expect(promptConfirmMock).toHaveBeenCalled();
  expect(exit).not.toHaveBeenCalled();
  expect(fs.readFileSync(configFile, "utf8")).toBe("old contents\n");
});

test("handler: confirming the interactive overwrite replaces the file", async () => {
  const dir = scratchDir();
  const configFile = path.join(dir, "psilink.yaml");
  fs.writeFileSync(configFile, "old contents\n");
  promptConfirmMock.mockResolvedValue(true);
  const exit = vi
    .spyOn(process, "exit")
    .mockImplementation((() => {}) as never);
  // The confirmed overwrite goes on to ask for the identity, which writes its
  // preamble to stderr; capture it rather than leaking it into the runner's own.
  const { restore } = captureStdio();

  await withInteractiveStdin(async () => {
    await initHandler(argvFor({ "config-file": configFile }));
  });

  restore();
  expect(exit).not.toHaveBeenCalled();
  const written = fs.readFileSync(configFile, "utf8");
  expect(written).not.toBe("old contents\n");
  expect(written).toContain("linkage_terms:");
});

test("handler: a malformed input file exits 64", async () => {
  const dir = scratchDir();
  const configFile = path.join(dir, "psilink.yaml");
  const exit = vi
    .spyOn(process, "exit")
    .mockImplementation((() => {}) as never);

  await initHandler(
    argvFor({
      "config-file": configFile,
      args: [path.join(dir, "does-not-exist.csv")],
    }),
  );

  expect(exit).toHaveBeenCalledWith(64);
  expect(fs.existsSync(configFile)).toBe(false);
});

test("handler: an unrecognized --log-level exits 64", async () => {
  const dir = scratchDir();
  const exit = vi
    .spyOn(process, "exit")
    .mockImplementation((() => {}) as never);

  await initHandler(
    argvFor({
      "config-file": path.join(dir, "psilink.yaml"),
      "log-level": "loud",
    }),
  );

  expect(exit).toHaveBeenCalledWith(64);
});

test("handler: a mistyped --flag exits 64 naming it, writing no config", async () => {
  // init sets unknown-options-as-args, so a mistyped --identit lands in the
  // positionals; it must be rejected before any file is written, not absorbed as
  // an input path.
  const dir = scratchDir();
  const configFile = path.join(dir, "psilink.yaml");
  const exit = vi
    .spyOn(process, "exit")
    .mockImplementation((() => {}) as never);
  const { stderrWrites, restore } = captureStdio();

  await initHandler(
    argvFor({
      "config-file": configFile,
      "log-level": "error",
      args: ["--identit", "x"],
    }),
  );

  restore();
  expect(exit).toHaveBeenCalledWith(64);
  expect(stderrWrites.join("")).toContain("--identit");
  expect(fs.existsSync(configFile)).toBe(false);
  expect(writeFileOwnerOnlyMock).not.toHaveBeenCalled();
});

test("handler: a `-`-leading input positional is not treated as an option", async () => {
  // A single-`-`-leading token is a positional, not an option: it reaches
  // resolveInitInput/buildTemplateData, which rejects it as an unreadable file
  // (exit 64) -- not the unknown-option path, and never a silently-dropped flag.
  const dir = scratchDir();
  const configFile = path.join(dir, "psilink.yaml");
  const exit = vi
    .spyOn(process, "exit")
    .mockImplementation((() => {}) as never);
  const { stderrWrites, restore } = captureStdio();

  await initHandler(
    argvFor({
      "config-file": configFile,
      "log-level": "error",
      args: ["-not-a-flag.csv"],
    }),
  );

  restore();
  expect(exit).toHaveBeenCalledWith(64);
  expect(stderrWrites.join("")).not.toContain("Unknown argument");
  expect(stderrWrites.join("")).toContain("-not-a-flag.csv");
});

// --- helpers -----------------------------------------------------------------

/**
 * Extract a commented section's YAML example from OPTIONAL_SECTIONS and
 * un-comment it. Sections are blank-line-separated paragraphs of prose followed
 * by a commented YAML example; the example begins at the last `# <key>:` line in
 * the paragraph (the prose may mention the key earlier) and runs to its end.
 */
function uncommentOptionalSection(block: string, key: string): string {
  const header = new RegExp(`^#\\s*${key}:`);
  const paragraph = block
    .split("\n\n")
    .find((p) => p.split("\n").some((l) => header.test(l)));
  if (paragraph === undefined)
    throw new Error(`no commented section for ${key}`);
  const lines = paragraph.split("\n");
  let start = -1;
  lines.forEach((l, i) => {
    if (header.test(l)) start = i;
  });
  return lines
    .slice(start)
    .map((l) => l.replace(/^#\s?/, ""))
    .join("\n");
}

/** Run `fn` with process.stdin reporting as an interactive terminal. */
async function withInteractiveStdin(fn: () => Promise<void>): Promise<void> {
  const original = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
  Object.defineProperty(process.stdin, "isTTY", {
    value: true,
    configurable: true,
  });
  try {
    await fn();
  } finally {
    if (original) Object.defineProperty(process.stdin, "isTTY", original);
    else
      Object.defineProperty(process.stdin, "isTTY", {
        value: undefined,
        configurable: true,
      });
  }
}
