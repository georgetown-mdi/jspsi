/** The download a blob-download handler triggers: a synthetic anchor is
 * created, clicked, and removed within one turn, so a DOM query cannot catch
 * it. Capture it at click time -- the download filename and the blob text the
 * object URL points at, read back before the deferred revoke. Shared by every
 * browser suite that asserts what a surface writes to the operator's disk. */
export interface CapturedDownload {
  fileName: string;
  text: string;
}

/** Intercept `HTMLAnchorElement.click` for the duration of a test, recording
 * every blob download the surface triggers. Call `restore()` in a `finally`. */
export function captureDownloads(): {
  captured: Array<CapturedDownload>;
  restore: () => void;
} {
  const captured: Array<CapturedDownload> = [];
  const original = HTMLAnchorElement.prototype.click;
  HTMLAnchorElement.prototype.click = function click(this: HTMLAnchorElement) {
    if (this.download !== "" && this.href.startsWith("blob:")) {
      const href = this.href;
      const fileName = this.download;
      // The blob is still alive here (revoke is deferred well past the click);
      // pull its text synchronously enough via the object URL.
      captured.push({ fileName, text: "" });
      const index = captured.length - 1;
      void fetch(href)
        .then((response) => response.text())
        .then((text) => {
          captured[index].text = text;
        });
    }
    // Do not invoke the real click: a jsdom/browser navigation to a blob URL is
    // pointless here and can warn. The capture above is the whole point.
  };
  return {
    captured,
    restore: () => {
      HTMLAnchorElement.prototype.click = original;
    },
  };
}
