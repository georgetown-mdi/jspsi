import ts from "typescript";

import { descendants, parseFile } from "./typeScriptSources.mjs";

// What counts as a server round trip in the SFTP adapter, and where in the source
// it sits. Two checks stand on this: the per-attempt tracked() bracket
// (scripts/sftp-tracked-round-trips.test.mjs) and the per-operation runOperation
// span (scripts/sftp-operation-spans.test.mjs). One definition of a site serves
// both, so they cannot come to disagree about what it is they cover.
//
// The adapter is parsed with the TypeScript compiler API rather than matched by
// regex: what the checks follow -- a promise through wrapper calls, callbacks and
// executors, and a span through the private methods its body reaches -- is
// nothing a pattern over text can follow.
//
// Being a site is itself decided syntactically, and that decision is part of each
// check's claim: a call it does not reach is never examined at all, so it is
// never reported. A site is a call whose callee is written as a property access,
// `receiver.member(...)` with optional chaining included; whose member is not one
// of the session-lifecycle and EventEmitter names listed below; and whose
// receiver is `this.client`, or an identifier bearing a name bound anywhere in
// the adapter to the raw SFTPWrapper (destructured off the internals cast or off
// a local resolving to a receiver, or declared as a parameter of the wrapper's
// type), or an identifier declared in an enclosing block -- plainly or by
// destructuring -- whose initializer leads through a chain of such declarations
// back to either.
//
// That is the whole reach, and the reach is the claim: a callee or a receiver
// written some other way is not decided here. No enumeration of those other forms
// is kept, by design. A list of what an analysis cannot see is a second claim
// about the analysis that nothing checks, and a wrong entry in it is treated as
// a guarantee -- take the rules above as exhaustive instead, and anything they do
// not name as unseen.
//
// Where the reach errs it errs toward over-reporting: the wrapper name match is
// file-wide rather than scoped, so an unrelated binding that happens to share a
// wrapper's name is reported as a site too. That direction costs a spurious
// failure to be answered, never a miss.

// The adapter both checks parse, repository-relative.
const ADAPTER = "apps/cli/src/connection/ssh2SftpAdapter.ts";

// Members of the ssh2-sftp-client / raw SFTPWrapper surface that are not server
// round trips: session lifecycle and the EventEmitter surface. Everything else
// reached on those objects counts as request-issuing, so a method this file has
// never seen is treated as a round trip rather than ignored.
const NON_REQUEST_MEMBERS = new Set([
  "connect",
  "end",
  "on",
  "once",
  "off",
  "addListener",
  "removeListener",
  "emit",
  "destroy",
]);

/** Parse the adapter as this checkout ships it. */
export function parseAdapter() {
  return parseFile(ADAPTER);
}

/** Strip the wrappers that leave a value unchanged. */
export function unwrap(node) {
  let current = node;
  for (;;) {
    if (
      current &&
      (ts.isParenthesizedExpression(current) ||
        ts.isAsExpression(current) ||
        ts.isSatisfiesExpression(current) ||
        ts.isNonNullExpression(current) ||
        ts.isAwaitExpression(current) ||
        ts.isTypeAssertionExpression(current))
    ) {
      current = current.expression;
      continue;
    }
    return current;
  }
}

export function isFunctionLike(node) {
  return node && (ts.isArrowFunction(node) || ts.isFunctionExpression(node));
}

/** The nearest enclosing named method or function declaration, for reporting. */
export function enclosingMethodName(node) {
  for (let current = node.parent; current; current = current.parent) {
    if (
      (ts.isMethodDeclaration(current) ||
        ts.isFunctionDeclaration(current) ||
        ts.isGetAccessorDeclaration(current) ||
        ts.isSetAccessorDeclaration(current)) &&
      current.name
    )
      return current.name.getText();
    if (ts.isConstructorDeclaration(current)) return "constructor";
  }
  return "<top level>";
}

/**
 * The variable declaration binding `name` in the nearest enclosing scope of
 * `from`, or undefined. A scope here is any ancestor holding statements, which
 * is enough for the adapter's `const` plumbing.
 */
export function declarationOf(name, from) {
  for (let current = from.parent; current; current = current.parent) {
    const statements = ts.isSourceFile(current)
      ? current.statements
      : ts.isBlock(current)
        ? current.statements
        : undefined;
    if (!statements) continue;
    for (const statement of statements) {
      if (!ts.isVariableStatement(statement)) continue;
      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name) && declaration.name.text === name)
          return declaration;
        if (ts.isObjectBindingPattern(declaration.name)) {
          for (const element of declaration.name.elements)
            if (ts.isIdentifier(element.name) && element.name.text === name)
              return declaration;
        }
      }
    }
  }
  return undefined;
}

/** The `this.client` property: the client every high-level operation runs on. */
function isTheClient(node) {
  const target = unwrap(node);
  return (
    !!target &&
    ts.isPropertyAccessExpression(target) &&
    target.expression.kind === ts.SyntaxKind.ThisKeyword &&
    target.name.text === "client"
  );
}

/**
 * Whether `identifier` is bound to something requests are issued on: a raw
 * SFTPWrapper binding, `this.client`, or a local initialized from either,
 * followed through a chain of such locals (`const client = this.client`). Only
 * a wrapper name and a declaration initializer are followed; the header states
 * that reach.
 */
function bindsARequestReceiver(identifier, wrappers = new Set()) {
  const seen = new Set();
  for (let current = identifier; ;) {
    if (wrappers.has(current.text)) return true;
    const declaration = declarationOf(current.text, current);
    if (!declaration || !declaration.initializer || seen.has(declaration))
      return false;
    seen.add(declaration);
    const initializer = unwrap(declaration.initializer);
    if (isTheClient(initializer)) return true;
    if (!ts.isIdentifier(initializer)) return false;
    current = initializer;
  }
}

/**
 * Identifiers bound to the raw ssh2 SFTPWrapper: the `const { sftp } = ...`
 * idiom over the internals cast or over a local holding it, and a parameter
 * declared as the wrapper's type. Calls on these are server round trips exactly
 * as calls on the high-level client are.
 */
export function wrapperBindings(sourceFile) {
  const names = new Set();
  for (const node of descendants(sourceFile)) {
    if (
      ts.isVariableDeclaration(node) &&
      node.initializer &&
      ts.isObjectBindingPattern(node.name) &&
      (node.initializer.getText().includes("Ssh2SftpClientInternals") ||
        (ts.isIdentifier(unwrap(node.initializer)) &&
          bindsARequestReceiver(unwrap(node.initializer))))
    ) {
      for (const element of node.name.elements)
        if (ts.isIdentifier(element.name)) names.add(element.name.text);
    }
    if (
      ts.isParameter(node) &&
      node.type &&
      node.type.getText().includes('Ssh2SftpClientInternals["sftp"]') &&
      ts.isIdentifier(node.name)
    )
      names.add(node.name.text);
  }
  return names;
}

/**
 * The call expressions the site rules reach: a property-access call on
 * `this.client`, on a raw SFTPWrapper binding, or on a local aliasing either,
 * whose member is not session lifecycle or EventEmitter plumbing. A callee
 * written any other way is not a site; see the header.
 */
export function requestIssuingSites(sourceFile) {
  const wrappers = wrapperBindings(sourceFile);
  const sites = [];
  for (const node of descendants(sourceFile)) {
    if (!ts.isCallExpression(node)) continue;
    const callee = unwrap(node.expression);
    if (!ts.isPropertyAccessExpression(callee)) continue;
    const receiver = unwrap(callee.expression);
    const onClient = isTheClient(receiver);
    const onWrapper =
      ts.isIdentifier(receiver) && bindsARequestReceiver(receiver, wrappers);
    if (!onClient && !onWrapper) continue;
    const member = callee.name.text;
    if (NON_REQUEST_MEMBERS.has(member)) continue;
    const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart());
    sites.push({
      node,
      callee: `${onClient ? "this.client" : receiver.text}.${member}`,
      member,
      line: line + 1,
      enclosingMethod: enclosingMethodName(node),
    });
  }
  return sites;
}

/** `ADAPTER:line callee() in method()`, the one description both checks report. */
export function describeSite(site) {
  return `${ADAPTER}:${site.line} ${site.callee}() in ${site.enclosingMethod}()`;
}

/**
 * The allowance matching `site`, or undefined. An allowance matches by enclosing
 * method and callee name, so a SECOND uncovered call to the same method in the
 * same method is admitted by the same reason -- that is the class the reason
 * names, not an unexamined site.
 */
export function allowanceFor(allowances, site) {
  return allowances.find(
    (allowance) =>
      allowance.enclosingMethod === site.enclosingMethod &&
      allowance.callee === site.member,
  );
}
