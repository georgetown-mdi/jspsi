import { useEffect, useState } from "react";

import {
  readInputFileModifiedAt,
  storedInputHandleUsable,
} from "@psi/managed/managedInputHandle";

/**
 * When the file this exchange's persisted pointer names was last changed, in epoch
 * milliseconds, or `undefined` while the read is outstanding and wherever it found
 * nothing to report (no usable pointer, no standing read grant, a missing or
 * unreadable entry). The schedule section reads it to say whether the input has
 * been refreshed since the last successful run.
 *
 * The read happens once per mounted handle rather than on a poll: what it feeds is
 * a note the operator reads on this visit, and a file replaced while they sit on
 * the page is the next visit's reading. It prompts for nothing -- the underlying
 * read queries the grant and never asks for it -- so opening an exchange's page
 * raises no permission dialog.
 */
export function useInputFileModifiedAt(
  handle: FileSystemFileHandle | undefined,
): number | undefined {
  const [modifiedAtMs, setModifiedAtMs] = useState<number | undefined>(
    undefined,
  );

  useEffect(() => {
    let live = true;
    if (handle !== undefined && storedInputHandleUsable(handle))
      void readInputFileModifiedAt(handle).then((at) => {
        if (live) setModifiedAtMs(at);
      });
    else setModifiedAtMs(undefined);
    return () => {
      live = false;
    };
  }, [handle]);

  return modifiedAtMs;
}
