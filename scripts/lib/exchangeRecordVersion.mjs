// The exchange-record format literal and where it is read from, shared by the
// two checks that hold it to something: check-disclosure-recovery.mjs pins it to
// the version its recovery path has been driven against, and
// check-exchange-record-reset.mjs holds it to the value first publication ships.
// One source path and one extraction pattern, so the two cannot come to
// disagree about what the build declares.
//
// The literal is read out of the source rather than imported from the built
// package because both checks run before any build, and a check that silently
// skipped on a missing dist/ would be inert exactly when it is needed.

/** Where the record version literal is declared. */
export const RECORD_VERSION_SOURCE = "packages/core/src/exchangeRecord.ts";

/**
 * The exchange-record version literal declared in the given source, or
 * `undefined` when the declaration is not a quoted string this can read.
 */
export function declaredRecordVersion(source) {
  const match = /export const EXCHANGE_RECORD_VERSION\s*=\s*"([^"]*)"/.exec(
    source,
  );
  return match === null ? undefined : match[1];
}
