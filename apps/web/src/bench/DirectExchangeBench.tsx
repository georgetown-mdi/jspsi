import { useEffect, useRef, useState } from "react";

import { Alert, Anchor } from "@mantine/core";
import { IconAlertCircle } from "@tabler/icons-react";
import { Link } from "@tanstack/react-router";

import { emptyColumnPositions, unnameableColumnsAlert } from "@psi/columnNames";
import { deleteSftpConnection } from "@psi/sftpAuthoringClient";
import { fetchJobRendezvous } from "@psi/workInputClient";
import { fetchSftpConnection } from "@psi/serverJobExchangeDriver";

import { isConsoleBuild } from "@utils/clientConfig";

import {
  RUN_DIAGNOSTICS_DEFAULT,
  runDiagnosticsAfterRetarget,
  runDiagnosticsIntentFields,
} from "@psi/runDiagnosticsModel";

import {
  CONNECTION_TUNING_DEFAULT,
  FILEDROP_CONNECTION_TUNING,
  SFTP_CONNECTION_TUNING,
  withConnectionTuning,
} from "./connectionTuningModel";
import {
  DIRECT_LINKAGE_STRATEGY_DEFAULT,
  DIRECT_STEP_LABELS,
  DIRECT_STEP_ORDER,
  directLinkageStrategyIntentFields,
} from "./directExchangeModel";
import {
  EXCHANGE_FILES_DEFAULT,
  ZERO_SETUP_EXCHANGE_FILES,
  exchangeFilesOptions,
} from "./exchangeFilesModel";
import { BenchPage } from "./BenchPage";
import { BenchShell } from "./BenchShell";
import { DirectConfirmSection } from "./DirectConfirmSection";
import { DirectRunSection } from "./DirectRunSection";
import { DirectServerSection } from "./DirectServerSection";
import { RecoveredExchangePanel } from "./RecoveredExchangePanel";
import { ServerFilePicker } from "./ServerFilePicker";
import { TopBar } from "./TopBar";
import styles from "./bench.module.css";
import { useDirectExchange } from "./useDirectExchange";

import type { DirectStep, DirectTransport } from "./directExchangeModel";
import type {
  JobInputSource,
  SftpConnectionInfo,
} from "@psi/serverJobExchangeDriver";
import type {
  JobRendezvousConfig,
  ProfiledJobInput,
} from "@psi/workInputClient";
import type { AlertContent } from "@components/csvIntake";
import type { ConnectionTuningDraft } from "./connectionTuningModel";
import type { ExchangeFilesDraft } from "./exchangeFilesModel";
import type { LinkageStrategy } from "@psilink/core";
import type { RailStep } from "@psi/inviterModel";
import type { RunDiagnosticsDraft } from "@psi/runDiagnosticsModel";
import type { SftpConnectionProjection } from "@jobs/jobManager";

const TRANSPORT_NOTES: Record<DirectTransport, string> = {
  sftp: "SFTP",
  filedrop: "Shared directory",
};

/**
 * The "Direct exchange" console: a symmetric, single-column spine for the
 * CLI's zero-setup exchange -- no invitation minted or accepted, terms inferred from
 * each party's own file, both parties running against the same out-of-band-agreed
 * server. Choose the mounted input CSV, author the agreed server (SFTP free-hand or
 * the filedrop rendezvous), confirm the inferred terms and affirm the transport-only
 * trust model, then run on the console.
 *
 * Console-only: on a hosted build the flow renders a not-available notice, since it
 * drives the console's job API (which a hosted deployment does not run). The
 * lobby's third card and this route are both gated the same way.
 */
export function DirectExchangeBench() {
  const consoleBuild = isConsoleBuild();

  const [step, setStep] = useState<DirectStep>("file");
  const [consoleSource, setConsoleSource] = useState<ProfiledJobInput>();
  const [intakeAlert, setIntakeAlert] = useState<AlertContent>();
  const [transport, setTransport] = useState<DirectTransport>("sftp");
  const [sftpInfo, setSftpInfo] = useState<SftpConnectionInfo>();
  const [rendezvous, setRendezvous] = useState<JobRendezvousConfig>();
  const [identity, setIdentity] = useState("");
  // The strategy the linkage keys run under, agreed out of band like the server
  // itself: both parties infer their own terms here, so the two must select the
  // same value or the exchange aborts when they meet.
  const [linkageStrategy, setLinkageStrategy] = useState<LinkageStrategy>(
    DIRECT_LINKAGE_STRATEGY_DEFAULT,
  );
  const [affirmed, setAffirmed] = useState(false);
  // The operator's file-handling choices for this run, authored beside the agreed
  // server (both parties settle these out of band, exactly as they settle the
  // server). The disclosure's open state rides alongside.
  const [exchangeFiles, setExchangeFiles] = useState<ExchangeFilesDraft>(
    EXCHANGE_FILES_DEFAULT,
  );
  const [exchangeFilesOpen, setExchangeFilesOpen] = useState(false);
  // The operator's connection-tuning choices for this run, authored beside the
  // file-handling ones and settled out of band the same way.
  const [connectionTuning, setConnectionTuning] =
    useState<ConnectionTuningDraft>(CONNECTION_TUNING_DEFAULT);
  const [connectionTuningOpen, setConnectionTuningOpen] = useState(false);
  // The operator's per-run diagnostic and recovery choices, authored on the same
  // step: the sweep acts on the very directory settled there.
  const [runDiagnostics, setRunDiagnostics] = useState<RunDiagnosticsDraft>(
    RUN_DIAGNOSTICS_DEFAULT,
  );
  const [runDiagnosticsOpen, setRunDiagnosticsOpen] = useState(false);

  // Fetch the console's authored SFTP connection once on a console build; one
  // fetch per console serves the session. The helper resolves to a null connection
  // on any failure or when none is authored, so the SFTP step then offers
  // free-hand authoring.
  useEffect(() => {
    if (!consoleBuild || sftpInfo !== undefined) return;
    let cancelled = false;
    void fetchSftpConnection().then((info) => {
      if (!cancelled) setSftpInfo(info);
    });
    return () => {
      cancelled = true;
    };
  }, [consoleBuild, sftpInfo]);

  // Fetch the console's rendezvous mount once on a console build; the mount is
  // boot-static, so one fetch per console serves the session. The helper fails
  // safe to `{ configured: false }`, so the filedrop transport stays disabled
  // unless the console confirms a mounted directory.
  useEffect(() => {
    if (!consoleBuild || rendezvous !== undefined) return;
    let cancelled = false;
    void fetchJobRendezvous().then((config) => {
      if (!cancelled) setRendezvous(config);
    });
    return () => {
      cancelled = true;
    };
  }, [consoleBuild, rendezvous]);

  const sftpConnection = sftpInfo === undefined ? null : sftpInfo.connection;

  // The console reads the mounted file in place, so a run holds only a REFERENCE
  // (the opaque name), never the content.
  const inputSource: JobInputSource | undefined =
    consoleSource !== undefined
      ? { kind: "workFile", name: consoleSource.name }
      : undefined;

  const {
    run,
    outputs,
    failure,
    warnings,
    started,
    jobId,
    reattached,
    reattaching,
    start,
    tryAgain,
    reset,
    abandonRun,
  } = useDirectExchange({
    channel: transport,
    inputSource,
    ...(identity.trim().length > 0 ? { identity: identity.trim() } : {}),
    ...directLinkageStrategyIntentFields(linkageStrategy),
    options: withConnectionTuning(
      exchangeFilesOptions(exchangeFiles, ZERO_SETUP_EXCHANGE_FILES),
      connectionTuning,
      transport === "sftp"
        ? SFTP_CONNECTION_TUNING
        : FILEDROP_CONNECTION_TUNING,
    ),
    runDiagnostics: runDiagnosticsIntentFields(runDiagnostics),
  });

  // Move focus to the incoming section's h1 on a step change (skip mount), so a
  // screen-reader user is not left on a control that unmounted.
  const headingRef = useRef<HTMLDivElement>(null);
  const mounted = useRef(false);
  useEffect(() => {
    if (mounted.current) headingRef.current?.querySelector("h1")?.focus();
    mounted.current = true;
  }, [step]);

  function goTo(next: DirectStep) {
    setStep(next);
  }

  // Commit a profiled mounted file. A blank header cell is refused early with the
  // shared unnameable alert -- core's inferMetadata would otherwise throw at preview
  // time. A fresh file drops the trust affirmation, so the operator re-affirms for
  // the new context, then advances to the server step.
  function commitFile(profile: ProfiledJobInput) {
    const emptyPositions = emptyColumnPositions(profile.columns);
    if (emptyPositions.length > 0) {
      setConsoleSource(undefined);
      setIntakeAlert(unnameableColumnsAlert(emptyPositions));
      return;
    }
    setIntakeAlert(undefined);
    setConsoleSource(profile);
    setAffirmed(false);
    goTo("server");
  }

  function authorSftpConnection(connection: SftpConnectionProjection) {
    setSftpInfo({ connection });
    // Re-authoring the server changes the trust context, so re-affirm.
    setAffirmed(false);
    // It is also a different rendezvous directory, so any sweep confirmation is
    // re-asked.
    setRunDiagnostics(runDiagnosticsAfterRetarget);
  }

  function clearSftpConnection() {
    setSftpInfo({ connection: null });
    setAffirmed(false);
    void deleteSftpConnection();
  }

  function chooseTransport(next: DirectTransport) {
    setTransport(next);
    // A different agreed server is a different trust context.
    setAffirmed(false);
    // And a different rendezvous directory, so any sweep confirmation is
    // re-asked.
    setRunDiagnostics(runDiagnosticsAfterRetarget);
  }

  function runExchange() {
    start();
    goTo("run");
  }

  // Start over from a terminal failure: discard the occupying job and clear the run
  // so the file step is fully usable again (Run re-enabled, the slot freed), then
  // return to it. Without the reset the failed job would strand the single slot and
  // Run would stay disabled.
  function startOver() {
    reset();
    goTo("file");
  }

  if (!consoleBuild)
    return (
      <BenchPage>
        <main className={styles.lobby}>
          <h1>Direct exchange</h1>
          <p>
            Running an exchange you have already arranged is a console feature.
            It is not available in this browser-only deployment.{" "}
            <Anchor component={Link} to="/" inherit>
              Back to the start
            </Anchor>
            .
          </p>
        </main>
      </BenchPage>
    );

  const currentIndex = DIRECT_STEP_ORDER.indexOf(step);
  const steps: Array<RailStep> = DIRECT_STEP_ORDER.map((entry, position) => {
    const state =
      entry === step ? "current" : position < currentIndex ? "done" : "pending";
    // Earlier done steps are navigable until a run starts; once it has, the stepper
    // locks (the run has the console's single slot, and its own surface is the way
    // forward -- try again, start over, or set up another).
    const selectable = state === "done" && !started;
    return {
      label: DIRECT_STEP_LABELS[entry],
      state,
      onSelect: selectable ? () => goTo(entry) : undefined,
    };
  });

  return (
    <BenchShell
      topBar={
        <TopBar
          navLabel="Direct exchange"
          steps={steps}
          transportNote={
            step === "confirm" || step === "run"
              ? TRANSPORT_NOTES[transport]
              : undefined
          }
        />
      }
    >
      <div ref={headingRef}>
        {step === "file" && (
          <>
            <h1 tabIndex={-1}>Your file</h1>
            {consoleSource === undefined && <RecoveredExchangePanel />}
            {intakeAlert !== undefined && (
              <Alert
                color="red"
                icon={<IconAlertCircle aria-hidden />}
                title={intakeAlert.title}
                mb="md"
              >
                {intakeAlert.message}
              </Alert>
            )}
            <ServerFilePicker
              committed={
                consoleSource !== undefined
                  ? { name: consoleSource.name }
                  : undefined
              }
              onUse={commitFile}
            />
          </>
        )}
        {step === "server" && (
          <DirectServerSection
            transport={transport}
            onTransport={chooseTransport}
            sftpConnection={sftpConnection}
            rendezvous={rendezvous}
            exchangeFiles={exchangeFiles}
            exchangeFilesOpen={exchangeFilesOpen}
            onExchangeFiles={setExchangeFiles}
            onExchangeFilesOpen={setExchangeFilesOpen}
            connectionTuning={connectionTuning}
            connectionTuningOpen={connectionTuningOpen}
            onConnectionTuning={setConnectionTuning}
            onConnectionTuningOpen={setConnectionTuningOpen}
            runDiagnostics={runDiagnostics}
            runDiagnosticsOpen={runDiagnosticsOpen}
            onRunDiagnostics={setRunDiagnostics}
            onRunDiagnosticsOpen={setRunDiagnosticsOpen}
            onAuthorConnection={authorSftpConnection}
            onClearConnection={clearSftpConnection}
            onContinue={() => goTo("confirm")}
            onBack={() => goTo("file")}
          />
        )}
        {step === "confirm" && consoleSource !== undefined && (
          <DirectConfirmSection
            profile={consoleSource}
            identity={identity}
            onIdentity={setIdentity}
            linkageStrategy={linkageStrategy}
            onLinkageStrategy={setLinkageStrategy}
            affirmed={affirmed}
            onAffirm={setAffirmed}
            onRun={runExchange}
            onBack={() => goTo("server")}
            running={started}
          />
        )}
        {step === "run" && (
          <DirectRunSection
            run={run}
            outputs={outputs}
            failure={failure}
            warnings={warnings}
            jobId={jobId}
            reattached={reattached}
            reattaching={reattaching}
            onTryAgain={tryAgain}
            onStartOver={startOver}
            onAbandon={abandonRun}
          />
        )}
      </div>
    </BenchShell>
  );
}
