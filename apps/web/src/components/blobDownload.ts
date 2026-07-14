/**
 * The one client-side blob-download helper: build a Blob, click a synthetic
 * anchor, and revoke the object URL on a deferred timer. Every surface that
 * writes a document to the user's disk from in-browser bytes (the linkage-terms
 * export, the exchange-file save, the sample CSVs) routes through this so the
 * download discipline -- the in-document anchor and the deferred revoke, both
 * load-bearing on some browsers -- lives in one place.
 */

/** How long to keep a download's object URL alive after the click before
 * revoking it. The browser may copy the blob asynchronously, so revoking too
 * soon (even on the next task) can abort the save; a generous fixed delay
 * outlives the transfer while still freeing the URL rather than leaking it for
 * the document lifetime. A fixed multi-second delay in the same spirit as the
 * long-used file-saver approach (which defers its own revoke by tens of
 * seconds). */
const REVOKE_DELAY_MS = 60_000;

/** Trigger a client-side download of `content` as `fileName`. Nothing is
 * uploaded; the bytes are written to the user's disk the same way their file
 * is read in (locally). */
export function triggerBlobDownload(
  fileName: string,
  content: string,
  mimeType: string,
): void {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  // Some environments (older Firefox/Safari, certain sandboxed contexts) only
  // honor the download attribute when the anchor is in the live document; append
  // it before clicking and remove it after so the save fires everywhere.
  document.body.appendChild(anchor);
  try {
    anchor.click();
  } finally {
    anchor.remove();
    // Defer the revoke well past the click (see REVOKE_DELAY_MS): a synchronous or
    // next-task revoke can abort a save in browsers that copy the blob
    // asynchronously. The finally makes cleanup unconditional even if click throws.
    setTimeout(() => URL.revokeObjectURL(url), REVOKE_DELAY_MS);
  }
}
