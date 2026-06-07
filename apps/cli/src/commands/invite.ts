import type { Argv, Arguments } from "yargs";
import logLibrary from "loglevel";
import { userInfo } from "node:os";

import { getLogger, encodeInvitation, UsageError } from "@psilink/core";
import type { ConnectionConfig, ExchangeSpec } from "@psilink/core";

import { resolveRecordOutput } from "../recordFile";
import { assertNoProvisionConflicts, provisionConfigAndKey } from "./provision";
import {
  addCommonBootstrapOptions,
  buildDataSpec,
  connectionFromEndpoint,
  connectionFromURL,
  connectionOverridesFrom,
  DEFAULT_ACCEPT_TIMEOUT_SECONDS,
  expiresFromNow,
  generatePakeToken,
  loadInputRows,
  looksLikeUrl,
  parseCommonBootstrapArgs,
  redactUrlCredentials,
  prepareForOnlineExchange,
  runOnlineBootstrap,
  type ResolvedDataSpec,
} from "./bootstrap";

// Invitation tokens carry a 1-hour lifetime by default, per
// docs/SECURITY_DESIGN.md. The --expires-in override is a separate epic item;
// the value is hard-coded here. Distinct from --accept-timeout, which bounds how
// long the inviter waits at the rendezvous, not how long the token stays valid.
const INVITATION_LIFETIME_SECONDS = 60 * 60;

export function builder(cmd: Argv): Argv {
  return addCommonBootstrapOptions(
    cmd
      // Capture all positionals into `args` (rather than relying on the global
      // `_`) and treat an unknown `-`-leading token as a positional, so an
      // input path is never misread as a flag. Scoped to this command so the
      // other commands' parsing is unaffected.
      .parserConfiguration({ "unknown-options-as-args": true })
      .positional("args", {
        type: "string",
        array: true,
        // INPUT_FILE is required in both modes today: linkage terms are inferred
        // from it. It becomes optional once reusing a pre-existing config as the
        // terms source lands (board item 196895356); update this then.
        describe:
          "INPUT_FILE (offline), or URL INPUT_FILE [OUTPUT_FILE] (online)",
      })
      .usage(
        "Usage:\n" +
          "  $0 invite [options] INPUT_FILE                         (offline)\n" +
          "  $0 invite [options] URL INPUT_FILE [OUTPUT_FILE]       (online)\n\n" +
          "Offline: generate an invitation string and key file to share with a\n" +
          "partner out-of-band. Online: also connect, wait for the partner to\n" +
          "accept, and run the exchange. Linkage terms are inferred from\n" +
          "INPUT_FILE.",
      ),
  ).option("accept-timeout", {
    type: "number",
    describe:
      "online only: seconds to wait for the partner to accept before giving " +
      `up (default: ${DEFAULT_ACCEPT_TIMEOUT_SECONDS}, i.e. 15 minutes)`,
  });
}

// --- Positional parsing ------------------------------------------------------

/**
 * Classify the positional arguments as an offline or online invitation. The
 * first positional is a server URL (online) when it parses as a supported
 * transport URL; otherwise it is the optional input file (offline).
 *
 * @internal exported for testing
 */
export function resolveInvitePositionals(
  positionals: Array<unknown>,
):
  | { mode: "offline"; input?: string }
  | { mode: "online"; url: URL; input: string; output?: string } {
  const arg0 =
    positionals[0] !== undefined ? String(positionals[0]) : undefined;

  if (arg0 !== undefined && looksLikeUrl(arg0)) {
    const input =
      positionals[1] !== undefined ? String(positionals[1]) : undefined;
    if (input === undefined)
      throw new UsageError(
        "online invitation requires an input file; usage: psilink invite " +
          "URL INPUT_FILE [OUTPUT_FILE]",
      );
    const output =
      positionals[2] !== undefined ? String(positionals[2]) : undefined;
    return { mode: "online", url: new URL(arg0), input, output };
  }

  return { mode: "offline", input: arg0 };
}

// --- Handler -----------------------------------------------------------------

export async function handler(argv: Arguments): Promise<void> {
  const options = parseCommonBootstrapArgs(argv);
  const acceptTimeout =
    (argv["accept-timeout"] as number | undefined) ??
    DEFAULT_ACCEPT_TIMEOUT_SECONDS;

  logLibrary.setDefaultLevel(options.logLevel);
  const log = getLogger("invite");

  const positionals = (argv["args"] as Array<string> | undefined) ?? [];
  let resolved: ReturnType<typeof resolveInvitePositionals>;
  try {
    resolved = resolveInvitePositionals(positionals);
  } catch (err) {
    log.error(err instanceof Error ? err.message : String(err));
    process.exit(64);
  }

  const identity = options.identity ?? userInfo().username;
  const expires = expiresFromNow(INVITATION_LIFETIME_SECONDS);
  const pakeToken = generatePakeToken();

  if (resolved.mode === "online") {
    const { url, input, output } = resolved;
    try {
      // Detect a pre-existing config/key before opening any connection so a
      // bootstrap never clobbers a configuration partway through an exchange.
      assertNoProvisionConflicts({
        configPath: options.configFile,
        keyPath: options.keyFile,
      });

      // Validate the server URL before the invitation is printed: an unusable
      // URL (e.g. a not-yet-supported webrtc scheme, or one with no host) must
      // fail here, not after the live PAKE token has already been disclosed on
      // stdout.
      const connection = connectionFromURL(
        url,
        connectionOverridesFrom(options, { peerTimeout: acceptTimeout }),
      );

      // The token's lifetime is fixed; an accept-timeout longer than it would
      // keep waiting at the rendezvous past the point the token can be honored.
      if (acceptTimeout > INVITATION_LIFETIME_SECONDS)
        log.warn(
          `--accept-timeout (${acceptTimeout}s) exceeds the invitation ` +
            `lifetime (${INVITATION_LIFETIME_SECONDS}s); the token will expire ` +
            "first and a later acceptance will be rejected.",
        );

      const rows = await loadInputRows(input);
      const { dataSpec, warnings } = buildDataSpec({ identity, rows });
      for (const w of warnings) log.warn(w);

      const invitation = await encodeInvitation({
        version: "1",
        linkageTerms: dataSpec.linkageTerms,
        pakeToken,
        expires,
      });
      printInvitation(invitation, { url });

      const prepared = await prepareForOnlineExchange(dataSpec, identity, rows);

      log.info("waiting for the partner to accept...");
      await runOnlineBootstrap({
        connection,
        dataSpec,
        prepared,
        pakeToken,
        expires,
        keyPath: options.keyFile,
        configPath: options.configFile,
        output,
        verbosity: options.verbosity,
        loggerName: "invite",
        recordOutput: resolveRecordOutput({
          enabled: options.record,
          recordFile: options.recordFile,
        }),
      });
      log.info(
        `exchange complete; saved config to ${options.configFile} and the ` +
          `rotated key to ${options.keyFile}. Keep the key file private.`,
      );
    } catch (err) {
      log.error(err instanceof Error ? err.message : String(err));
      process.exit(
        err instanceof UsageError
          ? 64
          : ((err as { exitCode?: number }).exitCode ?? 69),
      );
    }
    return;
  }

  // Offline.
  try {
    if (resolved.input === undefined)
      throw new UsageError(
        "an input file is required to generate an invitation; usage: " +
          "psilink invite INPUT_FILE",
      );
    assertNoProvisionConflicts({
      configPath: options.configFile,
      keyPath: options.keyFile,
    });

    const rows = await loadInputRows(resolved.input);
    const { dataSpec, warnings } = buildDataSpec({ identity, rows });
    for (const w of warnings) log.warn(w);

    const invitation = await encodeInvitation({
      version: "1",
      linkageTerms: dataSpec.linkageTerms,
      pakeToken,
      expires,
    });

    const spec = specWithPlaceholderConnection(dataSpec);
    const { configPath, keyPath } = provisionConfigAndKey(
      spec,
      { pakeToken, expires },
      { configPath: options.configFile, keyPath: options.keyFile },
    );

    printInvitation(invitation, undefined);
    log.info(
      `wrote config to ${configPath} and key file to ${keyPath} (the ` +
        `invitation expires at ${expires}). Keep the key file private.`,
    );
    log.info(
      `fill in the connection block in ${configPath} before running ` +
        "'psilink exchange'.",
    );
  } catch (err) {
    log.error(err instanceof Error ? err.message : String(err));
    process.exit(
      err instanceof UsageError
        ? 64
        : ((err as { exitCode?: number }).exitCode ?? 69),
    );
  }
}

// --- Helpers -----------------------------------------------------------------

function specWithPlaceholderConnection(
  dataSpec: ResolvedDataSpec,
): ExchangeSpec {
  const connection: ConnectionConfig =
    connectionFromEndpoint(undefined).connection;
  return { connection, ...dataSpec };
}

/**
 * Print the invitation string (to stdout, so it is captured even at a quiet log
 * level) with copy/pasteable usage instructions. When `online.url` is present,
 * the accept template references the shared server.
 */
function printInvitation(
  invitation: string,
  online: { url: URL } | undefined,
): void {
  const log = getLogger("invite");
  log.info(
    "Share this invitation with your partner over a trusted, out-of-band " +
      "channel:",
  );
  // The invitation is the primary artifact; emit it on stdout regardless of log
  // level so it is reliably captured for copy/paste.
  console.log(invitation);
  if (online !== undefined) {
    // Strip any credentials embedded in the URL before echoing it: the partner
    // supplies their own, and a password must not reach the terminal or logs.
    log.info(
      `Your partner accepts and runs the exchange with:\n  psilink accept ` +
        `${redactUrlCredentials(online.url)} ${invitation} <INPUT_FILE>`,
    );
  } else {
    log.info(
      `Your partner accepts with:\n  psilink accept ${invitation} <INPUT_FILE>`,
    );
  }
}
