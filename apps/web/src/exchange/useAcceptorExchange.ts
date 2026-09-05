import log from "loglevel";

import { useEffect, useMemo, useRef, useState } from "react";

// @ts-ignore this is really there
import PSI from "@openmined/psi.js/psi_wasm_web";

import { deriveAcceptedLinkageTerms, loadPsiBackend } from "@psilink/core";

import {
  createFetchJobApiClient,
  createServerJobExchangeDriver,
} from "@psi/jobClient/serverJobExchangeDriver";
import {
  discardServerJob,
  writeAttachment,
} from "@psi/jobClient/consoleJobAttachment";
import { HANDSHAKE_ROLE_FOR_SIDE } from "@psi/handshakeRole";
import { createBrowserExchangeDriver } from "@psi/exchangeDriver";
import { dialAsAcceptor } from "@psi/transport/rendezvous";

import { deploymentProfile } from "@utils/clientConfig";
import { whenDiagnostic } from "@utils/diagnostics";

import { selectExchangeDriver } from "@psi/exchangeDriverSelection";

import { appendSanitizedRunWarning } from "@psi/runWarnings";
import { buildRunOutputs } from "@psi/runOutputs";
import { invitationUsable } from "@psi/inviterModel";

import {
  WAITING_STAGE_ID,
  initialRun,
  runWithCompletion,
  runWithFailure,
  runWithStage,
  runWithStages,
  stagesFor,
} from "./exchangeRun";
import { isExchangeBusyError, reattachOnBusy } from "./reattachOnBusy";
import { failureFor } from "./useInviterExchange";
import { prepareAcceptorExchange } from "./acceptorExchange";

import type { PSILibrary } from "@openmined/psi.js/implementation/psi.d.ts";

import type {
  AcceptableInvitation,
  AcceptorDataEdits,
} from "@psi/acceptInvitation";
import type {
  Acquire,
  ExchangeErrorCategory,
  GenerateOutput,
} from "@psi/exchangeLifecycle";
import type { CSVRow, InvitationToken } from "@psilink/core";
import type { ExchangeDriver, ExchangeDriverEvents } from "@psi/exchangeDriver";
import type {
  JobInputSource,
  JobRunStatus,
  ServerJobExchangeDriverConfig,
  ServerJobExchangeTransport,
} from "@psi/jobClient/serverJobExchangeDriver";
import type { ExchangeRun } from "./exchangeRun";
import type { JobExchangeOptions } from "@jobs/intent";
import type { ReceiptsIntentFields } from "@psi/receiptsModel";
import type { RunDiagnosticsIntentFields } from "@psi/runDiagnosticsModel";
import type { RunFailure } from "./useInviterExchange";
import type { RunOutputs } from "@psi/runOutputs";
import type { Transport } from "@psi/inviterModel";

/** The connection-endpoint channels the acceptor can drive, narrowed from the
 * token by {@link prepareAcceptedInvitation}: WebRTC always, file-drop or SFTP on
 * a console build. */
type AcceptEndpointChannel = AcceptableInvitation["endpoint"]["channel"];

const ENDPOINT_CHANNEL_TRANSPORT: Record<AcceptEndpointChannel, Transport> = {
  webrtc: "browser",
  filedrop: "filedrop",
  sftp: "sftp",
};

/** Map an accepted invitation's connection-endpoint channel to the console
 * {@link Transport} the driver selector keys on. Keying off the endpoint channel
 * type means a widened channel union fails to build here until it is mapped. */
function transportForEndpointChannel(
  channel: AcceptEndpointChannel,
): Transport {
  return ENDPOINT_CHANNEL_TRANSPORT[channel];
}

/**
 * Assemble the {@link ServerJobExchangeDriverConfig} for a console server-job
 * accept -- a file-drop or an SFTP exchange the console runs on this party's
 * behalf. The SFTP arm has no connection field: the console reads the
 * operator-authored connection off `GET /api/jobs/sftp`, so no host, credential,
 * or fingerprint transits the browser.
 *
 * `linkageTerms` are the acceptor's OWN-PERSPECTIVE terms
 * ({@link deriveAcceptedLinkageTerms}, the same derivation
 * {@link acceptorExchangeDataSpec} applies on the browser path), never the raw
 * inviter-perspective `token.linkageTerms`, which would run the acceptor under
 * the wrong identity and output direction.
 *
 * `expectedPayloadColumns` is set explicitly from the invitation's
 * `disclosedPayloadColumns`, mirroring {@link prepareAcceptorExchange}: the CLI
 * takes this over the `linkageTerms.payload.receive` fallback, which is
 * undefined for a token that discloses columns but has no `payload.send` -- a
 * shape a malicious inviter can craft, and one where the fallback would fail
 * OPEN (silently ingesting extra partner columns) while the browser aborts.
 *
 * The confirm-columns `edits` are threaded into the config so the CLI honors
 * them rather than inferring metadata from the CSV column names, and the
 * stated `side` is what makes the composed config hold this party's
 * `outbound_payload_consent`, derived from these `edits.metadata`.
 *
 * Pure and exported so the derivation is the tested boundary, without running
 * the hook.
 *
 * @internal
 */
export function acceptorServerJobConfig({
  token,
  acceptorName,
  edits,
  inputSource,
  transport,
  options,
  runDiagnostics,
  receipts,
}: {
  token: InvitationToken;
  acceptorName: string;
  edits: AcceptorDataEdits;
  inputSource: JobInputSource;
  transport: ServerJobExchangeTransport;
  /** The confirm-columns step's file-handling choices, already resolved through
   * core's retain-mode implication. Absent when the operator changed nothing, so
   * the composed config includes no `options` block at all. */
  options?: JobExchangeOptions;
  /** The same step's per-run diagnostic and recovery choices, forwarded to the
   * intent unchanged. */
  runDiagnostics?: RunDiagnosticsIntentFields;
  /** The same step's receipt-signing and retention choices, forwarded to the
   * intent unchanged. */
  receipts?: ReceiptsIntentFields;
}): ServerJobExchangeDriverConfig {
  return {
    transport,
    side: "acceptor",
    ...(options !== undefined ? { options } : {}),
    ...(runDiagnostics !== undefined ? { runDiagnostics } : {}),
    ...(receipts !== undefined ? { receipts } : {}),
    linkageTerms: deriveAcceptedLinkageTerms(token.linkageTerms, acceptorName),
    sharedSecret: token.sharedSecret,
    inputSource,
    metadata: edits.metadata,
    standardization: edits.standardization,
    // The received-payload enforcement, mirrored from the invitation's disclosed set
    // exactly as the browser accept path does (prepareAcceptorExchange ->
    // prepared.expectedPayloadColumns). Passed through AS-IS: undefined when the
    // token omits it (lazy), an empty array when the disclosed set is empty
    // (strict "receive nothing"). Without it the CLI falls back to
    // linkageTerms.payload.receive, which is undefined for a token that discloses
    // columns but has no payload.send -- a shape that would then fail OPEN,
    // silently ingesting extra partner columns where the browser aborts.
    expectedPayloadColumns: token.disclosedPayloadColumns,
    // The terms-side enforcement, mirrored from the invitation's declared
    // `deduplicate` for the INVITER's own side exactly as the browser accept path
    // does (prepareAcceptorExchange -> prepared.expectedPartnerDeduplicate). The
    // console runs this config through `psilink exchange` at a separate
    // invocation, so a binding held only in the browser's memory would bind
    // nothing there; including it makes the CLI refuse an inviter presenting a
    // value this acceptance did not consent to. Read off the token's own terms,
    // never the derived acceptor perspective above, whose `deduplicate` is this
    // party's own mirrored false.
    expectedPartnerDeduplicate: token.linkageTerms.deduplicate,
  };
}

/** Where the acceptor's own input comes from on a server-job run. `inline` holds
 * the browser's File, whose text the hook reads at run time (the hosted-shaped path);
 * `workFile` holds only a REFERENCE to a file in the console's mounted work-input
 * directory (the console picker's profiled snapshot), so no content transits the
 * browser. The hook resolves this to the driver's {@link JobInputSource} -- reading
 * `inline`'s text into `{kind:"inline",csv}`, passing `workFile` through -- and the
 * browser (WebRTC) path uses the retained `rawRows`/`columns` and never reads it. */
export type AcceptorLaunchSource =
  { kind: "inline"; file: File } | { kind: "workFile"; name: string };

/** The launch the acceptor commits to on "Start the exchange": the decoded
 * invitation, the committed name recorded in the exchange record, the acquired
 * CSV, the confirm-columns edits, and the input source. A fresh object per
 * launch keys the run effect, so a superseded or discarded launch aborts and
 * resets. */
export interface AcceptorLaunch {
  invitation: AcceptableInvitation;
  acceptorName: string;
  rawRows: Array<CSVRow>;
  columns: Array<string>;
  edits: AcceptorDataEdits;
  /** Where the console reads this party's input from on a server-job run
   * ({@link AcceptorLaunchSource}): the browser File on the hosted-shaped inline
   * path, or the console picker's mounted-file reference. The browser (WebRTC) path
   * uses the retained `rawRows`/`columns` and never reads it. Mirrors the inviter's
   * `inputSource`. */
  inputSource: AcceptorLaunchSource;
  /** The confirm-columns step's file-handling choices for a server-job accept,
   * already resolved through core's retain-mode implication. Fixed into the launch
   * so the run cannot be retuned under itself; absent when the operator changed
   * nothing, and unused on the browser (WebRTC) path. */
  options?: JobExchangeOptions;
  /** The same step's per-run diagnostic and recovery choices, fixed into the
   * launch for the same reason and unused on the browser path. */
  runDiagnostics?: RunDiagnosticsIntentFields;
  /** The same step's receipt-signing and retention choices, fixed into the launch
   * for the same reason and unused on the browser path, which produces no CLI
   * config and signs no receipt. */
  receipts?: ReceiptsIntentFields;
}

/** Resolve an {@link AcceptorLaunchSource} to the driver's {@link JobInputSource}:
 * an `inline` File is read to its text (the hosted path keeps File + text()), a
 * `workFile` reference passes through unchanged (the console path submits no
 * content). */
async function resolveJobInputSource(
  source: AcceptorLaunchSource,
): Promise<JobInputSource> {
  return source.kind === "inline"
    ? { kind: "inline", csv: await source.file.text() }
    : { kind: "workFile", name: source.name };
}

/**
 * The run half of the acceptor console, started the moment the launch appears
 * (the confirm-columns step's "Start the exchange" is the start; no second
 * press). It mirrors {@link useInviterExchange}'s shape -- a single
 * AbortController per run, StrictMode/re-entry guards, the URL-revocation
 * effect, and an effect keyed on the launch so a superseded launch aborts and
 * resets -- with the acceptor's own differences:
 *
 *  - The acceptor is the PSI INITIATOR ({@link HANDSHAKE_ROLE_FOR_SIDE}), and the
 *    WASM library is awaited EARLY (before dialing, to fail fast) -- the inverse
 *    of the inviter's late await.
 *  - It DIALS the inviter's derived id ({@link dialAsAcceptor}), which tears down
 *    its own peer on failure, so no redundant destroy here.
 *  - The prepared exchange adopts the invitation's terms with the committed name
 *    and the confirm-columns edits, and locks in the received-payload columns to
 *    the invitation's disclosed set ({@link prepareAcceptorExchange}).
 *
 * On a console build accepting a filedrop or SFTP invitation the console runs
 * the exchange through the job API instead ({@link acceptorServerJobConfig} ->
 * {@link createServerJobExchangeDriver}), mirroring the inviter's server-job
 * path: no dial, no PSI library here, and the acceptor's own-perspective terms
 * go to the console alongside its mounted-file reference (no file content
 * transits the browser). An SFTP accept additionally reads the
 * operator-authored connection off the console, so no host, credential, or
 * fingerprint transits the browser either.
 *
 * Try again (the retryable "exchange" category only) re-dials the same
 * invitation while it is still usable, exactly like the inviter's re-listen.
 */
export function useAcceptorExchange({
  launch,
}: {
  launch: AcceptorLaunch | undefined;
}): {
  run: ExchangeRun;
  outputs: RunOutputs | undefined;
  failure: RunFailure | undefined;
  /** The run's non-fatal warnings in arrival order, each already escaped at this
   * hook's display boundary ({@link appendSanitizedRunWarning}). The console's
   * rendezvous preflight raises these before the exchange starts -- a non-empty
   * mount, an overlap with the input directory or the data root -- and the accepting
   * seat is the one most likely to launch into a mount the partner has been syncing
   * into, so they must reach it as they reach the inviter. */
  warnings: ReadonlyArray<string>;
  /** The console job id of the current server-job accept, once created; undefined
   * on a browser accept and before the job exists. Drives the completed-run
   * recurring hand-off panel. */
  jobId: string | undefined;
  /** The live status of the exchange this accept re-attached to on a busy (409)
   * create, or undefined on a fresh run. Set when a start-time 409 re-attaches to
   * the exchange holding the console's single slot -- the run surface then heads
   * with recovery-style copy rather than fresh-success copy. */
  reattached: JobRunStatus | undefined;
  /** True from the moment a busy (409) create is detected until the liveness probe
   * settles: the interim during which the run surface suppresses the fresh-run
   * framing and shows a brief reconnecting notice, before it either resolves to the
   * recovery view (`reattached`) or falls back to the run's alert. */
  reattaching: boolean;
  tryAgain: () => void;
  abandonRun: () => void;
} {
  const [run, setRun] = useState<ExchangeRun>(() => initialRun("acceptor"));
  const [outputs, setOutputs] = useState<RunOutputs>();
  const [failure, setFailure] = useState<RunFailure>();
  const [warnings, setWarnings] = useState<Array<string>>([]);
  // The status of an exchange this accept re-attached to on a busy (409) create,
  // else undefined. Drives the run surface's recovery-style copy; reset when a run
  // restarts or the launch is discarded.
  const [reattached, setReattached] = useState<JobRunStatus>();
  // True while a detected busy (409) create is being resolved to a re-attachment,
  // before the liveness probe settles. Drives the interim reconnecting notice and
  // the fresh-run framing suppression; reset when a run restarts or the launch is
  // discarded.
  const [reattaching, setReattaching] = useState(false);
  // The current accept's console job id as reactive state (the ref below drives
  // the synchronous discard paths). Set on create, cleared when the run restarts or
  // the launch is discarded, so the recurring hand-off panel reads only the live run.
  const [currentJobId, setCurrentJobId] = useState<string>();

  // The job API client the deliberate-discard paths use (try again, start over via
  // the run column's fresh-invitation link, back-to-columns), mirroring the
  // inviter hook. The server-job driver keeps its own default client.
  const jobApiClient = useMemo(() => createFetchJobApiClient(), []);

  // The console job id of the current accept, stamped by the driver's
  // `onJobCreated`. Read by `tryAgain` (DELETE the failed job before recreating,
  // which reject-until-DELETE would otherwise 409) and `abandonRun` (discard on a
  // deliberate leave). Undefined on a browser accept and before the job is created.
  const currentJobIdRef = useRef<string | undefined>(undefined);

  // Drives the lifecycle's AbortSignal; the effect cleanup below aborts it so an
  // unmount (or a superseded launch) tears down any in-flight dial or exchange
  // and every owner-driven callback stops firing. The cleanup also clears the ref:
  // under React StrictMode's mount/unmount/mount the start effect re-runs, and a
  // stale aborted controller left in the ref would trip the re-entry guard and
  // the real run would never start.
  const abortRef = useRef<AbortController | undefined>(undefined);

  // Revoke this run's object URLs when they are replaced or the owner unmounts:
  // createObjectURL keeps each Blob alive until revoked, and the verification-
  // keys blob is private material, so it should not outlive the run that backs it.
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

  function start(current: AcceptorLaunch) {
    // Guard against re-entry: once a run is in flight its AbortController is
    // stored here, and starting a second would orphan the first's signal and
    // race two lifecycles on shared state. A deliberate restart (try again)
    // clears the ref first.
    if (abortRef.current) return;
    const controller = new AbortController();
    abortRef.current = controller;

    setRun(initialRun("acceptor"));
    setOutputs(undefined);
    setFailure(undefined);
    setWarnings([]);
    setCurrentJobId(undefined);
    setReattached(undefined);
    setReattaching(false);

    const { invitation, acceptorName, rawRows, columns, edits, inputSource } =
      current;
    const { options, runDiagnostics, receipts } = current;
    const { token, endpoint } = invitation;
    // The console transport this endpoint runs over, threaded to failureFor so a
    // console mounted-file create rejection (a workFile 400) names the file cause
    // and routes recovery to the file step. On a console build this is `filedrop`
    // or `sftp` (both -> server-job); every other admitted endpoint is `browser`
    // (-> WebRTC).
    const channel = transportForEndpointChannel(endpoint.channel);

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

    // The acceptor is the PSI initiator: it awaits the WASM library EARLY, to
    // fail before dialing, then dials the inviter's derived id. The inverse of
    // the inviter's late await.
    const acquire: Acquire = async ({ signal, onStage, onStages }) => {
      const psi = loadPsiBackend(
        { loadWasm: () => PSI() as Promise<PSILibrary> },
        { isNode: false },
      ).then((selection) => selection.library);

      // The exchange runs on the invitation's terms (adopted with this party's
      // identity), with the confirm-columns edits threaded in locally and the
      // received-payload columns locked to the disclosed set -- the same spec
      // assembly and enforcement the browser accept path performs.
      const prepared = prepareAcceptorExchange({
        linkageTerms: token.linkageTerms,
        acceptorName,
        edits,
        rawRows,
        columns,
        disclosedPayloadColumns: token.disclosedPayloadColumns,
      });
      onStages(stagesFor(prepared, "acceptor"));

      // Fail fast: await the WASM library before dialing, so a WASM-load failure
      // is reported before this party publishes anything on the wire -- the
      // inverse of the inviter's late await. The owner's later `await psi` on the
      // same (now-resolved) promise is then instant.
      await psi;

      onStage(WAITING_STAGE_ID);
      // Dial the inviter's derived id. acquire runs only on the browser path,
      // which the selection below reaches only for a WebRTC endpoint; narrow to
      // it fail-closed so a mis-selected non-WebRTC endpoint aborts rather than
      // reaching dialAsAcceptor with an undrivable locator. dialAsAcceptor tears
      // down its own peer on failure, so acquisition stays atomic without a
      // redundant destroy here.
      if (endpoint.channel !== "webrtc")
        throw new Error("the browser acceptor path requires a WebRTC endpoint");
      const [peer, conn] = await dialAsAcceptor(token.sharedSecret, endpoint, {
        signal,
      });
      return { peer, conn, psi, prepared };
    };

    const browserDriver = (): ExchangeDriver<RunOutputs> =>
      createBrowserExchangeDriver<RunOutputs>({
        acquire,
        exchangeRole: HANDSHAKE_ROLE_FOR_SIDE.acceptor,
        sharedSecret: token.sharedSecret,
        expires: token.expires,
        generateOutput,
      });

    // The intent arm the console runs this accept over: an SFTP endpoint rides
    // the sftp arm (the console connects to the operator-authored server), every
    // other server-job endpoint the filedrop arm. Neither holds connection
    // material -- the SFTP host/credential/fingerprint live on the console, read
    // off the operator-authored connection, never the browser.
    const serverJobTransport: ServerJobExchangeTransport =
      endpoint.channel === "sftp"
        ? { channel: "sftp" }
        : { channel: "filedrop" };

    // The console performs the server-job exchange: the driver POSTs the
    // acceptor's OWN-PERSPECTIVE terms, the shared secret, and the input source
    // to the job API and maps the server's event stream onto the same lifecycle
    // events. It owns no peer connection or PSI library, so `acquire`/`generateOutput`
    // and the dial go unused on this path. The input source is a
    // REFERENCE to the operator-mounted file (no content transits the browser);
    // resolving it (a `workFile` passes through, an inline File is read to text) is
    // the only async step before the run, so it precedes the driver build. The
    // resolved source is captured so failureFor can name the file cause on a create
    // rejection.
    let jobInputSource: JobInputSource | undefined;
    const serverJobDriver = async (): Promise<ExchangeDriver<RunOutputs>> => {
      jobInputSource = await resolveJobInputSource(inputSource);
      return createServerJobExchangeDriver({
        ...acceptorServerJobConfig({
          token,
          acceptorName,
          edits,
          inputSource: jobInputSource,
          transport: serverJobTransport,
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
            seat: "acceptor",
            channel: serverJobTransport.channel,
          });
        },
      });
    };

    // The launch reaches this hook only for an endpoint prepareAcceptedInvitation
    // admitted -- WebRTC (-> browser) or a console filedrop/sftp (-> server-job) --
    // so the selection is one of those two live kinds. A residual non-drivable kind
    // (a save-file, which the guard fails closed before a launch can exist) is
    // shown as the run's own failure alert rather than thrown out of the start
    // effect, which would crash the render.
    // The sftp-configured flag is the selector's sftp-only input; an accepted sftp
    // endpoint still resolves to server-job with it false (the connection is
    // authored before launch), so it is passed constant false here.
    const selection = selectExchangeDriver(channel, deploymentProfile(), false);
    if (selection.kind === "save-file") {
      setFailure(
        failureFor(
          "config",
          new Error("this build cannot run the accepted exchange"),
        ),
      );
      setRun((prev) => runWithFailure(prev));
      return;
    }

    // Raise a failure's alert and freeze the run: the terminal path for every
    // error except a busy (409) create, which re-attaches below instead.
    const raiseFailure = (category: ExchangeErrorCategory, error: unknown) => {
      setFailure(
        failureFor(category, error, jobInputSource, channel, "acceptor"),
      );
      setRun((prev) => runWithFailure(prev));
    };

    // The run's lifecycle callbacks, built once so a busy (409) re-attach folds
    // the already-running exchange's stream onto the SAME surface. A busy create
    // at start re-attaches to the exchange holding the console's single slot
    // (recovery-style copy, `reattached`) rather than dead-ending on the "already
    // running" alert; every other failure raises its alert.
    const runEvents: ExchangeDriverEvents<RunOutputs> = {
      signal: controller.signal,
      onStages: (stages) => setRun((prev) => runWithStages(prev, stages)),
      onStage: (stageId) =>
        setRun((prev) => runWithStage(prev, stageId, new Date())),
      onResult: (generated) => {
        setOutputs(generated);
        setRun((prev) => runWithCompletion(prev, new Date()));
      },
      onWarning: (message) =>
        setWarnings((prev) => appendSanitizedRunWarning(prev, message)),
      onError: ({ category, error }) => {
        // Dev-gated: the raw Error object's message/cause can embed partner-/
        // server-controlled bytes, so a production console has none of it,
        // while a developer (or a deployed client with the diagnostics toggle
        // on) keeps the full object. The user-facing alert is separately
        // sanitized in failureFor.
        whenDiagnostic(() => console.error(error));
        if (isExchangeBusyError(error)) {
          // Enter the reconnecting interim the instant the 409 is known, before
          // the liveness probe round trip -- this suppresses the fresh-run framing
          // (which would otherwise flash) and announces the reconnect.
          setReattaching(true);
          void reattachOnBusy({
            error,
            client: jobApiClient,
            seat: "acceptor",
            channel,
            events: runEvents,
            onReattaching: (id, status) => {
              currentJobIdRef.current = id;
              setCurrentJobId(id);
              setReattaching(false);
              setReattached(status);
            },
          }).then((didReattach) => {
            if (!didReattach) {
              setReattaching(false);
              raiseFailure(category, error);
            }
          });
          return;
        }
        raiseFailure(category, error);
      },
    };

    void (async () => {
      let driver: ExchangeDriver<RunOutputs>;
      try {
        driver =
          selection.kind === "server-job"
            ? await serverJobDriver()
            : browserDriver();
      } catch (error) {
        if (controller.signal.aborted) return;
        whenDiagnostic(() => console.error(error));
        setFailure(failureFor("exchange", error));
        setRun((prev) => runWithFailure(prev));
        return;
      }
      await driver.run(runEvents);
    })();
  }

  // Start the run the moment a launch exists -- the columns step's "Start the
  // exchange" is the start, so the acceptor dials without a second press, exactly
  // as the inviter listens on the minted invitation. Keyed on the launch: a
  // superseded or discarded launch aborts its run and resets.
  const startRef = useRef(start);
  startRef.current = start;
  useEffect(() => {
    if (launch === undefined) {
      setRun(initialRun("acceptor"));
      setOutputs(undefined);
      setFailure(undefined);
      setWarnings([]);
      setCurrentJobId(undefined);
      setReattached(undefined);
      setReattaching(false);
      return;
    }
    startRef.current(launch);
    return () => {
      abortRef.current?.abort();
      abortRef.current = undefined;
    };
  }, [launch]);

  // Offered by the retryable-failure alert alone: the run is over (the lifecycle
  // tore down), so a fresh dial on the same invitation cannot race it, and the
  // same secret stays valid for the original link -- the security category
  // instead forces a fresh invitation, and an output failure must not re-run an
  // exchange that already succeeded. Gated on the invitation's expiry as well:
  // re-dialing a lapsed credential cannot succeed (no peer can pass it). A token
  // without an `expires` has no deadline, so it stays retryable.
  function tryAgain() {
    if (launch === undefined || failure?.category !== "exchange") return;
    const expires = launch.invitation.token.expires;
    if (expires !== undefined && !invitationUsable(expires, new Date())) return;
    const retryLaunch = launch;
    abortRef.current?.abort();
    abortRef.current = undefined;
    const channel = transportForEndpointChannel(
      retryLaunch.invitation.endpoint.channel,
    );
    const runMode = selectExchangeDriver(
      channel,
      deploymentProfile(),
      false,
    ).kind;
    const failedJobId = currentJobIdRef.current;
    // A server-job retry DELETEs the failed (already-terminal) job before
    // recreating: reject-until-DELETE 409s the create while the prior exchange
    // still holds the console's single slot. A browser retry re-dials with no
    // server job to discard.
    if (runMode === "server-job" && failedJobId !== undefined) {
      currentJobIdRef.current = undefined;
      void discardServerJob(jobApiClient, failedJobId).then(() =>
        start(retryLaunch),
      );
      return;
    }
    start(retryLaunch);
  }

  // Discard the current server-job accept when the operator leaves
  // (the run column's fresh-invitation link, back-to-columns): cancel-if-running,
  // DELETE, clear the recovery record. Fire-and-forget, and a no-op on a browser
  // accept or before any job exists. Frees the console's single slot.
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
