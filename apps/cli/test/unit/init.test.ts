import fs from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, expect, test, vi } from "vitest";
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
} from "../../src/configTemplate";
import {
  buildTemplateData,
  decideOverwrite,
  handler as initHandler,
  resolveInitInput,
} from "../../src/commands/init";
import { streamOf, ttyStream, withStdin } from "../stdinStream";

// promptConfirm is mocked so the handler's interactive overwrite branch is
// deterministic; everything else in util/cli stays real.
vi.mock("../../src/util/cli", async () => {
  const actual =
    await vi.importActual<typeof import("../../src/util/cli")>(
      "../../src/util/cli",
    );
  return { ...actual, promptConfirm: vi.fn() };
});
const { promptConfirm } = await import("../../src/util/cli");
const promptConfirmMock = vi.mocked(promptConfirm);

// writeFileOwnerOnly is wrapped in a spy that delegates to the real impl, so most
// tests write for real and the fail-closed test can force a FileExistsError (the
// post-decision race) without an actual filesystem race.
vi.mock("../../src/fileUtils", async () => {
  const actual = await vi.importActual<typeof import("../../src/fileUtils")>(
    "../../src/fileUtils",
  );
  return { ...actual, writeFileOwnerOnly: vi.fn(actual.writeFileOwnerOnly) };
});
const { writeFileOwnerOnly, FileExistsError } =
  await import("../../src/fileUtils");
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

afterEach(() => {
  for (const dir of tmpDirs.splice(0))
    fs.rmSync(dir, { recursive: true, force: true });
  promptConfirmMock.mockReset();
  // Clear call history but keep writeFileOwnerOnly delegating to the real impl
  // (a mockReset would strip that and silently no-op every later write).
  writeFileOwnerOnlyMock.mockClear();
  vi.restoreAllMocks();
});

// --- renderConfigTemplate: a no-input template -------------------------------

test("renderConfigTemplate: every exchange-spec section is represented", async () => {
  const template = renderConfigTemplate(
    await buildTemplateData(undefined, "Org", log),
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
  // Opt-in sections that carry no default are commented out, not active.
  expect(template).toContain("# authentication:");
  expect(template).toContain("# signing:");
  expect(template).toContain("# retention_disposition:");
  expect(template).toContain("# expected_payload_columns:");
  // With no input file, metadata/standardization are documented as commented
  // examples rather than written active.
  expect(template).toContain("# metadata:");
  expect(template).toContain("# standardization:");
});

test("renderConfigTemplate: defaults are pre-filled and the active body parses", async () => {
  const data = await buildTemplateData(undefined, "Org", log);
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
  const data = await buildTemplateData(file, "Org", log);
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
  const template = renderConfigTemplate(
    await buildTemplateData(file, "Org", log),
  );
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
    renderConfigTemplate(await buildTemplateData(undefined, "Org", log)),
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
  const data = await buildTemplateData(undefined, "Org", log);
  expect(data.metadata).toBeUndefined();
  expect(data.standardization).toBeUndefined();
  expect(data.linkageTerms.identity).toBe("Org");
  expect(data.linkageTerms.linkageKeys.length).toBeGreaterThan(0);
});

test("buildTemplateData: a file input infers metadata, fields, and standardization", async () => {
  const dir = scratchDir();
  const file = path.join(dir, "in.csv");
  fs.writeFileSync(file, SAMPLE_CSV);
  const data = await buildTemplateData(file, "Org", log);
  expect(data.metadata?.map((m) => m.name)).toContain("ssn");
  expect(data.standardization?.map((s) => s.output)).toContain("ssn");
});

test("buildTemplateData: `-` reads the CSV from stdin", async () => {
  const data = await withStdin(streamOf(SAMPLE_CSV), () =>
    buildTemplateData("-", "Org", log),
  );
  expect(data.metadata?.map((m) => m.name)).toContain("ssn");
});

test("buildTemplateData: `-` at an interactive terminal with nothing piped is a usage error", async () => {
  await withStdin(ttyStream(), async () => {
    await expect(buildTemplateData("-", "Org", log)).rejects.toBeInstanceOf(
      UsageError,
    );
    await expect(buildTemplateData("-", "Org", log)).rejects.toThrow(/stdin/);
  });
});

test("buildTemplateData: an unreadable input file is a usage error (exit 64)", async () => {
  await expect(
    buildTemplateData("/nonexistent/psilink-init-input.csv", "Org", log),
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

function argvFor(overrides: Record<string, unknown>): Arguments {
  return { _: [], $0: "psilink", ...overrides } as unknown as Arguments;
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
  // (path free), but a file appears before the write. writeFileOwnerOnly surfaces
  // that as FileExistsError, which the handler must map to a fail-closed usage
  // error rather than clobber. Forced via the write mock since a real filesystem
  // race is not reproducible in a unit test.
  const dir = scratchDir();
  const configFile = path.join(dir, "psilink.yaml");
  writeFileOwnerOnlyMock.mockImplementationOnce(() => {
    throw new FileExistsError(configFile);
  });
  const logErr = vi
    .spyOn(getLogger("init"), "error")
    .mockImplementation(() => {});
  const exit = vi
    .spyOn(process, "exit")
    .mockImplementation((() => {}) as never);

  await initHandler(argvFor({ "config-file": configFile }));

  expect(exit).toHaveBeenCalledWith(64);
  expect(logErr).toHaveBeenCalledWith(
    expect.stringContaining("after the overwrite check"),
  );
  logErr.mockRestore();
});

test("handler: an existing file with no terminal fails closed (exit 64), unchanged", async () => {
  const dir = scratchDir();
  const configFile = path.join(dir, "psilink.yaml");
  fs.writeFileSync(configFile, "old contents\n");
  const logErr = vi
    .spyOn(getLogger("init"), "error")
    .mockImplementation(() => {});
  const exit = vi
    .spyOn(process, "exit")
    .mockImplementation((() => {}) as never);

  // vitest's process.stdin is not a TTY, so the handler cannot prompt.
  await initHandler(argvFor({ "config-file": configFile }));

  expect(exit).toHaveBeenCalledWith(64);
  expect(fs.readFileSync(configFile, "utf8")).toBe("old contents\n");
  logErr.mockRestore();
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

  await withInteractiveStdin(async () => {
    await initHandler(argvFor({ "config-file": configFile }));
  });

  expect(exit).not.toHaveBeenCalled();
  const written = fs.readFileSync(configFile, "utf8");
  expect(written).not.toBe("old contents\n");
  expect(written).toContain("linkage_terms:");
});

test("handler: a malformed input file exits 64", async () => {
  const dir = scratchDir();
  const configFile = path.join(dir, "psilink.yaml");
  const logErr = vi
    .spyOn(getLogger("init"), "error")
    .mockImplementation(() => {});
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
  logErr.mockRestore();
});

test("handler: an unrecognized --log-level exits 64", async () => {
  const dir = scratchDir();
  const logErr = vi
    .spyOn(getLogger("init"), "error")
    .mockImplementation(() => {});
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
  logErr.mockRestore();
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
