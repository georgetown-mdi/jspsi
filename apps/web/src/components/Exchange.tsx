import log from "loglevel";

import { useEffect, useRef, useState } from "react";

import { Alert, Group, Stack } from "@mantine/core";

// @ts-ignore this is really there
import PSI from "@openmined/psi.js/psi_wasm_web";

import {
  CONFIRMING_PROTOCOL_STAGE_ID,
  ProcessState,
  buildOutputTable,
  describeExchangeStages,
  errorMessage,
  loadCSVFile,
  prepareForExchange,
  sanitizeErrorForDisplay,
  sanitizeForDisplay,
  serializeExchangeRecord,
  serializeOpeningData,
  unsatisfiedLinkageFields,
} from "@psilink/core";

import { dialAsAcceptor, listenAsInviter } from "@psi/rendezvous";
import { acceptorExchangeDataSpec } from "@psi/acceptInvitation";
import { runExchangeLifecycle } from "@psi/exchangeLifecycle";
import { waitForIncomingConnection } from "@psi/waitForConnection";

import { whenDiagnostic } from "@utils/diagnostics";

import FileSelect from "@components/FileSelect";
import { Status } from "@components/Status";

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
 * The acceptor additionally carries the inviter's `linkageTerms` from the
 * decoded invitation: it adopts those as the terms governing the run (the same
 * terms the consent screen displayed), rather than inferring a default from its
 * own CSV. The inviter is the source of the terms and infers its own from its
 * CSV, so it carries none here.
 */
export type ExchangeConfig =
  | {
      role: "inviter";
      partyName: string;
      sharedSecret: string;
      expires?: string;
    }
  | {
      role: "acceptor";
      partyName: string;
      sharedSecret: string;
      expires?: string;
      endpoint: WebRTCEndpoint;
      linkageTerms: LinkageTerms;
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
 * Runs one side of a derived-id WebRTC PSI exchange: select a file, draw in the
 * peer (the role's only difference), run the exchange, and surface the result and
 * audit downloads. The role-agnostic lifecycle (acquire/open/run/teardown) lives
 * in {@link runExchangeLifecycle}; this component owns the file/stage UI and maps
 * the {@link ExchangeConfig} to the role's rendezvous and PSI handshake role.
 */
export function Exchange(config: ExchangeConfig) {
  const { role, partyName } = config;

  const [stages, setStages] = useState<Array<StageDefinition>>(() =>
    buildInitialStages(),
  );
  const [files, setFiles] = useState<Array<File>>([]);
  const [submitted, setSubmitted] = useState(false);
  const [stageId, setStageById] = useState<string>("before start");
  const [outputs, setOutputs] = useState<ExchangeOutputs>();
  const [errorAlert, setErrorAlert] = useState<{
    title: string;
    message: string;
  }>();
  const [warningAlert, setWarningAlert] = useState<{
    title: string;
    message: string;
  }>();

  // Drives the lifecycle's AbortSignal. A useEffect cleanup aborts it on unmount,
  // so the owner tears down any in-flight wait or exchange and every owner-driven
  // seam stops firing (no setState after unmount).
  const abortRef = useRef<AbortController | undefined>(undefined);
  useEffect(() => () => abortRef.current?.abort(), []);

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

  const handleSubmit = () => {
    // Guard against re-entry: once an exchange is in flight its AbortController is
    // stored here, and starting a second would orphan the first's signal and race
    // two lifecycles on shared state. The FileSelect button is also disabled via
    // `submitted`, but this makes the one-exchange-per-mount invariant explicit -- a
    // fresh exchange comes from a fresh mount (Exchange is keyed by the secret).
    if (abortRef.current) return;
    setSubmitted(true);
    setErrorAlert(undefined);

    const controller = new AbortController();
    abortRef.current = controller;

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
    // before the WASM library resolves, so `psi` stays pending here and the owner
    // awaits it late (after the message connection is open). The acceptor is the
    // initiator: it awaits `psi` early, to fail before dialing, and sends the
    // first frame.
    const acquire: Acquire = async ({ signal, onStage, onStages }) => {
      const psi = PSI() as Promise<PSILibrary>;
      // The responder (inviter) returns `psi` unresolved and the owner awaits it
      // late; if the connection setup fails or the signal aborts first, that await
      // is never reached. Attach a fire-and-forget handler so a rejecting PSI()
      // (e.g. a WASM-asset load failure) on a torn-down exchange cannot surface as
      // an unhandled rejection -- the real `await psi` still throws and is handled.
      void psi.catch(() => undefined);
      const csvResult = await loadCSVFile(files[0]);
      const rawRows = csvResult.data as Array<Record<string, string>>;
      const columns = csvResult.meta.fields ?? [];

      // Pre-flight for the acceptor: the CSV must satisfy the adopted linkage
      // terms the user just consented to on the consent screen. A mismatch is
      // silent at exchange time (fields resolve to empty and keys produce no
      // strings), so check here before any connection is opened.
      if (config.role === "acceptor") {
        const unsatisfied = unsatisfiedLinkageFields(
          columns,
          config.linkageTerms,
        );
        if (unsatisfied.length > 0) {
          const unsatisfiedNames = new Set(unsatisfied.map((f) => f.name));
          const satisfiableKeyCount = config.linkageTerms.linkageKeys.filter(
            (k) => k.elements.every((e) => !unsatisfiedNames.has(e.field)),
          ).length;
          const fieldList = unsatisfied
            .map((f) => sanitizeForDisplay(f.name))
            .join(", ");
          if (satisfiableKeyCount === 0)
            throw new Error(
              `Your CSV does not cover any of the linkage fields required by ` +
                `this invitation (missing: ${fieldList}). No matches are ` +
                "possible. Upload a file that includes columns for the " +
                "required field types.",
            );
          setWarningAlert({
            title: "Partial CSV coverage",
            message:
              `Your CSV is missing some linkage fields (${fieldList}). ` +
              "Keys that depend on those fields will be inactive for this " +
              "exchange; other keys will proceed normally.",
          });
        }
      }

      // The acceptor adopts the inviter's linkage terms (the same terms shown on
      // the consent screen), so the run is governed by the terms the user
      // consented to rather than a default inferred from the acceptor's CSV
      // columns. The inviter is the source of the terms and infers its own from
      // its CSV. Either party's metadata, standardization, and payloads still
      // derive from its own CSV -- only the acceptor's linkage terms are adopted.
      const dataSpec: ExchangeDataSpec =
        config.role === "acceptor"
          ? acceptorExchangeDataSpec(config.linkageTerms, partyName)
          : {};
      const prepared = prepareForExchange(dataSpec, partyName, rawRows, columns);
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
      // Acceptor: dial the inviter's derived id (dialAsAcceptor tears down its own
      // peer on failure, so acquisition stays atomic).
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
      },
      onError: ({ category, error }) => {
        // Dev-gated: the raw Error object's message/cause can embed
        // partner-/server-controlled bytes (e.g. a hostile message-file path in
        // a transport error), so a production console carries none of it, while a
        // developer (or a deployed client with the diagnostics toggle on) keeps
        // the full object -- expandable stack and `.cause` chain. The adjacent
        // user-facing alert is separately sanitized below.
        whenDiagnostic(() => console.error(error));
        if (category === "output") {
          // The exchange succeeded; only results-file generation failed. The user
          // must not be told to re-run a privacy-sensitive exchange.
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
          // not be confirmed as the invited partner. Unlike a transport drop this
          // is not retryable -- a silent retry would re-run into the same wrong
          // secret, or into a peer that is tampering -- so the user is steered to
          // a fresh invitation rather than a re-run. The underlying error is
          // dev-gated to the console above but deliberately kept out of the alert:
          // the kex failure message is intentionally non-oracular, and the other
          // tagged cases carry developer-facing text (secret-format rules,
          // re-invite phrasing) that does not belong in an end-user alert.
          setErrorAlert({
            title: "Could not verify your partner",
            message:
              "The secure handshake failed, so this connection could not be " +
              "confirmed as your invited partner. This happens when the other " +
              "party used a different invitation link, or if the connection was " +
              "tampered with. Do not retry; start over with a fresh invitation.",
          });
        } else {
          setErrorAlert({
            title: "Exchange failed",
            // A failed exchange can surface a raw transport error whose message
            // or cause chain embeds partner-/server-controlled bytes (a hostile
            // message-file path); route it through the display-boundary seam so
            // the alert cannot render control/ANSI/deceptive-Unicode characters.
            message: sanitizeErrorForDisplay(error),
          });
        }
      },
    });
  };

  return (
    <Stack>
      {errorAlert && (
        // pre-line preserves the newline sanitizeErrorForDisplay puts before
        // each "caused by:" link (browsers collapse it otherwise) so a
        // multi-cause error shows one cause per line; the message is already
        // escaped, so the only newlines present are this module's separators.
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
      <FileSelect
        handleSubmit={handleSubmit}
        submitted={submitted}
        files={files}
        setFiles={setFiles}
      />
    </Stack>
  );
}
