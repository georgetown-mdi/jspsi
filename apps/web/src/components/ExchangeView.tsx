import log from "loglevel";

import { useEffect, useRef, useState } from "react";

import { Alert, Button, Group, Stack } from "@mantine/core";

// @ts-ignore this is really there
import PSI from "@openmined/psi.js/psi_wasm_web";

import {
  CONFIRMING_PROTOCOL_STAGE_ID,
  ProcessState,
  buildOutputTable,
  describeExchangeStages,
  errorMessage,
  prepareForExchange,
  sanitizeForDisplay,
  serializeExchangeRecord,
  serializeOpeningData,
} from "@psilink/core";

import { dialAsAcceptor, listenAsInviter } from "@psi/rendezvous";
import { acceptorExchangeDataSpec } from "@psi/acceptInvitation";
import { runExchangeLifecycle } from "@psi/exchangeLifecycle";
import { waitForIncomingConnection } from "@psi/waitForConnection";

import { whenDiagnostic } from "@utils/diagnostics";

import { Status } from "@components/Status";

import type { AcquiredBundle, AlertContent } from "@components/FileAcquire";

import type { PSILibrary } from "@openmined/psi.js/implementation/psi.d.ts";

import type {
  Acquire,
  ExchangeOutputs,
  StageDefinition,
} from "@psi/exchangeLifecycle";
import type {
  ExchangeDataSpec,
  ExchangeResult,
  LinkageTerms,
  PreparedExchange,
  WebRTCEndpoint,
} from "@psilink/core";

/**
 * Configuration for one side of a derived-id WebRTC exchange. The inviter (PSI
 * responder) listens on its derived peer id; the acceptor (PSI initiator) dials
 * the inviter's derived id read off the invitation endpoint. Both derive their
 * ids from the same `sharedSecret`. `expires` is the invitation's bounded
 * lifetime (ISO 8601), threaded into the authenticated key exchange's expiry
 * guards; it is optional because the {@link InvitationToken} marks `expires`
 * optional, though every web-generated invitation now carries one.
 *
 * Both roles carry the run's `linkageTerms` and an already-parsed CSV
 * (`acquired`), but acquire each differently. The acceptor adopts the inviter's
 * terms from the decoded invitation (the same terms the review screen displayed),
 * substituting its own identity, and arrives with the CSV the review screen parsed
 * and pre-flighted -- so it renders no file prompt and dials only when the user
 * presses Start. The inviter is the SOURCE of the terms: it derived them from its
 * file at invite time and embedded exactly them in the token, so it carries that
 * same `linkageTerms` object (no re-derivation) along with the CSV parsed at
 * compose time, and -- being the responder that listens -- auto-starts with no
 * Start press. Either way the exchange runs straight from `acquired` with no
 * re-parse.
 */
export type ExchangeConfig =
  | {
      role: "inviter";
      partyName: string;
      sharedSecret: string;
      expires?: string;
      /** The linkage terms embedded in the invitation, reused verbatim so the
       * inviter runs on the very terms the acceptor adopts (its identity is
       * already this party's name). */
      linkageTerms: LinkageTerms;
      /** The CSV parsed at compose time, fed straight into the exchange: no
       * re-parse, and no second file prompt (the inviter renders no
       * {@link FileAcquire}). */
      acquired: AcquiredBundle;
    }
  | {
      role: "acceptor";
      partyName: string;
      sharedSecret: string;
      expires?: string;
      endpoint: WebRTCEndpoint;
      linkageTerms: LinkageTerms;
      /** The CSV parsed and pre-flighted on the accept review screen, fed straight
       * into the exchange on Start: no re-parse, and no file prompt here. Mirrors
       * the inviter's `acquired`. */
      acquired: AcquiredBundle;
      /** The partial-coverage advisory the review screen's pre-flight raised, if
       * any, seeded into the warning slot so it stays visible through the run (kept
       * on success, cleared on a run failure). Absent when the file satisfied every
       * linkage key. */
      initialWarning?: AlertContent;
    };

const preStages: Array<StageDefinition> = [
  {
    id: "before start",
    label: "Before start",
    state: ProcessState.BeforeStart,
  },
  {
    id: "waiting for peer",
    label: "Waiting for peer",
    state: ProcessState.Waiting,
  },
];

const doneStage: StageDefinition = {
  id: "done",
  label: "Done",
  state: ProcessState.Done,
};

function buildInitialStages(): Array<StageDefinition> {
  return [
    ...preStages,
    {
      id: CONFIRMING_PROTOCOL_STAGE_ID,
      label: "Confirming protocol",
      state: ProcessState.Working,
    },
    doneStage,
  ];
}

/** Full per-exchange stage tree, emitted once after load/prepare via `onStages`:
 * the pre-stages, the protocol stages derived from the prepared exchange, and the
 * terminal done stage. */
function buildStageList(prepared: PreparedExchange): Array<StageDefinition> {
  return [
    ...preStages,
    ...describeExchangeStages(prepared).map((stage) => ({
      ...stage,
      state: ProcessState.Working as const,
    })),
    doneStage,
  ];
}

/**
 * The Start->run half of a web exchange, shared by both roles: it takes an
 * already-acquired CSV bundle from the file-acquire phase, draws in the peer (the
 * role's only difference), runs the exchange, and surfaces the result and audit
 * downloads. It owns the single {@link AbortController} and the unmount-abort
 * cleanup, and never parses a file or pre-flights it -- the {@link FileAcquire}
 * child it renders does that and hands up a satisfiable bundle.
 *
 * It is keyed by the shared secret (see the consumers), so a regenerated
 * invitation remounts this subtree and resets file, stage, and controller
 * together; the parsed bundle never outlives a regenerate by living in a
 * longer-lived parent. The role-agnostic lifecycle (acquire/open/run/teardown)
 * lives in {@link runExchangeLifecycle}; this component owns the stage UI and
 * maps the {@link ExchangeConfig} to the role's rendezvous and PSI handshake
 * role.
 */
export function ExchangeView(config: ExchangeConfig) {
  const { role, partyName } = config;

  const [stages, setStages] = useState<Array<StageDefinition>>(() =>
    buildInitialStages(),
  );
  const [stageId, setStageById] = useState<string>("before start");
  const [outputs, setOutputs] = useState<ExchangeOutputs>();
  const [errorAlert, setErrorAlert] = useState<AlertContent>();
  // Seeded from the acceptor's pre-flight advisory (the review screen raises it),
  // so a partial-coverage warning persists through the run; kept on success and
  // cleared on a run failure (see the lifecycle handlers below).
  const [warningAlert, setWarningAlert] = useState<AlertContent | undefined>(
    config.role === "acceptor" ? config.initialWarning : undefined,
  );
  // Whether the run has been started. Drives only the acceptor's Start button
  // visibility (it hides once pressed; the inviter auto-starts and shows none);
  // the authoritative one-run-per-mount guard is handleStart's abortRef check.
  const [started, setStarted] = useState(false);

  // Drives the lifecycle's AbortSignal. A useEffect cleanup aborts it on unmount,
  // so the owner tears down any in-flight wait or exchange and every owner-driven
  // seam stops firing (no setState after unmount). The cleanup also clears the
  // ref: a real unmount discards the instance anyway, but under React StrictMode's
  // mount/unmount/mount the inviter auto-start effect below re-runs, and a stale
  // aborted controller left in the ref would trip its re-entry guard and the real
  // run would never start.
  const abortRef = useRef<AbortController | undefined>(undefined);
  useEffect(
    () => () => {
      abortRef.current?.abort();
      abortRef.current = undefined;
    },
    [],
  );

  // Revoke this exchange's object URLs when the component unmounts (or before a
  // replacement set is stored): createObjectURL keeps each Blob alive until it is
  // revoked, and the record and opening blobs hold the matched data, so they
  // should not outlive the page that backs them.
  useEffect(() => {
    if (outputs === undefined) return;
    return () => {
      window.URL.revokeObjectURL(outputs.resultsUrl);
      if (outputs.record !== undefined) {
        window.URL.revokeObjectURL(outputs.record.recordUrl);
        window.URL.revokeObjectURL(outputs.record.openingUrl);
      }
    };
  }, [outputs]);

  // Start the connection lifecycle from an already-loaded, already-checked CSV:
  // both roles arrive with one in config.acquired -- the acceptor's parsed and
  // pre-flighted on the review screen (and dialed only on the user's Start), the
  // inviter's parsed at compose time (auto-started by the mount effect below).
  // Both sources guarantee at least one satisfiable linkage key -- the acceptor
  // via its pre-flight, the inviter via generateInvitation's fail-closed block --
  // so an unsatisfiable file never reaches here: nothing is dialed and the
  // connecting UI does not mount.
  const handleStart = (bundle: AcquiredBundle) => {
    // Guard against re-entry: once an exchange is in flight its AbortController is
    // stored here, and starting a second would orphan the first's signal and race
    // two lifecycles on shared state. Start is offered at most once per mount, but
    // this makes the one-exchange-per-mount invariant explicit -- a fresh exchange
    // comes from a fresh mount (ExchangeView is keyed by the secret).
    if (abortRef.current) return;
    // Hide the acceptor's Start button now that the run is underway (the inviter
    // shows none); the abortRef guard above remains the authoritative gate.
    setStarted(true);

    const controller = new AbortController();
    abortRef.current = controller;

    const { rawRows, columns } = bundle;

    // Pure output-generation half: build the local results file plus the
    // self-attested record and its private opening data, returning a download URL
    // for each. The object URLs are revoked when the component unmounts or the
    // outputs are replaced (see the cleanup effect above).
    const generateOutput = (
      result: ExchangeResult,
      prepared: PreparedExchange,
    ): ExchangeOutputs => {
      log.info("linkage complete, generating results and record files");
      const { headers, rows } = buildOutputTable(
        result.associationTable,
        prepared.rawRows,
        prepared.metadata,
        result.partnerPayload,
      );
      const csv =
        headers.join(",") + "\n" + rows.map((r) => r.join(",") + "\n").join("");
      const jsonUrl = (text: string): string =>
        window.URL.createObjectURL(
          new Blob([text], { type: "application/json" }),
        );
      const generated: ExchangeOutputs = {
        resultsUrl: window.URL.createObjectURL(
          new Blob([csv], { type: "text/csv" }),
        ),
      };
      // The audit record and its opening are produced as a pair, so one guard
      // offers both or neither. They are absent only if building the record
      // failed after a successful exchange; in that case the downloads are
      // intentionally omitted without a blocking alert. Filenames are timestamped
      // per exchange (the record's own createdAt, made filesystem-safe) so
      // repeated downloads in one session accumulate rather than collide.
      if (result.audit !== undefined) {
        const stamp = result.audit.record.createdAt.replace(/[:.]/g, "-");
        generated.record = {
          recordUrl: jsonUrl(serializeExchangeRecord(result.audit.record)),
          recordFileName: `psilink-record-${stamp}.json`,
          openingUrl: jsonUrl(serializeOpeningData(result.audit.opening)),
          openingFileName: `psilink-record-${stamp}.opening.json`,
        };
      }
      return generated;
    };

    // The inviter is the PSI responder: it must attach its inbound listener
    // before the WASM library resolves, so `psi` stays pending here and the
    // owner awaits it late (after the message connection is open). The acceptor
    // is the initiator: it awaits `psi` early, to fail before dialing.
    const acquire: Acquire = async ({ signal, onStage, onStages }) => {
      const psi = PSI() as Promise<PSILibrary>;
      // The responder (inviter) returns `psi` unresolved and the owner awaits
      // it late; if the connection setup fails or the signal aborts first, that
      // await is never reached. Attach a fire-and-forget handler so a rejecting
      // PSI() (e.g. a WASM-asset load failure) on a torn-down exchange cannot
      // surface as an unhandled rejection -- the real `await psi` still throws.
      void psi.catch(() => undefined);

      // Both roles run on the invitation's linkage terms, so the exchange links
      // on exactly what the acceptor consented to. The acceptor adopts the
      // inviter's terms with its own identity substituted; the inviter passes the
      // very terms it derived from its file and embedded in the token (their
      // identity is already this party's name), so the two sides carry an
      // identical fields/keys set and the terms-compatibility handshake agrees.
      // Either party's metadata, standardization, and payloads still derive from
      // its own CSV -- only the linkage terms are pinned to the invitation.
      const dataSpec: ExchangeDataSpec =
        config.role === "acceptor"
          ? acceptorExchangeDataSpec(config.linkageTerms, partyName)
          : { linkageTerms: config.linkageTerms };
      const prepared = prepareForExchange(
        dataSpec,
        partyName,
        rawRows,
        columns,
      );
      onStages(buildStageList(prepared));

      if (config.role === "acceptor") await psi;

      onStage("waiting for peer");
      if (config.role === "inviter") {
        // Listen on the derived inviter id, then await the acceptor's inbound
        // connection. Destroy the peer on a wait failure so acquisition stays
        // atomic (the owner's teardown only ever covers a returned {peer, conn}).
        const peer = await listenAsInviter(config.sharedSecret, { signal });
        try {
          const conn = await waitForIncomingConnection(peer, { signal });
          return { peer, conn, psi, prepared };
        } catch (error) {
          peer.destroy();
          throw error;
        }
      }
      // Acceptor: dial the inviter's derived id (dialAsAcceptor tears down its
      // own peer on failure, so acquisition stays atomic).
      const [peer, conn] = await dialAsAcceptor(
        config.sharedSecret,
        config.endpoint,
        { signal },
      );
      return { peer, conn, psi, prepared };
    };

    void runExchangeLifecycle({
      acquire,
      exchangeRole: role === "inviter" ? "responder" : "initiator",
      sharedSecret: config.sharedSecret,
      expires: config.expires,
      signal: controller.signal,
      generateOutput,
      onStages: setStages,
      onStage: setStageById,
      onResult: (o) => {
        setOutputs(o);
        setStageById("done");
        // A partial-coverage warning (set by the acquire phase) is intentionally
        // kept on success: it explains why some keys were inactive and the match
        // count may be lower. It is cleared only on failure (onError below).
      },
      onError: ({ category, error }) => {
        // Clear any partial-coverage warning so it cannot render beside a
        // failure alert and read as the cause: the exchange did not complete,
        // so the "some keys were inactive" advisory is no longer the message.
        setWarningAlert(undefined);
        // Dev-gated: the raw Error object's message/cause can embed
        // partner-/server-controlled bytes (e.g. a hostile message-file path in
        // a transport error), so a production console carries none of it, while
        // a developer (or a deployed client with the diagnostics toggle on)
        // keeps the full object -- expandable stack and `.cause` chain. The
        // adjacent user-facing alert is separately sanitized below.
        whenDiagnostic(() => console.error(error));
        if (category === "output") {
          // The exchange succeeded; only results-file generation failed. The
          // user must not be told to re-run a privacy-sensitive exchange.
          setErrorAlert({
            title: "Results unavailable",
            message:
              "The linkage completed, but generating the results file failed: " +
              // Sanitized at the display boundary: this output error is local,
              // but the alert is operator-facing, so escape it like any other.
              // A single message (not the cause chain) keeps the sentence intact.
              sanitizeForDisplay(errorMessage(error)),
          });
        } else if (category === "security") {
          // The authenticated key exchange failed closed: this connection could
          // not be confirmed as the invited partner. Unlike a transport drop
          // this is not retryable -- a silent retry would re-run into the same
          // wrong secret, or into a peer that is tampering -- so the user is
          // steered to a fresh invitation rather than a re-run. The underlying
          // error is dev-gated to the console above but deliberately kept out of
          // the alert: the kex failure message is intentionally non-oracular,
          // and the other tagged cases carry developer-facing text (secret-format
          // rules, re-invite phrasing) that does not belong in an end-user alert.
          setErrorAlert({
            title: "Could not verify your partner",
            message:
              "The secure handshake failed, so this connection could not be " +
              "confirmed as your invited partner. This happens when the other " +
              "party used a different invitation link, or if the connection was " +
              "tampered with. Do not retry; start over with a fresh invitation.",
          });
        } else {
          // Generic, retryable transport/exchange failure. The raw error reads
          // as an internal/developer message to an end user -- it can embed
          // partner-/server-controlled bytes and the `[redacted-peer-id]`
          // rendezvous-id placeholder, which looks like a bug in an alert -- so
          // the alert uses a fixed, friendly message instead of the raw text. A
          // transport drop is generally retryable (unlike the security category
          // above), so the guidance invites another try. The detailed,
          // id-redacted error stays in the dev-gated console.error above for
          // diagnosis.
          setErrorAlert({
            title: "Exchange failed",
            message:
              "The exchange could not be completed. This is usually a " +
              "temporary connection problem rather than an issue with your " +
              "data. Start over with a fresh invitation to try again.",
          });
        }
      },
    });
  };

  // The inviter is the responder (it listens), so it starts immediately from its
  // pre-acquired bundle with no Start press. The acceptor is the initiator: it
  // dials only when the user presses Start (the button below), so it does NOT
  // auto-start here. Runs once per mount -- ExchangeView is keyed by the secret,
  // so a fresh exchange is a fresh mount, and handleStart's re-entry guard plus
  // the StrictMode-safe abort cleanup above keep a double-invoked effect from
  // racing two runs.
  useEffect(() => {
    if (config.role === "inviter") handleStart(config.acquired);
  }, []);

  return (
    <Stack>
      {errorAlert && (
        // This slot now carries only the run lifecycle's error messages: the
        // acceptor's file read and pre-flight errors surface on the review screen,
        // not here. Those run-error messages are fixed strings or a single
        // sanitizeForDisplay'd message with no embedded newlines; pre-line is kept
        // defensively so any future multi-line message renders one line per line
        // rather than run together.
        <Alert
          color="red"
          title={errorAlert.title}
          style={{ whiteSpace: "pre-line" }}
        >
          {errorAlert.message}
        </Alert>
      )}
      {warningAlert && (
        <Alert color="yellow" title={warningAlert.title}>
          {warningAlert.message}
        </Alert>
      )}
      <Group justify="center" align="stretch" grow>
        <Status
          stages={stages}
          stageId={stageId}
          resultsFileURL={outputs?.resultsUrl}
          recordFileURL={outputs?.record?.recordUrl}
          recordFileName={outputs?.record?.recordFileName}
          openingFileURL={outputs?.record?.openingUrl}
          openingFileName={outputs?.record?.openingFileName}
        />
      </Group>
      {config.role === "acceptor" && !started && (
        // Acceptor only: it arrives pre-acquired (config.acquired, parsed and
        // pre-flighted on the review screen) and dials only on this explicit
        // Start, so nothing connects before the user presses it. The button hides
        // once the run begins; the inviter is the responder and auto-starts, so it
        // shows none.
        <Group justify="center">
          <Button onClick={() => handleStart(config.acquired)}>Start</Button>
        </Group>
      )}
    </Stack>
  );
}
