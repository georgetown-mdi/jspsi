#!/usr/bin/env node
// WebRTC provider_options unread claim check, run by static_checks.yaml.
//
// docs/spec/WEBRTC_TRANSPORT.md (ICE) and docs/EXCHANGE_REFERENCE.md
// (`### connection.provider_options`) state that `connection.provider_options`
// is inert on the `webrtc` channel: no transport on either side reads it, so no
// key in it reaches the PeerJS client, the peer connection, or the ICE
// configuration. That is a "does not happen at runtime" claim -- prose asserting
// a runtime fact rots silently the day a WebRTC consumer of the map is added --
// so it is encoded here instead: every listed WebRTC source is parsed and
// scanned for a read of the option, and the check fails the moment one appears.
//
// It is also what makes the SFTP-only default-deny `provider_options` allowlist
// (docs/EXCHANGE_REFERENCE.md, same section) a safe place to stop: the day a
// WebRTC transport does read the map, this check reddens before that transport
// ships with no allowlist of its own.
//
// THE SCANNED SET IS THE CLAIM (the scripts/lib/sftpAdapterSites.mjs precedent):
// a WebRTC source this list does not name is unexamined, not cleared. It has two
// halves.
//
//   - CLI_FILES: every file under apps/cli/src/connection/webrtc/, the whole
//     WebRTC connection implementation for the command-line party. Held to the
//     directory's real listing below, so an added or removed file fails the
//     check rather than silently changing what "every file" means.
//   - WEB_FILES: the three sources the issue names (rendezvous.ts,
//     managedRendezvous.ts, peerMessageConnection.ts) plus their first-party
//     neighbours -- every local module (relative or `@utils/*`) any of the
//     three imports, one hop out, value or type-only alike. That hop is read
//     from the import statements themselves (see the file lists below), not
//     guessed; a neighbour that itself imports further local modules is not
//     followed a second hop.
//
// WHAT A "READ" MATCHES, and what it cannot:
//
//   - Matched: a property access (`x.providerOptions`, optional chaining
//     included), a bracket access keyed by the literal
//     (`x["provider_options"]`), and a destructured binding naming either
//     spelling as the source key -- a plain `{ providerOptions }`, a renamed
//     `{ providerOptions: opts }`, or the same in a function parameter. Both
//     spellings are watched: the camelCase name the parsed exchange spec holds
//     it under at runtime, and the snake_case name the document and an
//     unnormalized parse use.
//   - Not matched, by construction of an AST walk: a mention inside a comment or
//     a string/template literal that is not itself the destructured key or the
//     bracket literal -- a doc string or a log message naming the option is not
//     a read of it.
//   - Not matched, as a stated limit: a dynamic key (`x[computedKeyVar]`, or a
//     computed destructuring key), and a re-export under another name
//     (`export { providerOptions as somethingElse }`, whose specifier nodes are
//     identifiers rather than the property-access or destructuring shapes
//     above). Neither writes the name in a shape this scan reads.

import ts from "typescript";
import { fileURLToPath } from "node:url";

import {
  descendants,
  parseSource,
  readSource,
  sourceModules,
} from "./lib/typeScriptSources.mjs";

/** The CLI's whole WebRTC connection implementation. */
const CLI_WEBRTC_DIR = "apps/cli/src/connection/webrtc";

/** `CLI_WEBRTC_DIR`'s files, repository-relative, held to the real listing. */
const CLI_FILES = [
  "apps/cli/src/connection/webrtc/brokerClient.ts",
  "apps/cli/src/connection/webrtc/inboundBounds.ts",
  "apps/cli/src/connection/webrtc/peerjsWire.ts",
  "apps/cli/src/connection/webrtc/webrtcMessageConnection.ts",
  "apps/cli/src/connection/webrtc/weriftPeer.ts",
];

/**
 * The three named entry points plus every first-party module they import, one
 * hop, read off their import statements: rendezvous.ts imports
 * waitForConnection.ts, peerLogging.ts, @utils/diagnostics, and
 * @utils/clientConfig; managedRendezvous.ts imports rendezvous.ts,
 * invitationLocation.ts, invitation.ts, and (type-only) managedExchangeRecord.ts;
 * peerMessageConnection.ts imports boundedReassembly.ts, peerLogging.ts,
 * waitForOpen.ts, and waitForPeerClose.ts.
 */
const WEB_FILES = [
  "apps/web/src/psi/rendezvous.ts",
  "apps/web/src/psi/managedRendezvous.ts",
  "apps/web/src/psi/peerMessageConnection.ts",
  "apps/web/src/psi/waitForConnection.ts",
  "apps/web/src/psi/peerLogging.ts",
  "apps/web/src/psi/invitationLocation.ts",
  "apps/web/src/psi/invitation.ts",
  "apps/web/src/psi/managedExchangeRecord.ts",
  "apps/web/src/psi/boundedReassembly.ts",
  "apps/web/src/psi/waitForOpen.ts",
  "apps/web/src/psi/waitForPeerClose.ts",
  "apps/web/src/utils/diagnostics.ts",
  "apps/web/src/utils/clientConfig.ts",
];

/** The property/key names a read is watched for, in both spellings. */
const TARGET_NAMES = new Set(["providerOptions", "provider_options"]);

/**
 * Every read of `providerOptions` / `provider_options` in `sourceFile`, as
 * `{line, text}` pairs, in source order. See the module header for the exact
 * shapes matched.
 */
export function providerOptionsReads(sourceFile) {
  const found = [];
  const record = (node) => {
    const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart());
    found.push({ line: line + 1, text: node.getText() });
  };
  for (const node of descendants(sourceFile)) {
    if (
      ts.isPropertyAccessExpression(node) &&
      TARGET_NAMES.has(node.name.text)
    ) {
      record(node);
      continue;
    }
    if (
      ts.isElementAccessExpression(node) &&
      ts.isStringLiteralLike(node.argumentExpression) &&
      TARGET_NAMES.has(node.argumentExpression.text)
    ) {
      record(node);
      continue;
    }
    if (ts.isBindingElement(node) && ts.isObjectBindingPattern(node.parent)) {
      const key = node.propertyName ?? node.name;
      if (
        (ts.isIdentifier(key) || ts.isStringLiteral(key)) &&
        TARGET_NAMES.has(key.text)
      )
        record(node);
    }
  }
  return found;
}

/**
 * Where `dir`'s real directory listing differs from `files`, which must be
 * exactly that listing, repository-relative: names on disk `files` does not
 * list ("added" -- a real coverage gap, an unscanned new file) and names
 * `files` lists that are no longer on disk ("removed" -- the list still
 * promises to scan something gone). Both must be empty for the explicit list to
 * still BE the directory.
 */
export function directoryDrift(dir, files) {
  const onDisk = new Set(sourceModules(dir));
  const listed = new Set(files);
  return {
    added: [...onDisk].filter((file) => !listed.has(file)).sort(),
    removed: [...listed].filter((file) => !onDisk.has(file)).sort(),
  };
}

// CLI entry: only runs when invoked directly, so the test can import the pure
// functions without the process.exit.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const failures = [];

  const { added, removed } = directoryDrift(CLI_WEBRTC_DIR, CLI_FILES);
  for (const file of added)
    failures.push(
      `${file}: on disk under ${CLI_WEBRTC_DIR} but not in CLI_FILES -- add it to scripts/check-webrtc-provider-options-unread.mjs, or this new file is never scanned.`,
    );
  for (const file of removed)
    failures.push(
      `${file}: listed in CLI_FILES but no longer on disk -- it moved or was renamed; update scripts/check-webrtc-provider-options-unread.mjs to follow it.`,
    );

  const scanned = [];
  for (const file of [...CLI_FILES, ...WEB_FILES]) {
    let source;
    try {
      source = readSource(file);
    } catch (error) {
      if (error.code === "ENOENT") {
        failures.push(
          `${file}: no longer exists -- it moved or was renamed; update scripts/check-webrtc-provider-options-unread.mjs to follow it.`,
        );
        continue;
      }
      throw error;
    }
    scanned.push(file);
    const sourceFile = parseSource(file, source);
    for (const { line, text } of providerOptionsReads(sourceFile))
      failures.push(
        `${file}:${line}: reads \`${text}\` -- connection.provider_options is documented as inert on the webrtc channel (docs/spec/WEBRTC_TRANSPORT.md, ICE); either this read is a bug, or the claim and this check both need to change together.`,
      );
  }

  if (failures.length > 0) {
    for (const failure of failures) console.error(failure);
    process.exit(1);
  }
  console.log(
    `WebRTC provider_options unread check passed: no read of providerOptions/provider_options in ${scanned.length} scanned file(s):\n${scanned.map((file) => `  ${file}`).join("\n")}`,
  );
}
