import fs from "node:fs";

import { FINGERPRINT_REGEX, parseSensitiveYaml } from "@psilink/core";

/**
 * What the console says about a first authenticated contact with a partner:
 * the notice a run that pinned the certificate raises, and the failure a run
 * that could not record the pin stops on.
 *
 * The CLI's own messages name the configuration file the pin goes into, which
 * on a console run is a path inside the container the browser must never learn,
 * and the failures prescribe an edit of that file, which is not an action a
 * console operator can take. Each is rebuilt here from console copy plus, for
 * the notice, the recorded value read back out of the composed configuration
 * rather than parsed out of the CLI's sentence.
 */

/** The CLI warning source a first-contact pin rides (docs/spec/CLI_EVENTS.md). */
export const PARTNER_CERTIFICATE_PINNED_SOURCE = "partnerCertificatePinned";

/**
 * The fingerprint the run recorded, read from the configuration the console
 * composed for it. The CLI writes `signing.partner_fingerprint` and only then
 * emits the warning this answers, so the value is on file by the time it is
 * read.
 *
 * Re-validated against core's canonical shape: what comes back is a digest the
 * CLI derived, but it arrives through a file, and only a canonical value is
 * shown. Any read or parse failure answers `undefined` -- the notice then
 * states the pin without the value rather than failing the run, which has
 * already disclosed nothing and may still finish.
 */
export function recordedPartnerFingerprint(
  configPath: string,
): string | undefined {
  let parsed: unknown;
  try {
    parsed = parseSensitiveYaml(
      fs.readFileSync(configPath, "utf8"),
      "the composed exchange configuration",
    );
  } catch {
    return undefined;
  }
  if (parsed === null || typeof parsed !== "object") return undefined;
  const signing = (parsed as { signing?: unknown }).signing;
  if (signing === null || typeof signing !== "object") return undefined;
  const value = (signing as { partner_fingerprint?: unknown })
    .partner_fingerprint;
  return typeof value === "string" && FINGERPRINT_REGEX.test(value)
    ? value
    : undefined;
}

/**
 * The console's own first-contact notice. It states what was pinned, what that
 * pin is authenticated by, and the out-of-band comparison that is the only
 * thing which strengthens it -- and asks the operator to keep the value, since
 * a pin adopted mid-run is not written back into the configuration in the
 * mounted folder and the next run pins nothing unless they enter it.
 *
 * Names no file: the configuration the value went into is inside the console's
 * container, and this run's own files are the operator's downloads.
 */
export function partnerCertificatePinnedNotice(
  fingerprint: string | undefined,
): string {
  const value =
    fingerprint === undefined
      ? "The console could not read the value back from this run's " +
        "configuration, so compare the fingerprint your partner reports " +
        "with the one their receipt is signed under."
      : `Your partner's fingerprint is ${fingerprint}. Compare it with the ` +
        "value their 'psilink fingerprint' prints, over a channel you trust " +
        "-- a phone call, not the same email as the invitation.";
  return (
    "This exchange had no partner fingerprint on file, so it pinned the " +
    "signing certificate your partner presented. That pin is authenticated " +
    `by the channel the invitation travelled and nothing else. ${value} ` +
    "Enter it under your partner's fingerprint before the next exchange: " +
    "this run's pin is not written back into the configuration in your " +
    "folder, so nothing carries it forward on its own."
  );
}

/**
 * The console's own wording for a first contact whose pin could not be
 * recorded, which the CLI refuses two ways: before connecting, where the
 * configuration's directory is not writable, and at the terms exchange, where
 * the adoption write itself fails. Neither sends any of this party's data.
 *
 * One sentence answers both, since what the operator has to do is the same:
 * each CLI message names the configuration file the pin goes into, and offers
 * an edit of that file or a writable mount of it -- a path inside this
 * container, and two remedies a console operator cannot act on, since the
 * console writes the configuration each run is driven by itself.
 */
export const PARTNER_PIN_UNRECORDABLE_FAILURE =
  "This exchange signs receipts and has no partner fingerprint on file, so it " +
  "has to record the certificate your partner presents -- and this run could " +
  "not record it, so it stopped and sent none of your data. Ask your partner " +
  "to run 'psilink fingerprint' and send you the value over a channel you " +
  "trust -- a phone call, not the same email as the invitation -- then enter " +
  "it under your partner's fingerprint and run the exchange again. If the run " +
  "stops here a second time, check that the folder you mounted is writable.";
