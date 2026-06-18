import YAML, { type Document } from "yaml";
import { UsageError } from "@psilink/core";

// The single chokepoint for parsing files that may hold secrets: the operator's
// psilink.yaml (inline SFTP credentials -- server.password / privateKey /
// privateKeyPassphrase), the .psilink.key shared secret, and the signing
// identity's Ed25519 private key, all stored at 0600. The invariant these
// helpers enforce in one place is: the content of such a file must never reach
// an error message, log, or stderr -- only the path may.
//
// Centralizing matters because the parsers leak through several independent
// channels that are easy to reintroduce one call site at a time (an ESLint rule
// forbids the raw parsers outside this module, so a new reader must route here):
//
//   1. YAML.parse throws a YAMLParseError on a syntax error and a plain
//      ReferenceError on an unresolved alias; both messages embed a snippet of
//      the offending source. We never interpolate the caught error -- path only.
//   2. YAML.parseDocument collects syntax errors in doc.errors (same snippet),
//      and defers alias resolution: an unresolved alias leaves doc.errors empty
//      and throws only when the document is materialized (toString / toJS),
//      echoing the alias token. Both are guarded here.
//   3. YAML.parse / parseDocument emit NON-fatal warnings (an unresolved custom
//      tag, a bad !!int/!!float cast) via process.emitWarning -- which writes the
//      full source line to STDERR and then returns normally, so no try/catch
//      fires. logLevel "error" suppresses those warnings while still THROWING on
//      fatal errors. (logLevel "silent" would also swallow the fatal-error throw,
//      returning a mangled partial object, so it is NOT used.)
//   4. JSON.parse throws a SyntaxError that, on a non-JSON file start, echoes a
//      leading span of the source (the shared secret / private key if the file
//      leads with it). Path only.
//
// Schema validation (Zod) over the parsed value is a separate, safe layer the
// callers keep: its messages name the field, path, and format rule, never the
// value. The filesystem READ stays with the caller -- an errno carries only a
// path and code, no content, and each reader has its own ENOENT contract.

/**
 * yaml parse options for a credential-bearing file: suppress non-fatal warnings
 * (they echo source to stderr; see channel 3 above) while still throwing on
 * fatal errors.
 */
const SAFE_YAML_OPTIONS = { logLevel: "error" } as const;

/** Reason appended after the caller's path-only label; never the parser message. */
function yamlParseFailure(fileLabel: string): UsageError {
  return new UsageError(`${fileLabel} could not be parsed as YAML`);
}

/**
 * Parse YAML that may contain secrets, returning the decoded value. On any
 * failure throws a {@link UsageError} naming `fileLabel` only (which the caller
 * builds from the path), never the parser's source-bearing message. `fileLabel`
 * is a path-only descriptor such as `` `config file ${path}` ``.
 */
export function parseSensitiveYaml(source: string, fileLabel: string): unknown {
  try {
    return YAML.parse(source, SAFE_YAML_OPTIONS);
  } catch {
    throw yamlParseFailure(fileLabel);
  }
}

/**
 * Parse a YAML {@link Document} for in-place editing (preserving comments and
 * key order), for the host-key-pin write that must not rewrite the whole file.
 * Guards both the syntax-error (doc.errors) and the deferred-alias channels; the
 * returned document must be serialized via {@link serializeSensitiveYamlDocument}
 * so the alias channel stays closed at materialization too.
 */
export function parseSensitiveYamlDocument(
  source: string,
  fileLabel: string,
): Document {
  let doc: Document;
  try {
    doc = YAML.parseDocument(source, SAFE_YAML_OPTIONS);
  } catch {
    throw yamlParseFailure(fileLabel);
  }
  if (doc.errors.length > 0) throw yamlParseFailure(fileLabel);
  return doc;
}

/**
 * Serialize a {@link Document} parsed by {@link parseSensitiveYamlDocument}.
 * doc.toString() resolves aliases as it serializes; an unresolved alias throws
 * here with the alias token in its message (channel 2), so a failure reports the
 * path only.
 */
export function serializeSensitiveYamlDocument(
  doc: Document,
  fileLabel: string,
): string {
  try {
    return doc.toString();
  } catch {
    throw new UsageError(`${fileLabel} could not be serialized as YAML`);
  }
}

/**
 * Parse JSON that may contain secrets. On any failure throws a
 * {@link UsageError} naming `fileLabel` only, never the parser's message (which
 * can echo a leading span of the source -- channel 4).
 */
export function parseSensitiveJson(source: string, fileLabel: string): unknown {
  try {
    return JSON.parse(source);
  } catch {
    throw new UsageError(`${fileLabel} could not be parsed as JSON`);
  }
}
