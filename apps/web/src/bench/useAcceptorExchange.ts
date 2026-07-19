import log from "loglevel";

import { useEffect, useRef, useState } from "react";

// @ts-ignore this is really there
import PSI from "@openmined/psi.js/psi_wasm_web";

import { deriveAcceptedLinkageTerms, loadPsiBackend } from "@psilink/core";

import { createBrowserExchangeDriver } from "@psi/exchangeDriver";
import { createServerJobExchangeDriver } from "@psi/serverJobExchangeDriver";
import { dialAsAcceptor } from "@psi/rendezvous";

import { deploymentProfile } from "@utils/clientConfig";
import { whenDiagnostic } from "@utils/diagnostics";

import { selectExchangeDriver } from "./exchangeDriverSelection";

import {
  WAITING_STAGE_ID,
  initialRun,
  runWithCompletion,
  runWithFailure,
  runWithStage,
  runWithStages,
  stagesFor,
} from "./exchangeRun";
import { buildRunOutputs } from "./runOutputs";
import { failureFor } from "./useInviterExchange";
import { invitationUsable } from "./inviterModel";
import { prepareAcceptorExchange } from "./acceptorExchange";

import type { PSILibrary } from "@openmined/psi.js/implementation/psi.d.ts";

import type {
  AcceptableInvitation,
  AcceptorDataEdits,
} from "@psi/acceptInvitation";
import type { Acquire, GenerateOutput } from "@psi/exchangeLifecycle";
import type { CSVRow, InvitationToken } from "@psilink/core";
import type {
  JobInputSource,
  ServerJobExchangeDriverConfig,
} from "@psi/serverJobExchangeDriver";
import type { ExchangeDriver } from "@psi/exchangeDriver";
import type { ExchangeRun } from "./exchangeRun";
import type { RunFailure } from "./useInviterExchange";
import type { RunOutputs } from "./runOutputs";
import type { Transport } from "./inviterModel";

/** The connection-endpoint channels the acceptor can drive, narrowed from the
 * token by {@link prepareAcceptedInvitation}: WebRTC always, file-drop on a
 * console build. */
type AcceptEndpointChannel = AcceptableInvitation["endpoint"]["channel"];

const ENDPOINT_CHANNEL_TRANSPORT: Record<AcceptEndpointChannel, Transport> = {
  webrtc: "browser",
  filedrop: "filedrop",
};

/** Map an accepted invitation's connection-endpoint channel to the bench
 * {@link Transport} the driver selector keys on. Keying off the endpoint channel
 * type means a widened channel union fails to build here until it is mapped. */
function transportForEndpointChannel(
  channel: AcceptEndpointChannel,
): Transport {
  return ENDPOINT_CHANNEL_TRANSPORT[channel];
}

/**
 * Assemble the {@link ServerJobExchangeDriverConfig} for a console filedrop
 * accept: the exchange the console appliance runs on this party's behalf. The
 * `linkageTerms` are the acceptor's OWN-PERSPECTIVE terms
 * ({@link deriveAcceptedLinkageTerms}: the acceptor's identity replaces the
 * inviter's, output/payload mirrored) -- the SAME derivation
 * {@link acceptorExchangeDataSpec} applies for the browser path, NOT the raw
 * inviter-perspective `token.linkageTerms`. This is load-bearing for identity and
 * direction: passing the raw inviter terms would run the acceptor with the wrong
 * identity and output direction.
 *
 * The received-payload lock-in is set EXPLICITLY via `expectedPayloadColumns`,
 * mirrored from the invitation's `disclosedPayloadColumns` exactly as the browser
 * path does ({@link prepareAcceptorExchange} -> `prepared.expectedPayloadColumns`).
 * This is load-bearing for security: the CLI prefers this explicit lock-in over the
 * `linkageTerms.payload.receive` fallback, which is undefined for a token that
 * discloses columns but carries no `payload.send` -- a shape a malicious inviter can
 * craft, and one where the fallback would fail OPEN (silently ingesting extra
 * partner columns) while the browser aborts. Setting it explicitly closes that gap.
 *
 * The confirm-columns `edits` (this party's authored metadata and standardization)
 * are carried into the config so the appliance's CLI honors them rather than
 * inferring metadata from the CSV column names -- the same edits the browser accept
 * path threads through {@link prepareAcceptorExchange}. Without them a column the
 * operator marked ignored would be inferred as disclosed payload and silently sent.
 *
 * Pure and exported so the derivation is the tested boundary, pinned without
 * running the hook.
 *
 * @internal
 */
export function acceptorServerJobConfig({
  token,
  acceptorName,
  edits,
  inputSource,
}: {
  token: InvitationToken;
  acceptorName: string;
  edits: AcceptorDataEdits;
  inputSource: JobInputSource;
}): ServerJobExchangeDriverConfig {
  return {
    transport: { channel: "filedrop" },
    linkageTerms: deriveAcceptedLinkageTerms(token.linkageTerms, acceptorName),
    sharedSecret: token.sharedSecret,
    inputSource,
    metadata: edits.metadata,
    standardization: edits.standardization,
    // The received-payload lock-in, mirrored from the invitation's disclosed set
    // exactly as the browser accept path does (prepareAcceptorExchange ->
    // prepared.expectedPayloadColumns). Passed through AS-IS: undefined when the
    // token omits it (lazy), an empty array when the disclosed set is empty
    // (strict "receive nothing"). Without it the CLI falls back to
    // linkageTerms.payload.receive, which is undefined for a token that discloses
    // columns but carries no payload.send -- a shape that would then fail OPEN,
    // silently ingesting extra partner columns where the browser aborts.
    expectedPayloadColumns: token.disclosedPayloadColumns,
  };
}

/** Where the acceptor's own input comes from on a server-job run. `inline` carries
 * the browser's File, whose text the hook reads at run time (the hosted-shaped path);
 * `workFile` carries only a REFERENCE to a file in the appliance's mounted work-input
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
  /** Where the appliance reads this party's input from on a server-job run
   * ({@link AcceptorLaunchSource}): the browser File on the hosted-shaped inline
   * path, or the console picker's mounted-file reference. The browser (WebRTC) path
   * uses the retained `rawRows`/`columns` and never reads it. Mirrors the inviter's
   * `inputSource`. */
  inputSource: AcceptorLaunchSource;
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
 * The run half of the acceptor bench, started the moment the launch appears (the
 * confirm-columns step's "Start the exchange" is the start; no second press).
 * It mirrors {@link useInviterExchange}'s shape -- a single AbortController per
 * run, StrictMode/re-entry guards, the URL-revocation effect, and an effect keyed
 * on the launch so a superseded launch aborts and resets -- with the acceptor's
 * differences re-surfaced from the legacy exchange screen's acceptor role:
 *
 *  - The acceptor is the PSI INITIATOR (`exchangeRole: "initiator"`), and the
 *    WASM library is awaited EARLY (before dialing, to fail fast) -- the inverse
 *    of the inviter's late await.
 *  - It DIALS the inviter's derived id ({@link dialAsAcceptor}), which tears down
 *    its own peer on failure, so no redundant destroy here.
 *  - The prepared exchange adopts the invitation's terms with the committed name
 *    and the confirm-columns edits, and locks in the received-payload columns to
 *    the invitation's disclosed set ({@link prepareAcceptorExchange}).
 *
 * On a console build accepting a filedrop invitation the appliance runs the
 * exchange through the job API instead ({@link acceptorServerJobConfig} ->
 * {@link createServerJobExchangeDriver}), mirroring the inviter's server-job
 * path: no dial, no PSI library here, and the acceptor's own-perspective terms go
 * to the appliance alongside its mounted-file reference (no file content transits
 * the browser).
 *
 * Try again (the retryable "exchange" category only) re-dials the same invitation
 * while it is still usable, exactly like the inviter's re-listen.
 */
export function useAcceptorExchange({
  launch,
}: {
  launch: AcceptorLaunch | undefined;
}): {
  run: ExchangeRun;
  outputs: RunOutputs | undefined;
  failure: RunFailure | undefined;
  tryAgain: () => void;
} {
  const [run, setRun] = useState<ExchangeRun>(() => initialRun("acceptor"));
  const [outputs, setOutputs] = useState<RunOutputs>();
  const [failure, setFailure] = useState<RunFailure>();

  // Drives the lifecycle's AbortSignal; the effect cleanup below aborts it so an
  // unmount (or a superseded launch) tears down any in-flight dial or exchange
  // and every owner-driven seam stops firing. The cleanup also clears the ref:
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
      if (outputs.resultsUrl !== undefined)
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

    const { invitation, acceptorName, rawRows, columns, edits, inputSource } =
      current;
    const { token, endpoint } = invitation;
    // The bench transport this endpoint runs over, threaded to failureFor so a
    // console mounted-file create rejection (a workFile 400) names the file cause
    // and routes recovery to the file step. The accept guard admits no sftp
    // endpoint, so this is `filedrop` (-> server-job) or `browser` (-> WebRTC).
    const channel = transportForEndpointChannel(endpoint.channel);

    // Output-generation half. The URLs the build creates are revoked when the
    // outputs are replaced or the bench unmounts (effect above); a throw
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
      // assembly and lock-in the legacy exchange screen performs.
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
      // surfaces before this party publishes anything on the wire -- the inverse
      // of the inviter's late await. The owner's later `await psi` on the same
      // (now-resolved) promise is then instant.
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
        exchangeRole: "initiator",
        sharedSecret: token.sharedSecret,
        expires: token.expires,
        generateOutput,
      });

    // The console appliance carries out the filedrop exchange: the driver POSTs
    // the acceptor's OWN-PERSPECTIVE terms, the shared secret, and the input source
    // to the job API and maps the server's event stream onto the same lifecycle
    // events. It owns no peer connection or PSI library, so `acquire`/`generateOutput`
    // and the dial go unused on this path. On the console the input source is a
    // REFERENCE to the operator-mounted file (no content transits the browser);
    // resolving it (a `workFile` passes through, an inline File is read to text) is
    // the only async step before the run, so it precedes the driver build. The
    // resolved source is captured so failureFor can name the file cause on a create
    // rejection.
    let jobInputSource: JobInputSource | undefined;
    const serverJobDriver = async (): Promise<ExchangeDriver<RunOutputs>> => {
      jobInputSource = await resolveJobInputSource(inputSource);
      return createServerJobExchangeDriver(
        acceptorServerJobConfig({
          token,
          acceptorName,
          edits,
          inputSource: jobInputSource,
        }),
      );
    };

    // The launch reaches this hook only for an endpoint prepareAcceptedInvitation
    // admitted -- WebRTC (-> browser) or a console filedrop (-> server-job) -- so
    // the selection is one of those two live kinds. A residual non-drivable kind
    // (a save-file, which the guard fails closed before a launch can exist) is
    // surfaced as the run's own failure alert rather than thrown out of the start
    // effect, which would crash the render.
    // The remotes flag is the selector's sftp-only input; the accept guard
    // admits no sftp endpoint (webrtc and console filedrop only), so it is
    // constant false here.
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
      await driver.run({
        signal: controller.signal,
        onStages: (stages) => setRun((prev) => runWithStages(prev, stages)),
        onStage: (stageId) =>
          setRun((prev) => runWithStage(prev, stageId, new Date())),
        onResult: (generated) => {
          setOutputs(generated);
          setRun((prev) => runWithCompletion(prev, new Date()));
        },
        onError: ({ category, error }) => {
          // Dev-gated: the raw Error object's message/cause can embed partner-/
          // server-controlled bytes, so a production console carries none of it,
          // while a developer (or a deployed client with the diagnostics toggle
          // on) keeps the full object. The user-facing alert is separately
          // sanitized in failureFor.
          whenDiagnostic(() => console.error(error));
          setFailure(
            failureFor(category, error, jobInputSource, channel, "acceptor"),
          );
          setRun((prev) => runWithFailure(prev));
        },
      });
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
  // without an `expires` carries no deadline, so it stays retryable.
  function tryAgain() {
    if (launch === undefined || failure?.category !== "exchange") return;
    const expires = launch.invitation.token.expires;
    if (expires !== undefined && !invitationUsable(expires, new Date())) return;
    abortRef.current?.abort();
    abortRef.current = undefined;
    start(launch);
  }

  return { run, outputs, failure, tryAgain };
}
