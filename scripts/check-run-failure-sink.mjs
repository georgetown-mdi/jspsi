#!/usr/bin/env node
// RunFailure display-sink check, run by static_checks.yaml.
//
// A `RunFailure` message is composed as a cause chain whose links are separated
// by the error renderer's own newline (`sanitizedFailureMessage` in
// apps/web/src/exchange/useInviterExchange.ts). Only a `pre-line` white-space
// style lays those newlines out as line breaks, so a render that omits it
// collapses the whole relayed chain onto one line -- readable enough to pass a
// green suite, and useless to the operator trying to tell which link failed.
// The styling therefore lives in exactly one component, `FailureMessage` in
// apps/web/src/exchange/RunSurface.tsx, and every render of a `RunFailure`
// message goes through it rather than styling a span of its own.
//
// That is a claim about every future alert, not about the two call sites
// standing today, and no type or test objects to a third one inlining its own
// span. This check is the executable form of it: a second inline span rendering
// a `RunFailure` message reddens here instead of shipping a collapsed chain.
//
// THE SCANNED SET IS EVERY SOURCE UNDER apps/web/src, walked whole rather than
// listed, so a new file is covered the moment it exists and there is no list to
// drift out of coverage. What narrows the scan to this claim is not the file
// set but the BINDINGS: a file that never annotates a name as `RunFailure`
// contributes none and is passed over. `ManagedRunFailureAlert` in
// apps/web/src/recurring/ is a different type whose message is first-party copy
// with no cause chain in it, and it renders its own span correctly outside this
// claim.
//
// HOW A BINDING IS FOUND, without a type checker. Every `RunFailure` type
// reference in the file is walked up to the nearest declaration that names
// something, and that name is taken as a `RunFailure`-valued binding for the
// rest of the file:
//
//   - a property signature or declaration -- `{ failure: RunFailure }` in a
//     destructured parameter, or the same member on a named props interface the
//     component destructures by that name;
//   - a parameter -- `(failure: RunFailure)`;
//   - a variable declaration -- `const failure: RunFailure = ...`, and the
//     `useState<RunFailure>()` shape, where the type rides the initializer's
//     type argument and the state binding is the array pattern's first element.
//
// Matching by NAME within one file is what stands in for resolution. A file
// that binds an unrelated value under a name it also annotates as `RunFailure`
// would have that unrelated value's `.message` render read as this claim's --
// a false report, and one whose fix is to read the two names apart.
//
// WHAT A "RENDER" MATCHES, and what it cannot:
//
//   - Matched: a `.message` read off a `RunFailure` binding sitting anywhere
//     inside a JSX expression container -- the `{failure.message}` child of a
//     hand-styled span, and the `message={failure.message}` attribute alike --
//     optional chaining included. The attribute of a `FailureMessage` element
//     is the one allowed position; every other container is a failure.
//   - Not matched, as a stated limit: a read that reaches JSX through a local
//     (`const text = failure.message`, `const { message } = failure`), through
//     a helper called with the failure, or through a container assembled
//     outside JSX. Following those needs the taint analysis a syntactic scan
//     cannot run. This catches the shape a contributor writes by habit -- an
//     alert inlining its own span -- and is not a proof that no `RunFailure`
//     message can render outside the sink.
//   - Not matched, by construction of an AST walk: the name inside a comment or
//     a string literal.
//
// Two vacuity guards keep a green result meaningful, since both halves of the
// claim are named by identifier here and a rename would otherwise leave this
// scanning for something that no longer exists: the `RunFailure` declaration
// and the `FailureMessage` declaration must each still stand where this check
// says, and at least one render must have been found going through the sink.

import ts from "typescript";
import { fileURLToPath } from "node:url";

import {
  descendants,
  parseFile,
  sourceModules,
} from "./lib/typeScriptSources.mjs";

/** The tree every scanned source is taken from. */
export const WEB_SOURCE_DIR = "apps/web/src";

/** The type whose message the sink below is the one render path for. */
export const FAILURE_TYPE_NAME = "RunFailure";

/** Where {@link FAILURE_TYPE_NAME} is declared, held by the vacuity guard. */
export const FAILURE_TYPE_FILE = "apps/web/src/exchange/useInviterExchange.ts";

/** The component every `RunFailure` message renders through. */
export const SINK_COMPONENT_NAME = "FailureMessage";

/** Where {@link SINK_COMPONENT_NAME} is declared, held by the vacuity guard. */
export const SINK_COMPONENT_FILE = "apps/web/src/exchange/RunSurface.tsx";

/** The sink's prop the message is passed as. */
const SINK_MESSAGE_PROP = "message";

/** The nearest ancestor of `node` a name can be read off, or undefined. */
function namingDeclaration(node) {
  for (let current = node.parent; current; current = current.parent) {
    if (
      ts.isPropertySignature(current) ||
      ts.isPropertyDeclaration(current) ||
      ts.isParameter(current) ||
      ts.isVariableDeclaration(current)
    )
      return current;
    // A function boundary ends the walk: a type reference in a return type or a
    // nested signature names nothing the body binds.
    if (ts.isFunctionLike(current)) return undefined;
  }
  return undefined;
}

/**
 * The names a declaration binds a value under: its own identifier, or -- for the
 * `useState<RunFailure>()` shape -- the first element of an array pattern, which
 * is the state value while the second is its setter.
 */
function boundNames(declaration) {
  const { name } = declaration;
  if (ts.isIdentifier(name)) return [name.text];
  if (ts.isArrayBindingPattern(name)) {
    const [first] = name.elements;
    if (first && ts.isBindingElement(first) && ts.isIdentifier(first.name))
      return [first.name.text];
  }
  return [];
}

/**
 * Every name `sourceFile` annotates as {@link FAILURE_TYPE_NAME}, by the walk
 * the module header describes. Sorted, so a failure report reads the same on
 * every run.
 */
export function failureBindingNames(sourceFile) {
  const names = new Set();
  for (const node of descendants(sourceFile)) {
    if (
      !ts.isTypeReferenceNode(node) ||
      !ts.isIdentifier(node.typeName) ||
      node.typeName.text !== FAILURE_TYPE_NAME
    )
      continue;
    const declaration = namingDeclaration(node);
    if (declaration)
      for (const name of boundNames(declaration)) names.add(name);
  }
  return [...names].sort();
}

/**
 * The name of the element whose `message` attribute `container` is the value
 * of, or undefined when the container sits in any other JSX position -- a
 * child, or another attribute.
 */
function messagePropElementName(container) {
  const attribute = container.parent;
  if (!attribute || !ts.isJsxAttribute(attribute)) return undefined;
  if (!ts.isIdentifier(attribute.name)) return undefined;
  if (attribute.name.text !== SINK_MESSAGE_PROP) return undefined;
  const opening = attribute.parent?.parent;
  if (
    !opening ||
    !(ts.isJsxSelfClosingElement(opening) || ts.isJsxOpeningElement(opening)) ||
    !ts.isIdentifier(opening.tagName)
  )
    return undefined;
  return opening.tagName.text;
}

/**
 * Every JSX render of a `RunFailure` message in `sourceFile`, as
 * `{line, text, throughSink}` records in source order. `throughSink` is true for
 * the one allowed position -- the `message` attribute of a
 * {@link SINK_COMPONENT_NAME} element -- and false for every other container.
 */
export function failureMessageRenders(sourceFile) {
  const names = new Set(failureBindingNames(sourceFile));
  if (names.size === 0) return [];
  const found = [];
  for (const node of descendants(sourceFile)) {
    if (
      !ts.isPropertyAccessExpression(node) ||
      node.name.text !== SINK_MESSAGE_PROP ||
      !ts.isIdentifier(node.expression) ||
      !names.has(node.expression.text)
    )
      continue;
    let container;
    for (let up = node.parent; up; up = up.parent) {
      if (ts.isJsxExpression(up)) {
        container = up;
        break;
      }
    }
    if (!container) continue;
    const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart());
    found.push({
      line: line + 1,
      text: node.getText(),
      throughSink: messagePropElementName(container) === SINK_COMPONENT_NAME,
    });
  }
  return found;
}

/** True when `sourceFile` declares a type named `name`. */
export function declaresType(sourceFile, name) {
  return descendants(sourceFile).some(
    (node) =>
      (ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node)) &&
      node.name.text === name,
  );
}

/** True when `sourceFile` exports a function named `name`. */
export function exportsFunction(sourceFile, name) {
  return descendants(sourceFile).some(
    (node) =>
      ts.isFunctionDeclaration(node) &&
      node.name?.text === name &&
      node.modifiers?.some(
        (modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword,
      ),
  );
}

// CLI entry: only runs when invoked directly, so the test can import the pure
// functions without the process.exit.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const failures = [];

  if (!declaresType(parseFile(FAILURE_TYPE_FILE), FAILURE_TYPE_NAME))
    failures.push(
      `${FAILURE_TYPE_FILE}: no longer declares ${FAILURE_TYPE_NAME} -- it moved or was renamed, and this check scans for that name; update scripts/check-run-failure-sink.mjs to follow it.`,
    );
  if (!exportsFunction(parseFile(SINK_COMPONENT_FILE), SINK_COMPONENT_NAME))
    failures.push(
      `${SINK_COMPONENT_FILE}: no longer exports ${SINK_COMPONENT_NAME} -- the sink moved or was renamed, and this check names it; update scripts/check-run-failure-sink.mjs to follow it.`,
    );

  const files = sourceModules(WEB_SOURCE_DIR);
  let throughSink = 0;
  for (const file of files) {
    const sourceFile = parseFile(file);
    for (const { line, text, throughSink: allowed } of failureMessageRenders(
      sourceFile,
    )) {
      if (allowed) {
        throughSink += 1;
        continue;
      }
      failures.push(
        `${file}:${line}: renders \`${text}\` outside the ${SINK_COMPONENT_NAME} sink (${SINK_COMPONENT_FILE}) -- a ${FAILURE_TYPE_NAME} message is a cause chain separated by newlines, which only that component's pre-line style lays out as line breaks; render it as <${SINK_COMPONENT_NAME} ${SINK_MESSAGE_PROP}={...} /> instead of styling a span here.`,
      );
    }
  }

  if (throughSink === 0)
    failures.push(
      `No render through the ${SINK_COMPONENT_NAME} sink was found under ${WEB_SOURCE_DIR} -- with nothing going through it this check protects nothing, so either the sink's callers moved out of this scan's reach or the binding walk stopped recognizing them; update scripts/check-run-failure-sink.mjs to follow them.`,
    );

  if (failures.length > 0) {
    for (const failure of failures) console.error(failure);
    process.exit(1);
  }
  console.log(
    `RunFailure display-sink check passed: ${throughSink} render(s) of a ${FAILURE_TYPE_NAME} message across ${files.length} scanned file(s), all through ${SINK_COMPONENT_NAME}.`,
  );
}
