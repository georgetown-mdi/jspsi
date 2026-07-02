import log from "loglevel";

import { useEffect, useRef, useState } from "react";

import { Alert, Grid, Stack } from "@mantine/core";

import { IconAlertCircle, IconAlertTriangle } from "@tabler/icons-react";

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
  serializeExchangeRecordFile,
} from "@psilink/core";

import { dialAsAcceptor, listenAsInviter } from "@psi/rendezvous";
import { acceptorExchangeDataSpec } from "@psi/acceptInvitation";
import { disclosedColumnNames } from "@psi/metadataEditing";
import { inviterExchangeDataSpec } from "@psi/advancedInvite";
import { runExchangeLifecycle } from "@psi/exchangeLifecycle";
import { waitForIncomingConnection } from "@psi/waitForConnection";

import { whenDiagnostic } from "@utils/diagnostics";

import { ExchangeSummary } from "@components/ExchangeSummary";
import { ShareBlock } from "@components/ShareBlock";
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
  Metadata,
  PreparedExchange,
  Standardization,
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
 * and pre-flighted -- so it renders no file prompt and auto-dials on arrival. The
 * inviter is the SOURCE of the terms: it derived them from its file at invite time
 * and embedded exactly them in the token, so it carries that same `linkageTerms`
 * object (no re-derivation) along with the CSV parsed at compose time, and -- being
 * the responder that listens -- likewise auto-dials on arrival with no Start press.
 * Either way the exchange runs straight from `acquired` with no re-parse.
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
      /** The inviter's edited per-party column metadata from the Advanced-options
       * editor, threaded into its own `prepareForExchange` (never embedded in the
       * token), so its disclosure choices govern what it sends and its column
       * bindings match the keys it authored. Absent on the quick path, where the
       * inviter's metadata is inferred from its columns. */
      metadata?: Metadata;
      /** The inviter's authored per-party standardization from the Advanced-options
       * workbench, paired with {@link metadata} and threaded into its own
       * `prepareForExchange` (never the token), so its cleaning and per-field
       * input-column binding match the keys it authored. Absent on the quick path
       * (and when the inviter authored no cleaning), where standardization is
       * inferred from the columns. */
      standardization?: Standardization;
      /** The shareable artifacts the inviter copies out-of-band, surfaced in the
       * exchange screen's share block (the inviter waits here for the partner to
       * accept). Both decode to the same token; the deep link prefills the accept
       * page, the encoded string is pasted when the link cannot be used. */
      share: { deepLink: string; encoded: string };
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
      /** The columns the invitation declared the inviter will send (its
       * `disclosedPayloadColumns`), in the inviter's namespace -- what this party
       * consented to RECEIVE. Locked in as `prepared.expectedPayloadColumns` so a
       * received payload whose column set differs aborts the exchange (see
       * `reconcileReceivedPayload`). Absent on an invitation that carried no
       * disclosed subset (an older or metadata-unknown mint), where this party
       * reconciles lazily. */
      disclosedPayloadColumns?: Array<string>;
      /** The CSV parsed on the accept review screen, fed straight into the exchange
       * on arrival: no re-parse, and no file prompt here. Mirrors the inviter's
       * `acquired`. */
      acquired: AcquiredBundle;
      /** The per-party metadata and standardization the acceptor authored in the
       * "Prepare your data" editor, threaded into `prepareForExchange` via
       * {@link acceptorExchangeDataSpec}. Local and never cross-checked, so they
       * govern this party's match rate and disclosure without touching the agreed
       * terms the consent screen accepted. */
      metadata: Metadata;
      standardization: Standardization;
      /** The partial-coverage advisory the editor raised, if any, seeded into the
       * warning slot so it stays visible through the run (kept on success, cleared
       * on a run failure). Absent when the file satisfied every linkage key. */
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
 * The run half of a web exchange, shared by both roles: it takes an
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

  // The screen-level accessibility throughline. Three focus targets, each its own
  // ref so the effects below stay independent:
  //  - leadingHeadingRef: the exchange-summary heading both roles now lead with --
  //    the summary sits in the left column, and the inviter's share block moved
  //    below the two columns. Focused once on mount so a keyboard/screen-reader
  //    user who pressed Generate/Accept lands on the new screen rather than on the
  //    unmounted button. This is the entry move, not a mid-protocol one.
  //  - resultsHeadingRef: the Status heading, focused on `done` so the results are
  //    announced, and also when the partner connects -- the inviter's share block
  //    unmounts then, so this recovers the focus that unmount would otherwise
  //    orphan (see the peer-connect effect). Other mid-protocol stages do NOT move
  //    focus (the Status live region announces them instead).
  //  - errorAlertRef: a blocking error alert, focused so it is announced and
  //    actionable. `done` and a blocking error are mutually exclusive (a successful
  //    run reaches `done` and sets no alert; every error path leaves the stage
  //    short of `done`), so the two effects never fight over focus.
  const leadingHeadingRef = useRef<HTMLHeadingElement>(null);
  const resultsHeadingRef = useRef<HTMLHeadingElement>(null);
  const errorAlertRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    leadingHeadingRef.current?.focus();
  }, []);
  useEffect(() => {
    if (errorAlert) errorAlertRef.current?.focus();
  }, [errorAlert]);
  useEffect(() => {
    if (stageId === "done") resultsHeadingRef.current?.focus();
  }, [stageId]);

  // The partner is connected once the run has advanced past the pre-stages
  // ("before start"/"waiting for peer") into a protocol stage. Drives the inviter
  // share block's removal: once connected there is nothing left to share, so the
  // link/code block (rendered below the columns) drops out entirely.
  const peerConnected = !preStages.some((stage) => stage.id === stageId);

  // Recover focus orphaned by the inviter share block UNMOUNTING on peer-connect:
  // once the partner connects the share block (which may hold focus -- its heading
  // or a copy button) is removed, so the focused node disappears and the browser
  // drops focus to <body>. Move it onto the Status heading so a keyboard/screen-
  // reader user is taken to the run's progress rather than stranded -- but ONLY
  // when focus is on <body>, so focus the user moved to a live element (the
  // summary, the Status downloads) is not stolen. The <body> check cannot
  // distinguish "orphaned by the unmount" from a screen reader in browse mode
  // (which parks real focus on <body> while its virtual cursor reads elsewhere); in
  // that case this pulls the cursor to the Status heading -- an acceptable one-shot,
  // since the connection is the timely, relevant event and the Status live region
  // announces the stage regardless. A no-op for the acceptor, which renders no
  // share block, so peer-connect leaves its focus untouched.
  useEffect(() => {
    if (!peerConnected) return;
    const active = document.activeElement;
    if (!active || active === document.body) resultsHeadingRef.current?.focus();
  }, [peerConnected]);

  // Heading level for the terms and Status headings, so the outline nests under
  // each screen's container: the acceptor sits below the accept page's h1 (h2),
  // the inviter below the invite section's h2 (h3, matching the share block).
  const headingOrder = config.role === "inviter" ? 3 : 2;

  // Revoke this exchange's object URLs when the component unmounts (or before a
  // replacement set is stored): createObjectURL keeps each Blob alive until it is
  // revoked, and the combined record blob holds the matched data, so it should not
  // outlive the page that backs it.
  useEffect(() => {
    if (outputs === undefined) return;
    return () => {
      // resultsUrl is absent when the result was withheld from this party (a
      // non-receiving helper); only revoke a URL that was actually created.
      if (outputs.resultsUrl !== undefined)
        window.URL.revokeObjectURL(outputs.resultsUrl);
      if (outputs.record !== undefined)
        window.URL.revokeObjectURL(outputs.record.recordUrl);
    };
  }, [outputs]);

  // Start the connection lifecycle from an already-loaded, already-checked CSV:
  // both roles arrive with one in config.acquired -- the acceptor's parsed and
  // pre-flighted on the review screen, the inviter's parsed at compose time -- and
  // both auto-start from the mount effect below. Both sources guarantee at least one
  // satisfiable linkage key -- the acceptor via its pre-flight, the inviter via
  // generateInvitation's fail-closed block -- so an unsatisfiable file never reaches
  // here: nothing is dialed and the connecting UI does not mount.
  const handleStart = (bundle: AcquiredBundle) => {
    // Guard against re-entry: once an exchange is in flight its AbortController is
    // stored here, and starting a second would orphan the first's signal and race
    // two lifecycles on shared state. Start is offered at most once per mount, but
    // this makes the one-exchange-per-mount invariant explicit -- a fresh exchange
    // comes from a fresh mount (ExchangeView is keyed by the secret).
    if (abortRef.current) return;

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
      const jsonUrl = (text: string): string =>
        window.URL.createObjectURL(
          new Blob([text], { type: "application/json" }),
        );
      // The exchange withholds the result table from a party whose agreed terms
      // give it no output (a one-sided exchange where this party is the PSI
      // sender/helper): result.associationTable is undefined. Produce no results
      // file -- the UI shows it contributed but receives no result -- while still
      // offering the audit record below (the helper's record does not bind the
      // table, but the record itself is produced).
      const generated: ExchangeOutputs =
        result.associationTable === undefined
          ? { resultWithheld: true }
          : (() => {
              const { headers, rows } = buildOutputTable(
                result.associationTable,
                prepared.rawRows,
                prepared.metadata,
                result.partnerPayload,
              );
              const csv =
                headers.join(",") +
                "\n" +
                rows.map((r) => r.join(",") + "\n").join("");
              return {
                resultsUrl: window.URL.createObjectURL(
                  new Blob([csv], { type: "text/csv" }),
                ),
              };
            })();
      // The combined record is produced only when the audit pair exists; it is
      // absent if building the record failed after a successful exchange, in which
      // case the download is intentionally omitted without a blocking alert. The
      // filename is timestamped per exchange (the record's own createdAt, made
      // filesystem-safe) so repeated downloads in one session accumulate rather
      // than collide.
      if (result.audit !== undefined) {
        const stamp = result.audit.record.createdAt.replace(/[:.]/g, "-");
        // One download: the public record and the private opening packaged in a
        // single { public, private } JSON file. Because it embeds the private
        // opening it is as sensitive as the matched data (Status labels it "keep
        // private").
        generated.record = {
          recordUrl: jsonUrl(
            serializeExchangeRecordFile({
              public: result.audit.record,
              private: result.audit.opening,
            }),
          ),
          recordFileName: `psilink-record-${stamp}.json`,
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
      // Each party's metadata, standardization, and payloads stay per-party and
      // local -- only the linkage terms are pinned to the invitation. Each role's
      // spec is assembled by its own builder ({@link acceptorExchangeDataSpec} /
      // {@link inviterExchangeDataSpec}), so neither role feeds core a
      // self-contradictory spec that would fail closed -- by different means. The
      // inviter's builder RECONCILES its authored standardization to the terms
      // (standardizationForTerms drops a disabled key's orphaned transform). The
      // acceptor is safe BY CONSTRUCTION, not by a reconcile: its standardization is
      // derived from the adopted terms via getDefaultStandardization, so its outputs
      // are already exactly those terms' declared fields. Core's throw is the
      // backstop for both. The acceptor carries the metadata/standardization it
      // authored in the "Prepare your data" editor; the inviter carries what it
      // authored in the Advanced editor (both omitted on the quick path, where
      // prepareForExchange infers them from the CSV).
      const dataSpec: ExchangeDataSpec =
        config.role === "acceptor"
          ? acceptorExchangeDataSpec(config.linkageTerms, partyName, {
              metadata: config.metadata,
              standardization: config.standardization,
            })
          : inviterExchangeDataSpec(config.linkageTerms, {
              metadata: config.metadata,
              standardization: config.standardization,
            });
      const prepared = prepareForExchange(
        dataSpec,
        partyName,
        rawRows,
        columns,
      );
      // Acceptor lock-in: verify the inviter transmits exactly the columns the
      // invitation declared (and the consent screen showed), aborting otherwise.
      // The inviter is lazy on its own receive side, so it leaves this unset.
      if (config.role === "acceptor")
        prepared.expectedPayloadColumns = config.disclosedPayloadColumns;
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
        } else if (category === "config") {
          // A prepare-time fault in the operator's OWN config, safe to surface
          // because its message names only local content (an OperatorConfigError;
          // classifyExchangeFailure scopes "config" to that base type, so the
          // partner-influenceable payload-send UsageError lands in the generic
          // branch below instead). Today that is a standardization contradicting
          // the linkage terms. Not a transport drop: retrying as-is fails
          // identically, so surface the (sanitized) message -- actionable -- rather
          // than the generic transient-failure copy that would wrongly deny a
          // data/config problem.
          setErrorAlert({
            title: "Could not prepare the exchange",
            message: sanitizeForDisplay(errorMessage(error)),
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

  // Both roles auto-start from their already-acquired, already-checked bundle: the
  // inviter as the responder that listens, the acceptor as the initiator that dials.
  // The acceptor reaches this screen only after it consented and prepared its data,
  // so dialing on arrival discloses nothing new -- it just removes a redundant Start
  // press after the user already accepted and confirmed. Runs once per mount --
  // ExchangeView is keyed by the secret, so a fresh exchange is a fresh mount, and
  // handleStart's re-entry guard plus the StrictMode-safe abort cleanup above keep a
  // double-invoked effect from racing two runs.
  useEffect(() => {
    handleStart(config.acquired);
  }, []);

  return (
    <Stack>
      {errorAlert && (
        // This slot carries only the run lifecycle's error messages: the acceptor's
        // file read and pre-flight errors surface on the review screen, not here.
        // Those run-error messages are fixed strings or a single
        // sanitizeForDisplay'd message with no embedded newlines; pre-line is kept
        // defensively so any future multi-line message renders one line per line
        // rather than run together. tabIndex + ref so a blocking error takes focus.
        // Full-width above the columns so it is not boxed into one of them.
        <Alert
          color="red"
          // A severity icon so error is not signalled by color alone (WCAG
          // 1.4.1); aria-hidden because the title text already names the error.
          icon={<IconAlertCircle aria-hidden />}
          title={errorAlert.title}
          style={{ whiteSpace: "pre-line" }}
          ref={errorAlertRef}
          tabIndex={-1}
        >
          {errorAlert.message}
        </Alert>
      )}
      {warningAlert && (
        <Alert
          color="yellow"
          // A severity icon so warning is not signalled by color alone (WCAG
          // 1.4.1), and is distinguishable from the red error icon; aria-hidden
          // because the title text already names the warning.
          icon={<IconAlertTriangle aria-hidden />}
          title={warningAlert.title}
        >
          {warningAlert.message}
        </Alert>
      )}
      {/* The summary stays on the RIGHT -- the same side it sits on while setting
          up -- so the agreed reference keeps a consistent place across the flow.
          Status (the run's progress and downloads) takes the LEFT, upper area, so it
          is visible without scrolling. Columns stack on a narrow viewport
          (base: 12). */}
      <Grid gap="xl" align="flex-start">
        <Grid.Col span={{ base: 12, md: 5 }}>
          <Status
            stages={stages}
            stageId={stageId}
            headingRef={resultsHeadingRef}
            headingOrder={headingOrder}
            resultsFileURL={outputs?.resultsUrl}
            resultWithheld={outputs?.resultWithheld}
            recordFileURL={outputs?.record?.recordUrl}
            recordFileName={outputs?.record?.recordFileName}
          />
        </Grid.Col>
        <Grid.Col span={{ base: 12, md: 7 }}>
          <ExchangeSummary
            linkageTerms={config.linkageTerms}
            perspective={config.role === "inviter" ? "proposing" : "accepted"}
            headingOrder={headingOrder}
            // Both roles lead with the summary heading (the inviter's share block
            // moved below the columns).
            headingRef={leadingHeadingRef}
            // The inviter's expiry is shown in the share block below, so it is
            // withheld here to avoid showing the same deadline twice; the acceptor
            // has no share block, so its summary carries the expiry.
            expires={config.role === "inviter" ? undefined : config.expires}
            // The acceptor shows what it will RECEIVE from the carried disclosed set
            // (the same set the consent screen showed); the inviter previews its own
            // proposal, which has no carried field and falls back to its authored
            // payload.send -- faithful because both web mint paths author
            // payload.send to the disclosed predicate (asserted by
            // assertPayloadSendDisclosed at the mint boundary).
            disclosedPayloadColumns={
              config.role === "acceptor"
                ? config.disclosedPayloadColumns
                : undefined
            }
            // The acceptor surfaces the columns IT will send, derived from the
            // metadata it prepared -- the same disclosedColumnNames predicate the
            // run transmits on, so the chips cannot drift from what leaves the
            // machine. The inviter's own send already renders inside the terms under
            // "proposing", so it passes none here.
            sendColumns={
              config.role === "acceptor"
                ? disclosedColumnNames(config.metadata)
                : undefined
            }
          />
        </Grid.Col>
      </Grid>
      {/* The inviter's link/code to share out-of-band, below the columns so the
          summary and Status lead. It drops out entirely once the partner connects:
          there is nothing left to share, and Status then shows the run is underway,
          so the block (and any "Partner connected" restatement) would only add
          noise. The acceptor renders no share block. */}
      {config.role === "inviter" && !peerConnected && (
        <ShareBlock
          deepLink={config.share.deepLink}
          encoded={config.share.encoded}
          expires={config.expires}
        />
      )}
    </Stack>
  );
}
