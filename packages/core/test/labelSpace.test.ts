import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import ts from "typescript";
import { describe, expect, test } from "vitest";

import { ABORT_TOKEN_ROLES, AEAD_CONTEXTS } from "../src/auth";
import { TERMS_UPDATE_DERIVATIONS } from "../src/config/termsUpdate";
import { RENDEZVOUS_ROLES } from "../src/rendezvous";

// The domain-separation label space of docs/spec/PROTOCOL.md ("The
// domain-separation label space"). The HKDF info strings are not
// length-prefixed, so the space must be prefix-free; the three JSON-field
// domains at the end are held to it as well.
const SINGLE_LABELS: readonly string[] = [
  "alcove-shared-secret-rotation-v2",
  "alcove-relay-key-v2",
  "alcove-signed-receipt-content/v3",
  "alcove-signing-cert-signature/v2",
  "alcove-signing-cert-fingerprint/v2",
];

// Each suffix family, keyed by its prefix with the `:`, and its fixed suffix
// set. The receipt families' suffix sets have no exported constant in source.
const LABEL_FAMILIES: ReadonlyMap<string, readonly string[]> = new Map<
  string,
  readonly string[]
>([
  [
    "alcove-kex-v2:",
    ["session", "confirm", "initiator-confirm", "responder-confirm"],
  ],
  ["alcove-aead-v2:", AEAD_CONTEXTS],
  ["alcove-abort-token-v2:", ABORT_TOKEN_ROLES],
  ["alcove-webrtc-peerid-v2:", RENDEZVOUS_ROLES],
  [
    "alcove-signed-receipt-payload-v2:",
    ["initiator-to-responder", "responder-to-initiator"],
  ],
  ["alcove-signed-receipt-binder-v2:", ["initiator", "responder"]],
  ["alcove-terms-update-v2:", TERMS_UPDATE_DERIVATIONS],
]);

// alcove- strings in core's source outside the label space: the key
// exchange's protocol name (hashed into the transcript), document version
// tags, and the record-layer domains of docs/spec/EXCHANGE_RECORD.md. Listed
// exactly, so a new or changed one is placed here deliberately.
const OTHER_ALCOVE_STRINGS: readonly string[] = [
  "alcove-kex-v3:NNpsk0_P256_SHA256",
  "alcove-signed-receipt/v4",
  "alcove-signing-cert/v3",
  "alcove-signing-identity/v3",
  "alcove-exchange-record/v9",
  "alcove-exchange-keys/v2",
  "alcove-commit-association-table/v2",
  "alcove-commit-payload-sent/v2",
  "alcove-commit-payload-received/v2",
  "alcove-agreed-terms/v2",
  "alcove-signing-keypair-probe/v2",
];

const CORE_SRC = fileURLToPath(new URL("../src", import.meta.url));

interface SourceLiteral {
  /** The whole literal, or a template's fixed text before its first `${`. */
  text: string;
  interpolated: boolean;
  site: string;
}

function coreSourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return coreSourceFiles(path);
    return entry.name.endsWith(".ts") ? [path] : [];
  });
}

function alcoveLiterals(file: string): SourceLiteral[] {
  const source = ts.createSourceFile(
    file,
    readFileSync(file, "utf8"),
    ts.ScriptTarget.Latest,
    true,
  );
  const found: SourceLiteral[] = [];
  const record = (node: ts.Node, text: string, interpolated: boolean): void => {
    if (!text.startsWith("alcove-")) return;
    const { line } = source.getLineAndCharacterOfPosition(node.getStart());
    const site = `${relative(CORE_SRC, file)}:${line + 1}`;
    found.push({ text, interpolated, site });
  };
  const visit = (node: ts.Node): void => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      record(node, node.text, false);
    } else if (ts.isTemplateExpression(node)) {
      record(node, node.head.text, true);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

function displayLiteral(literal: SourceLiteral): string {
  const marker = literal.interpolated ? "${...}" : "";
  return `${literal.text}${marker} (${literal.site})`;
}

// The unit a source literal stands for in the label space, or undefined when it
// is not an enumerated member. A family member, its bare prefix, a template
// interpolating after that prefix, and the prefix's stem (composed with `:` in
// a template) all stand for the family's prefix.
function enumeratedUnit(literal: SourceLiteral): string | undefined {
  if (literal.interpolated) {
    return LABEL_FAMILIES.has(literal.text) ? literal.text : undefined;
  }
  if (SINGLE_LABELS.includes(literal.text)) return literal.text;
  if (OTHER_ALCOVE_STRINGS.includes(literal.text)) return literal.text;
  if (LABEL_FAMILIES.has(literal.text)) return literal.text;
  if (LABEL_FAMILIES.has(`${literal.text}:`)) return `${literal.text}:`;
  for (const [prefix, suffixes] of LABEL_FAMILIES) {
    if (
      literal.text.startsWith(prefix) &&
      suffixes.includes(literal.text.slice(prefix.length))
    ) {
      return prefix;
    }
  }
  return undefined;
}

const SOURCE_LITERALS = coreSourceFiles(CORE_SRC).flatMap(alcoveLiterals);

describe("the domain-separation label space", () => {
  test("every alcove- literal in core's source is enumerated", () => {
    const unlisted = SOURCE_LITERALS.filter(
      (literal) => enumeratedUnit(literal) === undefined,
    ).map(displayLiteral);
    expect(SOURCE_LITERALS.length).toBeGreaterThan(0);
    expect(unlisted).toEqual([]);
  });

  test("each family's suffix set is non-empty, colon-free and prefix-free", () => {
    const faults: string[] = [];
    for (const [prefix, suffixes] of LABEL_FAMILIES) {
      if (suffixes.length === 0) faults.push(`${prefix} has no suffixes`);
      for (const [i, a] of suffixes.entries()) {
        if (a === "" || a.includes(":")) faults.push(`${prefix}${a}`);
        for (const [j, b] of suffixes.entries()) {
          if (i !== j && b.startsWith(a)) {
            faults.push(`${prefix}${a} / ${prefix}${b}`);
          }
        }
      }
    }
    expect(faults).toEqual([]);
  });

  test("no member of the space or of core's source is a prefix of another", () => {
    const members = new Set<string>([
      ...SINGLE_LABELS,
      ...LABEL_FAMILIES.keys(),
      ...OTHER_ALCOVE_STRINGS,
      ...SOURCE_LITERALS.map(
        (literal) => enumeratedUnit(literal) ?? literal.text,
      ),
    ]);
    const clashes: string[] = [];
    for (const a of members) {
      for (const b of members) {
        if (a !== b && b.startsWith(a)) clashes.push(`${a} / ${b}`);
      }
    }
    expect(clashes).toEqual([]);
  });
});
