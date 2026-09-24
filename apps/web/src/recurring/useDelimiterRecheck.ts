import { useEffect, useState } from "react";

import {
  acquireManagedInput,
  storedInputHandleUsable,
} from "@psi/managed/managedInputHandle";

import { delimiterRecheckFrom } from "./localDocumentFieldsModel";

import type { DelimiterRecheck } from "./localDocumentFieldsModel";
import type { ExchangeSpec } from "@alcove/core";

/**
 * Re-read the stored input file under a delimiter the operator has changed to,
 * and grade the columns it reads into against the agreed terms, so the editor
 * states whether the file reads under the new delimiter before the save stores
 * it. `undefined` where there is nothing to re-read: no changed delimiter, or
 * no usable pointer to the file (a configuration-only record, or a browser
 * without file handles).
 *
 * The read queries the file's read grant and never asks for it, as a page
 * showing a file's last change does, so choosing a delimiter raises no
 * permission dialog; a grant this browser does not hold reads as `unreadable`.
 * Only the column names are kept: the rows the read parsed are dropped with it.
 */
export function useDelimiterRecheck(
  exchangeFile: ExchangeSpec,
  handle: FileSystemFileHandle | undefined,
  changedDelimiter: string | undefined,
): DelimiterRecheck | undefined {
  const [settled, setSettled] = useState<{
    delimiter: string;
    recheck: DelimiterRecheck;
  }>();
  const rereads =
    changedDelimiter !== undefined &&
    handle !== undefined &&
    storedInputHandleUsable(handle);

  useEffect(() => {
    if (!rereads) return;
    const delimiter = changedDelimiter;
    let live = true;
    function settle(recheck: DelimiterRecheck) {
      if (live) setSettled({ delimiter, recheck });
    }
    acquireManagedInput(
      { kind: "handle", handle, attendance: "unattended" },
      undefined,
      delimiter,
    ).then(
      ({ columns }) => settle(delimiterRecheckFrom(exchangeFile, columns)),
      () => settle({ kind: "unreadable" }),
    );
    return () => {
      live = false;
    };
  }, [rereads, exchangeFile, handle, changedDelimiter]);

  if (!rereads) return undefined;
  // A result settled for an earlier choice is not this choice's.
  return settled?.delimiter === changedDelimiter
    ? settled.recheck
    : { kind: "reading" };
}
