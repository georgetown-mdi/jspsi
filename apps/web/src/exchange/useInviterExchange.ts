import log from "loglevel";

import { useEffect, useMemo, useRef, useState } from "react";

// @ts-ignore this is really there
import PSI from "@openmined/psi.js/psi_wasm_web";

import {
  LinkageTermsUnsatisfiableError,
  joinErrorCauseChain,
  loadPsiBackend,
  prepareForExchange,
  sanitizeErrorChainLinks,
  sanitizeErrorForDisplay,
} from "@psilink/core";

import {
  JobApiRequestError,
  RelayedTerminalError,
  createFetchJobApiClient,
  createServerJobExchangeDriver,
} from "@psi/jobClient/serverJobExchangeDriver";
import {
  discardServerJob,
  writeAttachment,
} from "@psi/jobClient/consoleJobAttachment";
import { HANDSHAKE_ROLE_FOR_SIDE } from "@psi/handshakeRole";
import { createBrowserExchangeDriver } from "@psi/exchangeDriver";
import { hasRecoveryHint } from "@psi/authenticateExchange";
import { inviterExchangeDataSpec } from "@psi/authoring/advancedInvite";
import { listenAsInviter } from "@psi/transport/rendezvous";
import { waitForIncomingConnection } from "@psi/transport/waitForConnection";

import { isConsoleBuild } from "@utils/clientConfig";
import { whenDiagnostic } from "@utils/diagnostics";

import { buildRunOutputs } from "@psi/runOutputs";
import { invitationUsable } from "@psi/formatting";
import { selectExchangeDriver } from "@psi/exchangeDriverSelection";

import { buildRunEvents } from "./runEvents";

import {
  WAITING_STAGE_ID,
  initialRun,
  runWithFailure,
  stagesFor,
} from "./exchangeRun";

import type { PSILibrary } from "@openmined/psi.js/implementation/psi.d.ts";

import type {
  Acquire,
  ExchangeErrorCategory,
  GenerateOutput,
} from "@psi/exchangeLifecycle";
import type { ExchangeRun, ExchangeSeat } from "./exchangeRun";
import type {
  JobInputSource,
  JobRunStatus,
  ServerJobExchangeDriverConfig,
  ServerJobExchangeTransport,
} from "@psi/jobClient/serverJobExchangeDriver";
import type { ExchangeDriver } from "@psi/exchangeDriver";
import type { GeneratedInvitation } from "@psi/invitation";
import type { JobExchangeOptions } from "@jobs/intentSchemas";
import type { ReceiptsIntentFields } from "@psi/receiptsModel";
import type { RunDiagnosticsIntentFields } from "@psi/runDiagnosticsModel";
import type { RunOutputs } from "@psi/runOutputs";
import type { Transport } from "@psi/transportChooser";

/** A failed run, ready to render: the lifecycle's category (which decides the
 * recovery the alert offers) and the operator-facing alert content, composed
 * here so the sanitize-at-the-display-boundary discipline stays beside the
 * error it applies to. */
export interface RunFailure {
  category: ExchangeErrorCategory;
  title: string;
  message: string;
}

/**
 * Escape a failure's text at this boundary rather than with
 * `sanitizeErrorForDisplay`'s per-value default. A {@link RelayedTerminalError}
 * alone holds a chain the relay already rendered and escaped link-by-link, so
 * it alone is safe to split on the renderer's framing and rejoin -- escaping
 * that chain as one value instead cuts it inside the first link or two
 * (docs/spec/CLI_EVENTS.md, "Sanitization"; docs/spec/CHANNEL_SECURITY.md,
 * "Display sanitization escape format"). Every other failure is raw, thrown in
 * this browser, and goes straight through `sanitizeErrorForDisplay`. The
 * framing is the renderer's own newline, laid out as a line break by
 * `FailureMessage` in `./RunSurface`.
 */
function sanitizedFailureMessage(error: unknown): string {
  return error instanceof RelayedTerminalError
    ? joinErrorCauseChain(sanitizeErrorChainLinks(error.message))
    : sanitizeErrorForDisplay(error);
}

/** @internal */
export function failureFor(
  category: ExchangeErrorCategory,
  error: unknown,
  inputSource?: JobInputSource,
  channel?: Transport,
  seat: ExchangeSeat = "inviter",
): RunFailure {
  // The console already holds an exchange (its single slot is occupied), so the
  // create was rejected 409 -- the driver categorizes it retryable `exchange`. The
  // copy is accurate about the one-slot model: the run is not lost, it is
  // elsewhere, and the ways back are its own page, the recovery panel's discard,
  // or a restart. Retry then succeeds once the slot is freed.
  if (error instanceof JobApiRequestError && error.status === 409) {
    return {
      category: "exchange",
      title: "This console is already running an exchange",
      message:
        "This console is already holding an exchange. Return to the page " +
        "where you started it, or discard it from the recovery panel; " +
        "restarting the console also clears it.",
    };
  }
  // A console job create rejected the mounted file: a 400 the driver categorizes
  // `config`. The file is the likely fault, so the alert names it -- except on
  // the sftp channel, where a vanished picked remote is equally likely, so that
  // copy names both causes. Each recovery names the control the seat's alert
  // offers: the inviter's start-over reaches the file picker; the acceptor's
  // only recovery returns to its columns step (whose Back link re-selects the
  // file). The accept guard admits no sftp endpoint, so the sftp branch is the
  // inviter's alone.
  if (
    category === "config" &&
    inputSource?.kind === "workFile" &&
    error instanceof JobApiRequestError &&
    error.status === 400
  ) {
    const fileGone =
      "The console could not use this file. It may have been removed " +
      "since you selected it. ";
    return {
      category,
      title: "The console could not start this exchange",
      message:
        channel === "sftp"
          ? "The console could not use this file, or the selected SFTP " +
            "destination is no longer available. Start over and check the file " +
            "and destination."
          : seat === "acceptor"
            ? fileGone +
              "Go back to your columns, then choose a different file."
            : fileGone + "Start over and select it again.",
    };
  }
  if (category === "output") {
    // The exchange succeeded; only a local write failed, so this alert must
    // not invite a re-run of a privacy-sensitive exchange -- unlike the other
    // categories it offers no retry control, and says so explicitly. The
    // cause is either this browser's own results-file build or the console's
    // report of a lost local write it cannot name, so the message claims only
    // that a local write failed. Sanitized at the display boundary like any
    // operator-facing alert.
    return {
      category,
      title: "Results unavailable",
      message:
        "The linkage completed, so do not run this exchange again - a second " +
        "run would send your data for an exchange that already happened. On " +
        "this machine, a local write failed: " +
        sanitizedFailureMessage(error),
    };
  }
  if (error instanceof LinkageTermsUnsatisfiableError) {
    // The pre-connection refusal for a file that cannot supply every linkage key
    // the agreed terms declare. Fixed and non-oracular: the refusal enumerates
    // only the agreed terms' own key and field names (partner-authored on every
    // accept path); the operator reads which keys are short off the per-key
    // verdict on the columns step, not from this alert. Classified `config`, so
    // the alert offers start-over rather than a retry -- the same file refuses
    // identically however many times it runs.
    return {
      category: "config",
      title: "This file cannot supply the linkage keys you agreed to",
      message:
        "This exchange matches on every linkage key its terms declare, and " +
        "your file cannot supply them all, so it stopped before connecting " +
        "and nothing left this device. Start over with a file whose columns " +
        "cover the agreed keys, or settle new terms with your partner over " +
        "the keys both of your files can supply.",
    };
  }
  if (category === "config") {
    // A prepare-time fault in the operator's OWN config, safe to show because
    // an OperatorConfigError's message names only local content (the
    // lifecycle scopes "config" to that type). Not a transport drop -- retrying
    // as-is fails identically -- so the alert offers start-over (back to
    // Review & create with every input intact, where the work column's
    // Problems block routes to the fix) rather than a retry.
    return {
      category,
      title: "Could not prepare the exchange",
      message: sanitizedFailureMessage(error),
    };
  }
  if (category === "security") {
    // A tagged credential/expiry error's message is composed only from local
    // values and holds its own recovery guidance (core's recovery-hint
    // contract, preserved across authenticateExchange's re-wrap), so it is
    // safe and more accurate to show than partner-blame copy: an expired
    // invitation is not a failed partner check. Still the security category,
    // so the alert offers only a fresh invitation -- correct for expiry too.
    if (hasRecoveryHint(error)) {
      return {
        category,
        title: "This invitation can no longer be used",
        message: sanitizedFailureMessage(error),
      };
    }
    // The authenticated key exchange failed closed: this connection could not
    // be confirmed as the invited partner. Not retryable -- a silent retry
    // would re-run into the same wrong secret, or into a peer that is
    // tampering -- so the copy forbids it and steers to a fresh invitation.
    // The underlying error is dev-gated to the console (below) and kept out
    // of the alert: the kex failure message is non-oracular by design.
    return {
      category,
      title: "Could not verify your partner",
      message:
        "The check that proves the other side holds this invitation's " +
        "secret did not pass. Do not retry; start over with a fresh " +
        "invitation.",
    };
  }
  // Generic, retryable transport/exchange failure. The raw error is written
  // for a developer and can embed partner-/server-controlled bytes, so the
  // alert uses a fixed, friendly message; the detailed error stays in the
  // dev-gated console.error for diagnosis. A mid-run drop lands here too,
  // after agreed payload columns may already have flowed to the
  // authenticated partner, so the copy must not claim the data stayed local.
  //
  // A filedrop run never opens a connection: its two halves rendezvous through a
  // synced shared folder, so a temporary-connection message misdirects. Name the
  // shared-state cause instead, built only from operator-known facts (never the
  // partner's path or raw fs error text). Both messages keep the retry affordance.
  return {
    category,
    title: "Exchange failed",
    message:
      channel === "filedrop"
        ? "The partner's half never appeared in the shared folder. Confirm you " +
          "both point at the same synced directory and that it is syncing, then " +
          "try again."
        : "The exchange could not be completed - usually a temporary " +
          "connection problem rather than an issue with your data.",
  };
}

/**
 * Assemble the {@link ServerJobExchangeDriverConfig} for a console server-job
 * invite -- a file-drop or an SFTP exchange the console runs on this party's
 * behalf. `transport` picks the intent arm; the SFTP arm has no connection
 * field because the console reads the operator-authored connection off
 * `GET /api/jobs/sftp`, so no host, credential, or fingerprint transits the
 * browser. Everything below the discriminant is channel-independent.
 * `linkageTerms` is the same value embedded in the minted token, reused
 * rather than re-derived, so the terms the partner adopts cannot diverge
 * from the terms this run executes on.
 *
 * This party's authored metadata and standardization ride along when the
 * mint resolved them, so the console's CLI honors the operator's data-prep
 * edits rather than inferring metadata from the CSV column names; an
 * unresolved field is forwarded as absent, matching how the browser path
 * guards these fields.
 *
 * `side` is the inviter's, so the config has no `outbound_payload_consent` --
 * this party authored its own outbound set at mint, and the invitation is
 * that statement. The acceptor's outbound set is unauthored and recorded
 * instead (see `acceptorServerJobConfig`); likewise only the acceptor sets
 * `expectedPayloadColumns`.
 *
 * Pure and exported so the derivation is the tested boundary, pinned without
 * running the hook.
 *
 * @internal
 */
export function inviterServerJobConfig({
  minted,
  inputSource,
  transport,
  options,
  runDiagnostics,
  receipts,
}: {
  minted: Pick<
    GeneratedInvitation,
    "linkageTerms" | "sharedSecret" | "metadata" | "standardization"
  >;
  inputSource: JobInputSource;
  transport: ServerJobExchangeTransport;
  /** The review step's file-handling choices, already resolved through core's
   * retain-mode implication. Absent when the operator changed nothing, so the
   * composed config has no `options` block at all. */
  options?: JobExchangeOptions;
  /** The review step's per-run diagnostic and recovery choices, forwarded to the
   * intent unchanged. */
  runDiagnostics?: RunDiagnosticsIntentFields;
  /** The review step's receipt-signing and retention choices, forwarded to the
   * intent unchanged. */
  receipts?: ReceiptsIntentFields;
}): ServerJobExchangeDriverConfig {
  return {
    transport,
    side: "inviter",
    linkageTerms: minted.linkageTerms,
    sharedSecret: minted.sharedSecret,
    inputSource,
    ...(minted.metadata !== undefined ? { metadata: minted.metadata } : {}),
    ...(minted.standardization !== undefined
      ? { standardization: minted.standardization }
      : {}),
    ...(options !== undefined ? { options } : {}),
    ...(runDiagnostics !== undefined ? { runDiagnostics } : {}),
    ...(receipts !== undefined ? { receipts } : {}),
  };
}

/**
 * The run half of the inviter console, started the moment the invitation is
 * minted: listen on the invitation's derived id, run the exchange when the
 * partner connects, and show the downloads. The connection lifecycle
 * (acquire/open/run/teardown, abort in any phase) is {@link runExchangeLifecycle},
 * exactly as the current exchange screen drives it; this hook owns the single
 * AbortController per invitation and folds the lifecycle's events into the
 * console's pure {@link ExchangeRun} model for the timeline and status panel.
 *
 * A regenerated invitation (a new object after start-over) restarts the whole
 * run: the effect keyed on `invitation` aborts the old lifecycle and starts a
 * fresh one, the console-side equivalent of the current app keying its
 * exchange subtree by the shared secret.
 */
export function useInviterExchange({
  invitation,
  inviterName,
  channel,
  inputSource,
  sftpConfigured,
  options,
  runDiagnostics,
  receipts,
}: {
  invitation: GeneratedInvitation | undefined;
  inviterName: string;
  /** The transport chosen at Review & create, driving which {@link ExchangeDriver}
   * this run builds. A live run only ever starts for a channel the selector maps
   * to a live kind; the owner withholds the invitation for a save-file channel. */
  channel: Transport;
  /** Where the console reads this party's input from on a server-job run
   * ({@link JobInputSource}): the console picker's mounted-file reference. Undefined
   * on the browser path, which re-parses the retained rows off the minted invitation
   * and never reads this. */
  inputSource: JobInputSource | undefined;
  /** Whether the console has an authored SFTP connection -- the selector's third
   * input, threaded from the owner's fetch so this hook and the owner route
   * identically. */
  sftpConfigured: boolean;
  /** The review step's file-handling choices for a server-job run. Undefined when
   * the operator changed nothing; unused on the browser path, which conducts the
   * exchange over WebRTC and has no shared directory to tune. */
  options?: JobExchangeOptions;
  /** The review step's per-run diagnostic and recovery choices, forwarded to the
   * intent unchanged; unused on the browser path for the same reason. */
  runDiagnostics?: RunDiagnosticsIntentFields;
  /** The review step's receipt-signing and retention choices, forwarded to the
   * intent unchanged; unused on the browser path, which produces no CLI config and
   * signs no receipt. */
  receipts?: ReceiptsIntentFields;
}): {
  run: ExchangeRun;
  outputs: RunOutputs | undefined;
  failure: RunFailure | undefined;
  warnings: ReadonlyArray<string>;
  /** The console job id of the current server-job run, once created; undefined
   * on a browser run and before the job exists. Drives the completed-run recurring
   * hand-off panel. */
  jobId: string | undefined;
  /** The live status of the exchange this run re-attached to on a busy (409)
   * create, or undefined on a fresh run. Set when a start-time 409 re-attaches to
   * the exchange holding the console's single slot -- the run surface then heads
   * with recovery-style copy rather than fresh-success copy. */
  reattached: JobRunStatus | undefined;
  /** True from the moment a busy (409) create is detected until the liveness probe
   * settles: the interim during which the run surface suppresses the fresh-run
   * share block and shows a brief reconnecting notice, before it either resolves
   * to the recovery view (`reattached`) or falls back to the run's alert. */
  reattaching: boolean;
  tryAgain: () => void;
  abandonRun: () => void;
} {
  const [run, setRun] = useState<ExchangeRun>(initialRun);
  const [outputs, setOutputs] = useState<RunOutputs>();
  const [failure, setFailure] = useState<RunFailure>();
  const [warnings, setWarnings] = useState<Array<string>>([]);
  // The status of an exchange this run re-attached to on a busy (409) create,
  // else undefined. Drives the run surface's recovery-style copy; reset when a run
  // restarts or the invitation is discarded.
  const [reattached, setReattached] = useState<JobRunStatus>();
  // True while a detected busy (409) create is being resolved to a re-attachment,
  // before the liveness probe settles. Drives the interim reconnecting notice and
  // the fresh-run share-block suppression; reset when a run restarts or the
  // invitation is discarded.
  const [reattaching, setReattaching] = useState(false);
  // The current run's console job id as reactive state (the ref below drives the
  // synchronous discard paths). Set on create, cleared when a run restarts or the
  // invitation is discarded, so the recurring hand-off panel reads only the live run.
  const [currentJobId, setCurrentJobId] = useState<string>();

  // The job API client used by the deliberate-discard paths (try again, start
  // over, run another): one instance per hook so the strand-recovery DELETEs use
  // the same fetch client the driver does. The server-job driver keeps its own
  // default client; this hook only needs one for `discardServerJob`.
  const jobApiClient = useMemo(() => createFetchJobApiClient(), []);

  // The console job id of the current run, stamped by the driver's `onJobCreated`
  // once `POST /api/jobs` resolves. Read by `tryAgain` (to DELETE the failed job
  // before recreating, which reject-until-DELETE would otherwise 409) and by
  // `abandonRun` (to discard the current job when the operator leaves).
  // Undefined on a browser run, and until the first job is created.
  const currentJobIdRef = useRef<string | undefined>(undefined);

  // Drives the lifecycle's AbortSignal; the effect cleanup below aborts it so
  // an unmount (or a superseded invitation) tears down any in-flight wait or
  // exchange and every owner-driven callback stops firing. The cleanup also
  // clears the ref: under React StrictMode's mount/unmount/mount the start
  // effect re-runs, and a stale aborted controller left in the ref would trip
  // the re-entry guard and the real run would never start.
  const abortRef = useRef<AbortController | undefined>(undefined);

  // Revoke this run's object URLs when they are replaced or the owner
  // unmounts: createObjectURL keeps each Blob alive until revoked, and the
  // verification-keys blob is private material, so it should not outlive the
  // run that backs it.
  useEffect(() => {
    if (outputs === undefined) return;
    return () => {
      if (outputs.kind === "matched")
        window.URL.revokeObjectURL(outputs.resultsUrl);
      if (outputs.record !== undefined) {
        window.URL.revokeObjectURL(outputs.record.recordUrl);
        window.URL.revokeObjectURL(outputs.record.keysUrl);
      }
    };
  }, [outputs]);

  function start(minted: GeneratedInvitation) {
    // Guard against re-entry: once a run is in flight its AbortController is
    // stored here, and starting a second would orphan the first's signal and
    // race two lifecycles on shared state. A deliberate restart (try again,
    // a new invitation) clears the ref first.
    if (abortRef.current) return;
    const controller = new AbortController();
    abortRef.current = controller;

    setRun(initialRun());
    setOutputs(undefined);
    setFailure(undefined);
    setWarnings([]);
    setCurrentJobId(undefined);
    setReattached(undefined);
    setReattaching(false);

    // Output-generation half. The URLs the build creates are revoked when the
    // outputs are replaced or the console unmounts (effect above); a throw
    // mid-build revokes its own partial URLs (see buildRunOutputs).
    const generateOutput: GenerateOutput<RunOutputs> = (result, prepared) => {
      log.info("linkage complete, generating results and record files");
      return buildRunOutputs(result, prepared, {
        create: (blob) => window.URL.createObjectURL(blob),
        revoke: (url) => window.URL.revokeObjectURL(url),
      });
    };

    // The inviter is the PSI responder: it must attach its inbound listener
    // before the WASM library resolves, so `psi` stays a pending promise here
    // and the lifecycle awaits it late (after the message connection opens).
    const acquire: Acquire = async ({ signal, onStage, onStages }) => {
      const psi = loadPsiBackend(
        { loadWasm: () => PSI() as Promise<PSILibrary> },
        { isNode: false },
      ).then((selection) => selection.library);
      // The owner awaits `psi` late; if connection setup fails or the signal
      // aborts first, that await is never reached. A fire-and-forget handler
      // keeps a rejecting PSI() on a torn-down exchange from becoming an
      // unhandled rejection -- the real `await psi` still throws.
      void psi.catch(() => undefined);

      // The exchange runs on the very terms embedded in the token (the
      // acceptor adopts them from the invitation), with this party's authored
      // metadata and standardization threaded in locally -- the same spec
      // assembly the current exchange screen performs, through the same
      // builder that reconciles authored standardization to the terms.
      const prepared = prepareForExchange(
        inviterExchangeDataSpec(minted.linkageTerms, {
          metadata: minted.metadata,
          standardization: minted.standardization,
        }),
        inviterName,
        minted.rawRows,
        minted.columns,
      );
      onStages(stagesFor(prepared));

      onStage(WAITING_STAGE_ID);
      // Listen on the derived inviter id, then await the acceptor's inbound
      // connection. Destroy the peer on a wait failure so acquisition stays
      // atomic (the lifecycle's teardown only ever covers a returned
      // {peer, conn}).
      const peer = await listenAsInviter(minted.sharedSecret, { signal });
      try {
        const conn = await waitForIncomingConnection(peer, { signal });
        return { peer, conn, psi, prepared };
      } catch (error) {
        peer.destroy();
        throw error;
      }
    };

    const browserDriver = (): ExchangeDriver<RunOutputs> =>
      createBrowserExchangeDriver<RunOutputs>({
        acquire,
        exchangeRole: HANDSHAKE_ROLE_FOR_SIDE.inviter,
        sharedSecret: minted.sharedSecret,
        expires: minted.expires,
        generateOutput,
      });

    // The transport a server-job run rides: an sftp channel has no
    // connection field (the console holds the authored server), any other
    // server-job channel is filedrop. Reached only for a server-job selection,
    // which the selector never produces for `browser`.
    const serverJobTransport = (): ServerJobExchangeTransport =>
      channel === "sftp" ? { channel: "sftp" } : { channel: "filedrop" };

    // The console conducts the exchange: the driver POSTs the sealed
    // terms, this party's authored metadata/standardization (when
    // present, so the CLI honors the operator's data-prep edits rather than
    // inferring), the shared secret, and the input source to the job API, then
    // maps the server's event stream onto the same lifecycle events. The input
    // source is a REFERENCE to the operator-mounted file, so no content
    // transits the browser. It owns no peer connection or PSI library, so
    // `acquire`/`generateOutput` go unused on this path.
    const serverJobDriver = (): ExchangeDriver<RunOutputs> => {
      if (inputSource === undefined)
        throw new Error("no input source for the server-job exchange");
      const transport = serverJobTransport();
      return createServerJobExchangeDriver({
        ...inviterServerJobConfig({
          minted,
          inputSource,
          transport,
          ...(options !== undefined ? { options } : {}),
          ...(runDiagnostics !== undefined ? { runDiagnostics } : {}),
          ...(receipts !== undefined ? { receipts } : {}),
        }),
        // Persist the created job's id so a reload or hard tab close can re-attach
        // to the console's run, and track it for the deliberate-discard paths.
        onJobCreated: (jobId) => {
          currentJobIdRef.current = jobId;
          setCurrentJobId(jobId);
          writeAttachment({
            jobId,
            seat: "inviter",
            channel: transport.channel,
          });
        },
      });
    };

    const runMode = selectExchangeDriver(
      channel,
      isConsoleBuild() ? "console" : "hosted",
      sftpConfigured,
    ).kind;

    // Raise a failure's alert and freeze the run: the terminal path for every
    // error except a busy (409) create, which re-attaches instead.
    const raiseFailure = (category: ExchangeErrorCategory, error: unknown) => {
      setFailure(failureFor(category, error, inputSource, channel));
      setRun((current) => runWithFailure(current));
    };

    const runEvents = buildRunEvents({
      signal: controller.signal,
      seat: "inviter",
      channel,
      client: jobApiClient,
      raiseFailure,
      setRun,
      setOutputs,
      setWarnings,
      setReattached,
      setReattaching,
      setJobId: (id) => {
        currentJobIdRef.current = id;
        setCurrentJobId(id);
      },
    });

    void (async () => {
      let driver: ExchangeDriver<RunOutputs>;
      try {
        driver = runMode === "server-job" ? serverJobDriver() : browserDriver();
      } catch (error) {
        if (controller.signal.aborted) return;
        whenDiagnostic(() => console.error(error));
        setFailure(failureFor("exchange", error));
        setRun((current) => runWithFailure(current));
        return;
      }
      await driver.run(runEvents);
    })();
  }

  // Start the run the moment an invitation exists -- the console's partner may
  // open the link right away, so the inviter listens without a Start press,
  // exactly as the current app's post-generate screen does. Keyed on the
  // invitation: a superseded or discarded invitation aborts its run, and a
  // fresh mint after start-over begins a fresh one.
  const startRef = useRef(start);
  startRef.current = start;
  useEffect(() => {
    if (invitation === undefined) {
      // Start-over discarded the invitation: drop the finished run's state so
      // the output URLs are revoked now (the revocation effect's cleanup)
      // rather than lingering until the console unmounts.
      setRun(initialRun());
      setOutputs(undefined);
      setFailure(undefined);
      setWarnings([]);
      setCurrentJobId(undefined);
      setReattached(undefined);
      setReattaching(false);
      return;
    }
    startRef.current(invitation);
    return () => {
      abortRef.current?.abort();
      abortRef.current = undefined;
    };
  }, [invitation]);

  // Offered by the retryable-failure alert alone: the run is over (the
  // lifecycle tore down), so a fresh listen on the same invitation cannot race
  // it, and the same secret stays valid for the partner's original link --
  // the security category instead forces a fresh invitation, and an output
  // failure must not re-run an exchange that already succeeded. Gated on the
  // invitation's expiry as well: re-listening on a lapsed credential cannot
  // succeed (no peer can pass it) and would keep the dead link advertised.
  function tryAgain() {
    if (
      invitation === undefined ||
      failure?.category !== "exchange" ||
      !invitationUsable(invitation.expires, new Date())
    )
      return;
    const retryInvitation = invitation;
    abortRef.current?.abort();
    abortRef.current = undefined;
    const runMode = selectExchangeDriver(
      channel,
      isConsoleBuild() ? "console" : "hosted",
      sftpConfigured,
    ).kind;
    const failedJobId = currentJobIdRef.current;
    // A server-job retry must DELETE the failed (already-terminal) job before
    // recreating: reject-until-DELETE 409s the create while the prior exchange
    // still occupies the console's single slot. A browser retry re-listens with
    // no server job to discard.
    if (runMode === "server-job" && failedJobId !== undefined) {
      currentJobIdRef.current = undefined;
      void discardServerJob(jobApiClient, failedJobId).then(() =>
        start(retryInvitation),
      );
      return;
    }
    start(retryInvitation);
  }

  // Discard the current server-job exchange when the operator leaves (start
  // over, run another): cancel-if-running, DELETE, clear the recovery record.
  // Fire-and-forget -- the caller navigates away -- and a no-op on a browser
  // run or before any job exists. This is what frees the console's single
  // slot for the next exchange.
  function abandonRun() {
    const jobId = currentJobIdRef.current;
    if (jobId === undefined) return;
    currentJobIdRef.current = undefined;
    void discardServerJob(jobApiClient, jobId);
  }

  return {
    run,
    outputs,
    failure,
    warnings,
    jobId: currentJobId,
    reattached,
    reattaching,
    tryAgain,
    abandonRun,
  };
}
