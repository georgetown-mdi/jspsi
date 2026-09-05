#!/usr/bin/env node
// Built-in STUN default claim check, run by static_checks.yaml on every PR.
//
// A psilink run that configures no STUN or TURN server gathers ICE against the
// WebRTC library's built-in default, disclosing the running host's public
// address to whoever operates it. Three surfaces name that endpoint to an
// operator, one of them right before they hand a recurring exchange's secret to
// a scheduler: the CLI's own warning, the web app's command-line export panel,
// and the docs. Only one of them can be derived from another -- an app may not
// import from another app, and a document imports nothing -- so the rest are
// hand-written copies of a value the library, not psilink, decides. A copy left
// behind by a bump is not a typo: it is a confidentiality statement that has
// gone false, and prose cannot hold it true. So the agreement is a check.
//
// SOURCE is the one place the value is decided, and it is where the value is
// also MEASURED: the CLI owns the werift dependency, and its WebRTC integration
// suite drives a real peer with no configured list, resolves that hostname to
// loopback and watches the real STUN binding request arrive on that port. This
// check holds the copies to that constant; it says nothing about whether the
// constant is right, which only driving the library can.
//
// WHAT THIS CHECK DOES NOT COVER:
//
//   - Whether the value matches what the library does. That is the integration
//     suite's measurement (apps/cli/test/integration/webrtc/transport.test.ts),
//     re-run on every werift bump per docs/spec/DEPENDENCY_PINS.md. A check
//     reading the library's source to predict its default would be a second
//     implementation of it, which this repository does not accept.
//   - The web app's OWN ICE list (apps/web/src/psi/rendezvous.ts, described in
//     PRIVACY.md). It is a different list, for exchanges a browser runs itself,
//     and it happens to include the same Google server. Tying it here would fuse
//     two independent decisions -- what the hosted app configures, and what the
//     command-line tool falls back to -- so those files are not enumerated, by
//     design.
//   - A copy in a file no list below names. A new surface that states the
//     default is covered only once it is added to CODE_COPIES or CLAIM_TEXTS.
//   - Prose that describes the default without writing the endpoint ("the
//     built-in default STUN server"). Nothing there can drift, so nothing is
//     read; each `stated` entry must still hold at least one claim that does
//     write it, so the claim cannot be quietly dropped.
//   - A claim split across two sentences ("the built-in default is used. It is
//     `host:19302`."). A claim is read from the word "built-in" to the end of
//     its sentence, so the endpoint must sit in that sentence to be seen.

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** The constant every copy below is held to, and the file that declares it. */
const SOURCE = {
  file: "apps/cli/src/connection/webrtc/weriftPeer.ts",
  name: "WERIFT_BUILT_IN_STUN_URI",
};

/** First-party source holding its own copy because it cannot import SOURCE. */
const CODE_COPIES = [
  {
    file: "apps/web/src/bench/managedCronExportModel.ts",
    name: "CLI_BUILT_IN_STUN_URI",
  },
];

/**
 * Prose read for endpoints written as the built-in default. A `stated` file must
 * hold at least one such claim, so the sentence cannot be quietly dropped; the
 * others normally write no endpoint at all -- they interpolate a constant -- and
 * are read so that a literal written back into the prose is still held to the
 * source rather than escaping the tie by leaving the constant unused.
 */
const CLAIM_TEXTS = [
  { file: "docs/CLI.md", stated: true },
  { file: "docs/spec/DEPENDENCY_PINS.md", stated: true },
  { file: "docs/notes/cli-webrtc-stack.md", stated: true },
  { file: "apps/web/src/bench/ManagedCronExportPanel.tsx", stated: false },
];

/**
 * A STUN endpoint as either half of the spellings the copies use: the full
 * `stun:host:port` URI, or the bare `host:port` authority a sentence writes when
 * the scheme would read as noise. Matched on a host name or an IPv4 literal.
 */
const ENDPOINT =
  /(?:\bstuns?:)?((?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}|(?:\d{1,3}\.){3}\d{1,3}):(\d{2,5})\b/gi;

/** Extract the `host:port` authority a `stun:` URI names. */
export function stunAuthority(uri) {
  const match = /^stuns?:(.+)$/.exec(uri);
  return match === null ? undefined : match[1];
}

/**
 * The value a `export const <name> = "..."` declaration in `source` holds, or
 * undefined when no such declaration is there.
 */
export function declaredStringConstant(source, name) {
  const match = new RegExp(`export const ${name}\\s*=\\s*"([^"]*)"`, "u").exec(
    source,
  );
  return match === null ? undefined : match[1];
}

/**
 * How far past "built-in" a claim is read when the sentence does not end first.
 * A document states the default in one sentence; the cap keeps a paragraph whose
 * sentence boundary is unpunctuated (a list item, a heading) from swallowing an
 * unrelated endpoint further down.
 */
const CLAIM_WINDOW_CHARS = 200;

/** The 1-based line `index` falls on in `text`. */
function lineOf(text, index) {
  return text.slice(0, index).split("\n").length;
}

/**
 * Every endpoint `text` presents AS a built-in default, with its line, as
 * `{line, endpoint}` pairs normalized to the `host:port` authority. A claim is
 * read from the word "built-in" to the end of its sentence, so a document that
 * mentions the built-in default in one sentence and a `stun:` example in the
 * next (as docs/CLI.md does) yields the first and not the second, and a claim
 * that wraps across hard-wrapped lines is still read whole. A sentence naming no
 * endpoint is not a claim: it holds nothing that can drift.
 */
export function builtInDefaultClaims(text) {
  const claims = [];
  for (const anchor of text.matchAll(/built-in/gi)) {
    const rest = text.slice(anchor.index, anchor.index + CLAIM_WINDOW_CHARS);
    const sentenceEnd = /[.!?](?:\s|$)/.exec(rest);
    const window =
      sentenceEnd === null ? rest : rest.slice(0, sentenceEnd.index + 1);
    for (const match of window.matchAll(ENDPOINT))
      claims.push({
        line: lineOf(text, anchor.index),
        endpoint: `${match[1]}:${match[2]}`,
      });
  }
  return claims;
}

/**
 * The claims in `text` naming an endpoint other than `authority`. Empty when
 * every claim agrees with the source.
 */
export function claimMismatches(text, authority) {
  return builtInDefaultClaims(text).filter(
    ({ endpoint }) => endpoint.toLowerCase() !== authority.toLowerCase(),
  );
}

// CLI entry: only runs when invoked directly, so the test can import the pure
// functions without the process.exit.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const read = (file) => readFileSync(resolve(root, file), "utf8");
  const failures = [];

  const uri = declaredStringConstant(read(SOURCE.file), SOURCE.name);
  if (uri === undefined) {
    console.error(
      `${SOURCE.file}: no \`export const ${SOURCE.name} = "..."\` declaration matched -- the extraction pattern rotted, or the constant moved; fix scripts/check-stun-default-claims.mjs`,
    );
    process.exit(1);
  }
  const authority = stunAuthority(uri);
  if (authority === undefined) {
    console.error(
      `${SOURCE.file}: ${SOURCE.name} is "${uri}", which is not a stun: URI -- the copies below are compared by endpoint, so it must name one.`,
    );
    process.exit(1);
  }

  for (const copy of CODE_COPIES) {
    const declared = declaredStringConstant(read(copy.file), copy.name);
    if (declared === undefined)
      failures.push(
        `${copy.file}: no \`export const ${copy.name} = "..."\` declaration matched -- the copy moved or was renamed; update scripts/check-stun-default-claims.mjs to follow it.`,
      );
    else if (declared !== uri)
      failures.push(
        `${copy.file}: ${copy.name} is "${declared}", but ${SOURCE.file} names "${uri}". An operator is told this endpoint before handing over a secret; change both, or neither.`,
      );
  }

  for (const { file, stated } of CLAIM_TEXTS) {
    const text = read(file);
    if (stated && builtInDefaultClaims(text).length === 0)
      failures.push(
        `${file}: states no built-in STUN default any more -- if it should no longer carry that claim, drop it from CLAIM_TEXTS in scripts/check-stun-default-claims.mjs.`,
      );
    for (const { line, endpoint } of claimMismatches(text, authority))
      failures.push(
        `${file}:${line}: names built-in default "${endpoint}", but ${SOURCE.file} names "${authority}".`,
      );
  }

  if (failures.length > 0) {
    for (const failure of failures) console.error(failure);
    process.exit(1);
  }
  console.log(
    `STUN default claim check passed: ${uri} in ${SOURCE.file}, matched by ${[...CODE_COPIES.map((c) => c.file), ...CLAIM_TEXTS.map((c) => c.file)].join(", ")}.`,
  );
}
