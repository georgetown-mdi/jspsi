import fs from "node:fs";
import { userInfo } from "node:os";

import type { Argv, Arguments } from "yargs";

import {
  describeDecodeError,
  deriveAcceptedLinkageTerms,
  disclosedColumnNames,
  getLogger,
  parseExchangeSpec,
  UsageError,
} from "@psilink/core";
import type {
  ConnectionConfig,
  ExchangeSpec,
  InvitationToken,
  LinkageTerms,
  OutboundPayloadConsent,
  PreparedExchange,
} from "@psilink/core";

import {
  diffLinkageTerms,
  formatReconcileDiffs,
  persistExpectedPayloadColumns,
  persistOutboundPayloadConsent,
  type ReconcileDiff,
} from "../config";
import { detectFileConflicts } from "../fileUtils";
import { parseSensitiveYaml } from "../sensitiveFile";
import { decodeAndValidateInvitation } from "../invitationDecode";
import { consentSurfaceSink, displayInvitation } from "../invitationDisplay";
import {
  assertNoUnknownOptions,
  configureLogging,
  promptConfirm,
  runOrExit,
} from "../util/cli";
import { resolveRecordOutput } from "../recordFile";
import {
  checkLinkageSatisfiability,
  warnColumnsTheInvitationWillNotAccept,
  type LinkagePreflightMessaging,
} from "./linkagePreflight";
import { assertNoProvisionConflicts, provisionConfigAndKey } from "./provision";
import {
  connectionFromURL,
  type RunnableConnectionConfig,
} from "../connectionFromUrl";
import { diffConnectionAgainstTarget } from "../reconcile";
import {
  addCommonBootstrapOptions,
  connectionOverridesFrom,
  parseCommonBootstrapArgs,
  warnConnectionPerPollShortInterval,
  warnLowPollingFrequency,
  warnOptionsOverridesIgnoredOffline,
  warnServerOverridesIgnoredOffline,
  warnUnsupportedFileSyncFlags,
  type CommonBootstrapOptions,
} from "../optionDefinitions";
import {
  applyEndpointSplitDirectories,
  buildDataSpec,
  connectionFromEndpoint,
  loadInputRows,
  logOnlineBootstrapOutcome,
  looksLikeUrl,
  prepareForOnlineExchange,
  runOnlineBootstrap,
  type ResolvedDataSpec,
} from "../onlineBootstrap";

export function builder(cmd: Argv): Argv {
  return addCommonBootstrapOptions(
    cmd
      // Capture all positionals into `args` (rather than relying on the global
      // `_`) and treat an unknown `-`-leading token as a positional, so an
      // invitation string beginning with `-` (a valid base64url character) is
      // taken as the positional invitation, not a cluster of option flags.
      // Scoped to this command so the other commands' parsing is unaffected.
      .parserConfiguration({ "unknown-options-as-args": true })
      .positional("args", {
        type: "string",
        array: true,
        describe:
          "INVITATION [INPUT_FILE] (offline), or URL INVITATION INPUT_FILE " +
          "[OUTPUT_FILE] (online)",
      })
      .usage(
        "Usage:\n" +
          "  $0 accept [options] INVITATION [INPUT_FILE]                  (offline)\n" +
          "  $0 accept [options] URL INVITATION INPUT_FILE [OUTPUT_FILE]  (online)\n\n" +
          "INVITATION is a base64url string or an @path reference to a file\n" +
          "containing one. Offline: decode, confirm, and write config and key\n" +
          "files. Online: also connect, complete the handshake, and run the\n" +
          "exchange.",
      ),
    // --consent-to-terms is the one accept-specific option: it records, in
    // advance, the operator's consent to THIS invitation's disclosed terms -- the
    // consent the interactive prompt otherwise collects -- so accept can run
    // unattended. The name states the object of consent (the terms), and is scoped
    // to this one decision: it does NOT bypass the separate SSH host-key trust
    // step (which keeps its own pin / fail-closed resolution), nor any prompt
    // added later -- each such gate takes its own opt-in. No short form: bypassing
    // the command's central human checkpoint should be a deliberate, legible
    // token, and accept's `unknown-options-as-args` (which lets a `-`-leading
    // invitation positional through) would make a single-letter flag ambiguous
    // besides.
  ).option("consent-to-terms", {
    type: "boolean",
    default: false,
    describe:
      "consent in advance to this invitation's disclosed terms, skipping the " +
      "interactive confirmation, so accept can run unattended or in a script. " +
      "This BYPASSES the one human checkpoint before the configuration and " +
      "linkage key are written from the partner-supplied invitation, so review " +
      "the terms before using it; it does not affect SSH host-key verification. " +
      "It also frees standard input, so INPUT_FILE may be `-` to read the CSV " +
      "from stdin.",
  });
}

// --- Positional parsing ------------------------------------------------------

/**
 * Classify the positional arguments as an offline or online acceptance. The
 * first positional is a server URL (online) when it parses as a supported
 * transport URL; otherwise it is the invitation string (offline). Because the
 * invitation is never matched as a URL, an invitation beginning with `-` (a
 * valid base64url leading character) is taken as the positional invitation, not
 * a flag -- the top-level parser is configured to push unknown `-`-leading
 * tokens into the positionals for this reason.
 *
 * @internal exported for testing
 */
export function resolveAcceptPositionals(positionals: Array<unknown>):
  | { mode: "offline"; invitation: string; input?: string }
  | {
      mode: "online";
      url: URL;
      invitation: string;
      input: string;
      output?: string;
    } {
  const arg0 =
    positionals[0] !== undefined ? String(positionals[0]) : undefined;
  if (arg0 === undefined)
    throw new UsageError(
      "an invitation is required; usage: psilink accept INVITATION " +
        "[INPUT_FILE]",
    );

  if (looksLikeUrl(arg0)) {
    const invitation =
      positionals[1] !== undefined ? String(positionals[1]) : undefined;
    const input =
      positionals[2] !== undefined ? String(positionals[2]) : undefined;
    if (invitation === undefined || input === undefined)
      throw new UsageError(
        "online acceptance requires an invitation and an input file; usage: " +
          "psilink accept URL INVITATION INPUT_FILE [OUTPUT_FILE]",
      );
    const output =
      positionals[3] !== undefined ? String(positionals[3]) : undefined;
    return { mode: "online", url: new URL(arg0), invitation, input, output };
  }

  return {
    mode: "offline",
    invitation: arg0,
    input: positionals[1] !== undefined ? String(positionals[1]) : undefined,
  };
}

// --- Invitation decode + validation ------------------------------------------

export { decodeAndValidateInvitation } from "../invitationDecode";

// --- Display -----------------------------------------------------------------

export { displayInvitation };

// --- Validation (the no-commit phase) ----------------------------------------

/**
 * Everything an acceptance needs that is fallible but free of the gating side
 * effects (the confirmation prompt, writing files, opening a connection):
 * decode + validate the invitation, detect conflicts, validate the URL and read
 * the input (online), and resolve the data spec and connection. The caller's
 * commit step performs the prompt and side effects from this bundle, so a
 * missing file, bad URL, or invalid invitation aborts before the user is asked
 * to confirm. Cleaning warnings are logged here so they precede the prompt.
 */
type AcceptReady = {
  /**
   * True when a pre-existing config was reconciled against the invitation (and,
   * online, the URL) and matched, so it is kept untouched and only the key file
   * is written. False when no config existed and a fresh one will be written.
   */
  reuseExistingConfig: boolean;
  /**
   * The kept config's own `output.shareWithPartner`, present only under reuse.
   * Reconciliation compares no output field, so the invitation's mirror cannot
   * stand in for it when deciding what outbound-consent record the kept config
   * needs (see the derivation at the accept handler).
   */
  existingOutputShares?: boolean;
} & (
  | {
      mode: "online";
      url: URL;
      output?: string;
      token: InvitationToken;
      connection: RunnableConnectionConfig;
      dataSpec: ResolvedDataSpec;
      prepared: PreparedExchange;
    }
  | {
      mode: "offline";
      token: InvitationToken;
      connection: ConnectionConfig;
      seeded: boolean;
      dataSpec: ResolvedDataSpec;
    }
);

/**
 * Validate and prepare an acceptance without committing any side effect. Throws
 * (for the shared {@link runOrExit} mapper) on any failure; runs the invitation
 * decode before the connection/input work so the `decode -> myTerms ->
 * buildDataSpec` dependency stays ordered.
 *
 * @internal exported for testing
 */
export async function validateAccept(params: {
  resolved: ReturnType<typeof resolveAcceptPositionals>;
  options: CommonBootstrapOptions;
  log: ReturnType<typeof getLogger>;
  /**
   * The operator passed `--consent-to-terms`, so the confirmation prompt is
   * skipped. Because the prompt is what otherwise owns the single-use stdin, this
   * also frees stdin to carry the input CSV, so a `-` input is allowed
   * (`allowStdin`); without it `-` stays rejected, as the prompt would starve.
   * Defaults to false so a caller that omits it keeps the prompt-and-reject-`-`
   * behavior.
   */
  consentToTerms?: boolean;
}): Promise<AcceptReady> {
  const { resolved, options, log, consentToTerms = false } = params;

  // Validate (checksum, schema, expiry) first, so the user is never prompted for
  // an invalid invitation. A pre-existing key file remains a hard conflict on
  // accept (docs/CLI.md "Online acceptance"): a stale token must never be
  // silently reused. A pre-existing config, by contrast, is reconciled against
  // the invitation below (reconcileAcceptConfig) rather than aborting.
  const token = await decodeAndValidateInvitation(resolved.invitation);
  assertNoProvisionConflicts(
    { configPath: options.configFile, keyPath: options.keyFile },
    ["key"],
  );

  const myIdentity = options.identity ?? userInfo().username;
  // Adopt the invitation's agreed linkage fields/keys/algorithm, but record this
  // party's own identity (the invitation's identity is the inviter's) and MIRROR
  // the output direction rather than copying it: validateCompatibility compares
  // output as a mirror, so a verbatim copy only happens to agree in the symmetric
  // both-receive case and would abort any one-sided exchange. The shared core
  // helper also backs the web acceptor (see deriveAcceptedLinkageTerms).
  const myTerms: LinkageTerms = deriveAcceptedLinkageTerms(
    token.linkageTerms,
    myIdentity,
  );

  if (resolved.mode === "online") {
    const { url, input, output } = resolved;
    // Validate the URL before reading the input file, mirroring validateInvite,
    // so a bad scheme/host fails fast without first parsing the CSV.
    const urlConnection = connectionFromURL(
      url,
      connectionOverridesFrom(options),
    );
    // When the acceptor did NOT pass --outbound-path (the explicit override,
    // which wins), a split-directory invitation endpoint seeds the mirror-swapped
    // inbound/outbound roles and retain trio onto the URL-built connection -- the
    // online counterpart to the offline path's connectionFromEndpoint. Host,
    // port, and credentials stay the URL's. A non-split (or absent) endpoint is a
    // no-op, leaving the URL connection unchanged.
    const { connection, appliedSplitDirectories } =
      options.outboundPath === undefined
        ? applyEndpointSplitDirectories(urlConnection, token.connectionEndpoint)
        : { connection: urlConnection, appliedSplitDirectories: false };
    if (appliedSplitDirectories)
      log.info(
        "seeding the split inbound/outbound directories (mirror-swapped) and " +
          "retain mode from the invitation's endpoint; the connection URL " +
          "supplies the host, port, and credentials. Pass --outbound-path to " +
          "override.",
      );
    // Warn when the --polling-frequency override (now merged into `connection`)
    // is set aggressively low; no-op when the flag was not passed. Only on this
    // online path -- the offline path reports it ignored (see below).
    // connectionFromURL has already rejected a webrtc URL, so `connection` is a
    // file-sync channel here and the channel gate always passes.
    warnLowPollingFrequency(
      connection.channel,
      options.pollingFrequencyMs,
      log,
    );
    // Warn when --connection-per-poll resolves to a channel that ignores it (a
    // file:// URL is filedrop, which holds no session). connectionFromURL applies
    // the override only on sftp, so on filedrop the raw flag is the only carrier
    // of the operator's intent; read it too, not just the merged value that a
    // future persisted source would set. A no-op on sftp (the mode's own channel),
    // where warnConnectionPerPollShortInterval covers the short-interval case
    // instead -- the two are channel-exclusive and never double-warn.
    warnUnsupportedFileSyncFlags(
      connection.channel,
      {
        connectionPerPoll:
          options.connectionPerPoll === true ||
          connection.options?.connectionPerPoll === true,
      },
      log,
    );
    // Warn when --connection-per-poll is paired with a short poll interval. Built
    // from the URL (endpoint-seeded), so `connection` carries the effective mode
    // and interval; a no-op off sftp (the mode is SFTP-only).
    warnConnectionPerPollShortInterval(
      connection.channel,
      connection.options?.connectionPerPoll,
      connection.options?.pollIntervalMs,
      log,
    );
    // Reconcile a pre-existing config against the invitation AND the connection
    // the exchange will actually use (the built `connection`, now possibly
    // endpoint-influenced) before the input is read and before any network
    // activity, so a location disagreement aborts with a diff and no acceptance
    // is ever sent to the inviter.
    const { reuse: reuseExistingConfig, existingOutputShares } =
      reconcileAcceptConfig({
        configPath: options.configFile,
        myTerms,
        target: connection,
        log,
      });
    // accept reads its y/N confirmation from stdin (promptConfirm), so it cannot
    // also take the CSV there -- unless `--consent-to-terms` skips that prompt,
    // which frees stdin for the CSV. Gate `-` on it: rejected when the prompt
    // would run, allowed when it is bypassed (see the consentToTerms doc above).
    const rows = await loadInputRows(input, { allowStdin: consentToTerms });
    checkLinkageSatisfiability(
      rows.columns,
      myTerms,
      log,
      INVITATION_PREFLIGHT_MESSAGING,
    );
    const { dataSpec, warnings } = buildDataSpec({
      terms: myTerms,
      identity: myIdentity,
      rows,
    });
    for (const w of warnings) log.warn(w);
    warnColumnsTheInvitationWillNotAccept({
      metadata: dataSpec.metadata,
      columnNames: rows.columns,
      terms: myTerms,
      mode: "online",
      log,
    });

    const prepared = await prepareForOnlineExchange(dataSpec, myIdentity, rows);
    // Lock in the columns the invitation declared the inviter will send, so the
    // exchange aborts if the payload actually received does not match what the
    // operator consented to (see reconcileReceivedPayload). Absent on an
    // invitation that carried no disclosed-subset (an older or metadata-unknown
    // mint path) -- then this party reconciles lazily, as before.
    prepared.expectedPayloadColumns = token.disclosedPayloadColumns;
    return {
      mode: "online",
      url,
      output,
      token,
      connection,
      dataSpec,
      prepared,
      reuseExistingConfig,
      existingOutputShares,
    };
  }

  // Offline: the server-block overrides (--server-* and --outbound-path) and the
  // connection-options overrides (timeouts, --max-reconnect-attempts, the
  // file-sync toggles) cannot take effect (the connection block is seeded from
  // the invitation endpoint or a placeholder, not built from a URL), so warn
  // rather than drop a deliberately-passed flag silently. Two diagnostics: the
  // server block and the connection.options block have distinct remedies.
  warnServerOverridesIgnoredOffline(options, log);
  warnOptionsOverridesIgnoredOffline(options, log);

  // Offline.
  const { reuse: reuseExistingConfig, existingOutputShares } =
    reconcileAcceptConfig({
      configPath: options.configFile,
      myTerms,
      log,
    });
  // `-` is gated on `--consent-to-terms` here exactly as on the online path
  // above: stdin serves the confirmation prompt unless the flag skips it, freeing
  // it for the CSV.
  const rows =
    resolved.input !== undefined
      ? await loadInputRows(resolved.input, { allowStdin: consentToTerms })
      : undefined;
  if (rows !== undefined)
    checkLinkageSatisfiability(
      rows.columns,
      myTerms,
      log,
      INVITATION_PREFLIGHT_MESSAGING,
    );
  const { dataSpec, warnings } = buildDataSpec({
    terms: myTerms,
    identity: myIdentity,
    rows,
  });
  for (const w of warnings) log.warn(w);
  warnColumnsTheInvitationWillNotAccept({
    metadata: dataSpec.metadata,
    columnNames: rows?.columns,
    terms: myTerms,
    mode: "offline",
    log,
  });

  const { connection, seeded } = connectionFromEndpoint(
    token.connectionEndpoint,
  );
  return {
    mode: "offline",
    token,
    connection,
    seeded,
    dataSpec,
    reuseExistingConfig,
    existingOutputShares,
  };
}

/**
 * Reconcile a pre-existing configuration file against an acceptance. Returns
 * `false` when no config exists at `configPath` (a fresh one will be written);
 * `true` when a config exists and agrees with the invitation (and, online, the
 * URL), so it is kept and only the key file is written. Throws a
 * {@link UsageError} -- before the prompt and before any network activity -- when
 * a config exists but disagrees, or cannot be parsed to compare, showing the
 * user exactly what to resolve.
 */
function reconcileAcceptConfig(params: {
  configPath: string;
  myTerms: LinkageTerms;
  target?: RunnableConnectionConfig;
  log: ReturnType<typeof getLogger>;
}): { reuse: boolean; existingOutputShares?: boolean } {
  const { configPath, myTerms, target, log } = params;
  if (detectFileConflicts([configPath]).length === 0) return { reuse: false };

  // Reference to the source(s) compared against, woven into the messages so the
  // online ("invitation and URL") and offline ("invitation") cases read right.
  // A `target` connection is present only online.
  const against =
    target !== undefined
      ? "the invitation and the connection URL"
      : "the invitation";
  const retryWith =
    target !== undefined
      ? "the same URL and invitation"
      : "the same invitation";

  // Parse, then validate, in two steps. The YAML parse can echo source bytes (an
  // inline credential) and warn to stderr, so it routes through the sensitive-
  // file chokepoint (see sensitiveFile.ts); on any parse failure this reports the
  // path and reconciliation guidance, never the parser's message. A schema
  // failure from parseExchangeSpec (Zod) names field paths and issue kinds, not
  // the offending values, so its message is safe to surface (below).
  let parsed: unknown;
  try {
    // The chokepoint's own path-only message is discarded by the catch below,
    // which re-labels with reconciliation guidance; the label is passed only to
    // keep the call signature uniform.
    parsed = parseSensitiveYaml(
      fs.readFileSync(configPath, "utf8"),
      `a configuration file at ${configPath}`,
    );
  } catch {
    throw new UsageError(
      `a configuration file already exists at ${configPath} but is not valid ` +
        `YAML, so it cannot be compared against ${against}. Fix or remove it, ` +
        `or pass --config-file to write elsewhere, then retry with ${retryWith}.`,
    );
  }
  let existing: ExchangeSpec;
  try {
    existing = parseExchangeSpec(parsed);
  } catch (err) {
    throw new UsageError(
      `a configuration file already exists at ${configPath} but could not be ` +
        `parsed to compare against ${against}: ` +
        describeDecodeError(err) +
        `. Fix or remove it, or pass --config-file to write elsewhere, then ` +
        `retry with ${retryWith}.`,
    );
  }

  const { conflicts, warnings } = diffLinkageTerms(
    existing.linkageTerms,
    myTerms,
  );
  for (const w of warnings) log.warn(w);

  const conn: { conflicts: ReconcileDiff[]; warnings: string[] } =
    target !== undefined
      ? diffConnectionAgainstTarget(existing.connection, target)
      : { conflicts: [], warnings: [] };

  const all: ReconcileDiff[] = [...conflicts, ...conn.conflicts];
  if (all.length > 0)
    throw new UsageError(
      `the configuration file at ${configPath} disagrees with ${against}:\n` +
        formatReconcileDiffs(all) +
        `\nResolve the differences (or pass --config-file to write elsewhere), ` +
        `then retry with ${retryWith}.`,
    );

  // A connection field that is "how you reach the same drop" (protocol, port,
  // credentials) may differ without aborting: it applies to this exchange only,
  // and the saved config is deliberately left unchanged (we never clobber the
  // user's stored connection block). Surface the divergence so the user can
  // update the config themselves if they meant it to persist.
  if (conn.warnings.length > 0)
    log.warn(
      `the connection details you specified differ from the saved ` +
        `configuration at ${configPath}; they apply to this exchange only and ` +
        `the saved config is left unchanged:\n` +
        conn.warnings.map((w) => `  - ${w}`).join("\n"),
    );

  log.info(
    conn.warnings.length === 0
      ? `the existing configuration at ${configPath} matches ${against}; ` +
          "it will be reused unchanged."
      : `the existing configuration at ${configPath} will be reused unchanged; ` +
          "the connection differences above apply to this exchange only.",
  );
  // The kept config's own output terms ride back with the verdict: the later
  // run is governed by them, and this diff deliberately compares no output
  // field, so a caller deciding what to record about the acceptor's outbound
  // set must not take the invitation's mirror as the kept config's reality.
  return {
    reuse: true,
    existingOutputShares: existing.linkageTerms.output.shareWithPartner,
  };
}

// --- Linkage preflight -------------------------------------------------------

// Accept adopts only the inviter's linkage terms and infers its standardization
// and metadata from its own CSV (default type-based pipelines, which never remap a
// column onto a field whose type is absent), so it passes neither override to the
// shared check and relies on name inference -- which matches the acceptor's
// exchange-time satisfiability exactly. The override arguments exist for the
// exchange path, whose committed config can carry a remap or an explicit type.
const INVITATION_PREFLIGHT_MESSAGING: LinkagePreflightMessaging = {
  source: "invitation",
  blockRemedy:
    "or ask your partner for an invitation with different linkage terms.",
};

// --- Handler -----------------------------------------------------------------

export async function handler(argv: Arguments): Promise<void> {
  let closeLogging: (() => void) | undefined;
  try {
    await runOrExit("accept", async () => {
      // Parse and apply the log level before creating the logger, so the
      // configured level actually takes effect (loglevel binds a logger's level
      // at creation). Doing this inside runOrExit also routes an invalid option
      // (e.g. an unrecognized --log-level) through the same error->exit path as
      // everything else, rather than yargs's noisier top-level catch.
      const options = parseCommonBootstrapArgs(argv);
      // Install the sink, apply the level, and build getLogger("accept") through
      // the shared configureLogging helper (in that order, so the logger inherits
      // the sink): the file sink when --log-file is given, otherwise the default
      // stderr sink so stdout carries only result data (the exchange CSV when no
      // OUTPUT_FILE positional is given). A missing parent directory is a
      // UsageError -> exit 64, mapped here by the enclosing runOrExit.
      const { log, close } = configureLogging({
        logLevel: options.logLevel,
        logFile: options.logFile,
        name: "accept",
      });
      closeLogging = close;
      const positionals = (argv["args"] as Array<string> | undefined) ?? [];
      // This command sets unknown-options-as-args (so a `-`-leading invitation
      // survives as a positional), which also lets a mistyped `--flag` reach the
      // positionals rather than the top-level strictOptions; reject it here,
      // before the invitation decode, any connection, or any file write.
      assertNoUnknownOptions(positionals);
      const resolved = resolveAcceptPositionals(positionals);
      // --consent-to-terms records advance consent to the invitation's terms and
      // bypasses the confirmation prompt for unattended runs. Read as `=== true`
      // so an absent flag (a hand-built argv in tests, or a parse that did not set
      // it) is a definite false rather than undefined. A boolean option may be
      // repeated, so it is read directly, not via singleValue.
      const consentToTerms = argv["consent-to-terms"] === true;
      // All validation runs before the prompt: the user is never asked to confirm
      // an invitation, URL, or input file that has not validated, and the prompt
      // itself runs inside runOrExit so a stdin error exits cleanly rather than
      // crashing. consentToTerms also lets a `-` input read the CSV from stdin
      // (the prompt that otherwise owns stdin is skipped).
      const ready = await validateAccept({
        resolved,
        options,
        consentToTerms,
        log,
      });

      // The acceptor's own outbound-send set: the columns this party will disclose
      // to the partner for matched records, derived from its own resolved metadata
      // via the same isDisclosedToPartner predicate preparePayload transmits on, so
      // the prompt cannot overstate what leaves this machine.
      //
      // The online path reads it off the PREPARED exchange -- the very object this
      // invocation transmits from -- rather than off the written spec, so the set
      // shown is the set sent even where the spec carries no metadata of its own
      // (an input that satisfies only some linkage keys drops it, and the run then
      // infers one from the same CSV). The offline path has no prepared exchange to
      // read: it writes a configuration and stops, so an absent spec metadata is
      // genuinely not-yet-known and the display forward-references it.
      const ownOutboundSend =
        ready.mode === "online"
          ? disclosedColumnNames(ready.prepared.metadata)
          : ready.dataSpec.metadata !== undefined
            ? disclosedColumnNames(ready.dataSpec.metadata)
            : undefined;
      // This party's consent to its OWN outbound set, recorded into the
      // configuration this acceptance writes so a later run cannot transmit a set no
      // party chose. What is recorded is exactly what the prompt below shows (or
      // what --consent-to-terms records advance consent to), so the two cannot
      // differ. `pending` where the set is not resolvable here: the first run that
      // can resolve it shows and confirms it before connecting, and an unattended
      // run refuses instead. Nothing at all where the invitation gives the inviting
      // party no result -- the payload step then transmits nothing whatever the
      // input holds, so there is no disclosure to consent to, matching the display's
      // no-payload line and the run-time check's own output gate.
      const outboundPayloadConsent: OutboundPayloadConsent | undefined = !ready
        .dataSpec.linkageTerms.output.shareWithPartner
        ? undefined
        : ownOutboundSend === undefined
          ? { status: "pending" }
          : { status: "confirmed", columns: ownOutboundSend };
      // What a REUSED config's record becomes. The later run is governed by the
      // kept config's own terms, and reconciliation compares no output field, so
      // an invitation whose mirror says "nothing transmitted" cannot decide that
      // about a kept config that still shares: deleting the record there would
      // leave the run's gate blind (it no-ops on an absent record) and transmit
      // an unconfirmed set on partner-controlled terms. Where the mirror yields
      // no record but the kept config shares, the safe record is `pending` --
      // this acceptance displayed and confirmed no outbound set for a config
      // that will transmit, so the next run shows and asks, or refuses
      // unattended. Undefined only where the kept config itself does not share
      // (or no config is kept), where a leftover record is inert against the
      // kept config's own terms.
      const reuseOutboundPayloadConsent: OutboundPayloadConsent | undefined =
        outboundPayloadConsent !== undefined
          ? outboundPayloadConsent
          : ready.existingOutputShares === true
            ? { status: "pending" }
            : undefined;
      // Rendered through a sink that knows whether the prompt below will run: when
      // it will, the terms reach the terminal it asks on even when the operator
      // routed diagnostics to a --log-file or above info, so consent is never asked
      // for terms this run did not show. --consent-to-terms asks nothing, so its
      // surface stays plain diagnostic output on the routing the operator chose.
      displayInvitation({
        token: ready.token,
        ownOutboundSend,
        emit: consentSurfaceSink({
          log,
          logFile: options.logFile,
          willPrompt: !consentToTerms,
        }),
        promptFollows: !consentToTerms,
      });
      // With --consent-to-terms, skip the prompt and proceed on the recorded
      // advance consent. Log the bypass so an unattended run's own log shows the
      // human checkpoint was deliberately satisfied ahead of time, not silently
      // absent.
      let confirmed: boolean;
      if (consentToTerms) {
        log.info(
          "--consent-to-terms given: proceeding on advance consent without the " +
            "confirmation prompt.",
        );
        confirmed = true;
      } else {
        confirmed = await promptConfirm(
          "Accept this invitation and write configuration?",
        );
      }
      if (!confirmed) {
        log.info("invitation declined; no files were written");
        return;
      }

      if (ready.mode === "online") {
        const { configWriteError } = await runOnlineBootstrap({
          connection: ready.connection,
          dataSpec: ready.dataSpec,
          prepared: ready.prepared,
          sharedSecret: ready.token.sharedSecret,
          // Pass the invitation's expiry through unchanged; authenticateConnection
          // re-checks it before and after the key exchange.
          expires: ready.token.expires,
          keyPath: options.keyFile,
          configPath: options.configFile,
          output: ready.output,
          verbosity: options.verbosity,
          loggerName: "accept",
          recordOutput: resolveRecordOutput({
            enabled: options.record,
            recordFile: options.recordFile,
          }),
          eventStream: options.eventStream,
          reuseExistingConfig: ready.reuseExistingConfig,
          // Persist the consented received-column lock-in into the fresh config so
          // the later `psilink exchange` enforces it, the online sibling of the
          // offline path's expectedPayloadColumns write below. The set is known up
          // front from the token (in the inviter's namespace), so it rides the
          // acceptance hook's first write; reconcileReceivedPayload then fails closed
          // on a divergent received payload. Absent -- and reconciled lazily -- when
          // the invitation carried no disclosed subset. No-op on the reuse path,
          // which keeps the operator's config untouched.
          expectedReceivedPayloadColumns: ready.token.disclosedPayloadColumns,
          // Record this party's consent to its own outbound set in the same fresh
          // write, so a later `psilink exchange` from this configuration is held to
          // the columns just consented to here. The reuse path writes no fresh
          // config; the hook refreshes the kept config's record surgically instead,
          // with the record derived for the KEPT config's own output terms (the
          // reuse derivation above) -- identical to the invitation-derived record
          // on the fresh path, where the written config's terms are the mirror's.
          outboundPayloadConsent: reuseOutboundPayloadConsent,
        });
        logOnlineBootstrapOutcome(log, {
          configFile: options.configFile,
          keyFile: options.keyFile,
          configWriteError,
          reuseExistingConfig: ready.reuseExistingConfig,
        });
        return;
      }

      const spec: ExchangeSpec = {
        connection: ready.connection,
        ...ready.dataSpec,
        // Persist the consented received-column lock-in so the later `psilink
        // exchange` enforces it. Offline accept's enforcement happens at a separate
        // invocation, so it must be written here; the online path persists the same
        // set into its own fresh config (via runOnlineBootstrap above) in addition to
        // enforcing it in memory for its single run. Carried in the inviter's
        // namespace, distinct from payload.receive. Omitted -- and reconciled lazily
        // -- when the invitation carried no disclosed subset (an older or
        // metadata-unknown mint).
        ...(ready.token.disclosedPayloadColumns !== undefined
          ? { expectedPayloadColumns: ready.token.disclosedPayloadColumns }
          : {}),
        // This party's consent to its own outbound set (see its derivation above),
        // so the later `psilink exchange` sends exactly what was consented to here
        // or stops to ask. Omitted -- and the run left ungated -- only where nothing
        // is transmitted to the partner at all.
        ...(outboundPayloadConsent !== undefined
          ? { outboundPayloadConsent }
          : {}),
      };
      // When reusing a pre-existing config, provisionConfigAndKey ignores `spec`
      // and writes only the key file, leaving the user's config untouched.
      const { configPath, keyPath } = provisionConfigAndKey(
        spec,
        // The acceptor's key file holds the invitation token without an expiry; the
        // inviter's copy carries the expiry. The token rotates on first exchange.
        { sharedSecret: ready.token.sharedSecret },
        { configPath: options.configFile, keyPath: options.keyFile },
        { reuseExistingConfig: ready.reuseExistingConfig },
      );

      if (ready.reuseExistingConfig) {
        // Refresh the consented received-column lock-in in the reused config. The
        // operator has just re-consented to THIS invitation's terms (the prompt
        // above, or --consent-to-terms, gates every write here), so the lock-in is
        // rewritten to the set they consented to on this acceptance -- the token's
        // disclosed subset, in the inviter's namespace. Unlike the connection and
        // linkage blocks (operator prose provisionConfigAndKey deliberately leaves
        // untouched under reuse), this is a machine-managed consent record: leaving
        // a prior acceptance's value stale would false-abort the next recurring
        // exchange after a legitimate re-consent to a changed disclosure. A surgical
        // one-field write; undefined (an older or metadata-unknown mint) removes the
        // field so the exchange reconciles lazily, an empty set is a strict "receive
        // nothing". The fresh-config paths persist the same set via their own write.
        persistExpectedPayloadColumns(
          configPath,
          ready.token.disclosedPayloadColumns,
        );
        // Refresh this party's own outbound-set consent in the reused config for the
        // same reason: the operator has just re-consented on THIS acceptance, so the
        // record is rewritten to what they were shown here rather than left at a
        // prior acceptance's value. Where this acceptance could not resolve the set
        // it records `pending`, which asks at the first run that can. The removal
        // case follows the KEPT config's own output terms, not the invitation's
        // mirror (the reuse derivation above): reconciliation compares no output
        // field, so a partner-supplied invitation must not be able to delete the
        // record from a config that still transmits.
        persistOutboundPayloadConsent(configPath, reuseOutboundPayloadConsent);
        log.info(
          `reused the existing configuration at ${configPath}; it already matches ` +
            "the invitation, so the connection and linkage settings are unchanged.",
        );
      } else if (ready.seeded)
        log.info(
          `wrote config to ${configPath}, seeding the connection block from the ` +
            "invitation's endpoint; review it and add your own credentials " +
            "before running 'psilink exchange'.",
        );
      else
        log.info(
          `wrote config to ${configPath}; fill in the connection block before ` +
            "running 'psilink exchange'.",
        );
      log.info(`wrote key file to ${keyPath}. Keep it private.`);
    });
  } finally {
    // Restore the loglevel factory (and close the log-file descriptor, for the
    // file sink) on the normal exit path. Writes are synchronous and already
    // durable, so the error path's process.exit (which bypasses this finally)
    // loses nothing -- this is only factory/descriptor cleanup.
    closeLogging?.();
  }
}
