/** The download a blob-download handler triggers: a synthetic anchor is
 * created, clicked, and removed within one turn, so a DOM query cannot catch
 * it. Capture it at click time -- the download filename and the blob text the
 * object URL points at, read back before the deferred revoke. Shared by every
 * browser suite that asserts what a surface writes to the operator's disk. */
export interface CapturedDownload {
  fileName: string;
  text: string;
}

/** A live capture of the downloads a surface triggers. */
export interface DownloadCapture {
  /** Every download recorded so far, in the order the anchors were clicked. */
  captured: Array<CapturedDownload>;
  /**
   * Resolves once the blob text of every download recorded SO FAR has been read
   * back into {@link captured}. It awaits the reads themselves rather than
   * polling for their result, so a caller that has already established the
   * downloads fired needs no timing budget to read what they held. A download
   * triggered after this is called is not awaited by it.
   */
  settled: () => Promise<void>;
  /** Put the real `HTMLAnchorElement.click` back. Call in a `finally`. */
  restore: () => void;
}

/** Intercept `HTMLAnchorElement.click` for the duration of a test, recording
 * every blob download the surface triggers. Call `restore()` in a `finally`. */
export function captureDownloads(): DownloadCapture {
  const captured: Array<CapturedDownload> = [];
  const reads: Array<Promise<void>> = [];
  const original = HTMLAnchorElement.prototype.click;
  HTMLAnchorElement.prototype.click = function click(this: HTMLAnchorElement) {
    if (this.download !== "" && this.href.startsWith("blob:")) {
      const href = this.href;
      const fileName = this.download;
      // The blob is still alive here (revoke is deferred well past the click);
      // pull its text synchronously enough via the object URL.
      captured.push({ fileName, text: "" });
      const index = captured.length - 1;
      reads.push(
        fetch(href)
          .then((response) => response.text())
          .then((text) => {
            captured[index].text = text;
          }),
      );
    }
    // Do not invoke the real click: a jsdom/browser navigation to a blob URL is
    // pointless here and can warn. The capture above is the whole point.
  };
  return {
    captured,
    settled: async () => {
      await Promise.all(reads);
    },
    restore: () => {
      HTMLAnchorElement.prototype.click = original;
    },
  };
}
