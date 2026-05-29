import log from "loglevel";

import { createFileRoute, useSearch } from "@tanstack/react-router";

import { useState } from "react";

import {
  ActionIcon,
  Alert,
  Code,
  Container,
  CopyButton,
  Group,
  Paper,
  Stack,
  Text,
  Title,
  Tooltip,
} from "@mantine/core";

import { IconCheck, IconCopy } from "@tabler/icons-react";

// @ts-ignore this is really there
import PSI from "@openmined/psi.js/psi_wasm_web";

import {
  CONFIRMING_PROTOCOL_STAGE_ID,
  ProcessState,
  buildOutputTable,
  describeExchangeStages,
  loadCSVFile,
  prepareForExchange,
  runExchange,
} from "@psilink/core";
import { openPeerConnection, waitForPeerId } from "@psi/server";
import { createAndSharePeerId } from "@psi/client";
import { openPeerMessageConnection } from "@psi/peerMessageConnection";
import { waitForIncomingConnection } from "@psi/waitForConnection";

import FileSelect from "@components/FileSelect";
import SessionDetails from "@components/SessionDetails";
import { Status } from "@components/Status";

import type { PSILibrary } from "@openmined/psi.js/implementation/psi.d.ts";

import type { DataConnection } from "peerjs";
import type Peer from "peerjs";

import type {
  ExchangeResult,
  MessageConnection,
  PreparedExchange,
} from "@psilink/core";
import type { LinkSession } from "@utils/sessions";

export const Route = createFileRoute("/psi")({
  validateSearch: (
    search: Record<string, unknown>,
  ): { uuid: string; start?: boolean } => {
    return {
      uuid: (search.uuid as string) || "",
      start: (search.start as boolean) || false,
    };
  },
  loaderDeps: ({ search: { uuid } }) => ({ uuid }),
  ssr: false,
  loader: async ({ deps: { uuid } }) => {
    const response = await fetch(`/api/psi/${uuid}`);
    if (!response.ok) {
      throw new Error(
        `failed to lookup PSI with id ${uuid} with error: ` +
          response.statusText,
      );
    }
    return (await response.json()) as LinkSession;
  },
  component: Home,
});

type StageDefinition = { id: string; label: string; state: ProcessState };

const serverPreStages: Array<StageDefinition> = [
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

const clientPreStages: Array<StageDefinition> = [
  {
    id: "before start",
    label: "Before start",
    state: ProcessState.BeforeStart,
  },
];

const doneStage: StageDefinition = {
  id: "done",
  label: "Done",
  state: ProcessState.Done,
};

function buildInitialStages(role: "server" | "client"): Array<StageDefinition> {
  const preStages = role === "server" ? serverPreStages : clientPreStages;
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

function Home() {
  const session = Route.useLoaderData();
  const role = useSearch({
    strict: false,
    select: (search) => search.start,
  })
    ? "server"
    : "client";

  const [stages, setStages] = useState<Array<StageDefinition>>(() =>
    buildInitialStages(role),
  );

  const [files, setFiles] = useState<Array<File>>([]);
  const [submitted, setSubmitted] = useState(false);
  const [stageId, setStageById] = useState<string>("before start");
  const [resultURL, setResultURL] = useState<string>();
  const [errorAlert, setErrorAlert] = useState<{
    title: string;
    message: string;
  }>();

  const handleSubmit = () => {
    setSubmitted(true);
    setErrorAlert(undefined);

    const describeError = (error: unknown) =>
      error instanceof Error ? error.message : String(error);

    const handleFailure = (error: unknown) => {
      console.error(error);
      setErrorAlert({
        title: "Exchange failed",
        message: describeError(error),
      });
    };

    const finishExchange = (
      { associationTable, partnerPayload }: ExchangeResult,
      prepared: PreparedExchange,
    ) => {
      log.info("linkage complete, generating results file");
      const { headers, rows } = buildOutputTable(
        associationTable,
        prepared.rawRows,
        prepared.metadata,
        partnerPayload,
      );
      const csv =
        headers.join(",") + "\n" + rows.map((r) => r.join(",") + "\n").join("");
      const fileData = new Blob([csv], { type: "text/csv" });
      const newResultURL = window.URL.createObjectURL(fileData);
      if (resultURL !== undefined) window.URL.revokeObjectURL(resultURL);
      setResultURL(newResultURL);
      setStageById("done");
    };

    // Shared per-connection lifecycle for both roles: open a MessageConnection,
    // run the exchange, surface the result or the failure, and always tear down.
    // `psi` may still be loading - opening the connection first attaches the
    // inbound listener (so the initiator's unprompted first frame is not
    // dropped) while the WASM library finishes in parallel.
    const runExchangeOn = async (
      conn: DataConnection,
      exchangeRole: "initiator" | "responder",
      prepared: PreparedExchange,
      // Either the still-loading library (server: passed before the WASM load
      // resolves, so the inbound listener attaches first) or an already-loaded
      // one (client: resolved before the connection handler runs). await covers
      // both, so the union is intentional, not a dead branch.
      psi: PSILibrary | Promise<PSILibrary>,
      peer: Peer,
    ) => {
      let mc: MessageConnection | undefined;
      try {
        mc = await openPeerMessageConnection(conn);
        const exchangeResult = await runExchange(mc, exchangeRole, prepared, {
          psiLibrary: await psi,
          onStage: setStageById,
        });
        // The privacy-sensitive exchange has completed by here; a failure
        // building the local results file must not be reported as an exchange
        // failure, or the user may needlessly re-run a PSI exchange that in
        // fact already succeeded.
        try {
          finishExchange(exchangeResult, prepared);
        } catch (error) {
          console.error(error);
          setErrorAlert({
            title: "Results unavailable",
            message:
              "The linkage completed, but generating the results file failed: " +
              describeError(error),
          });
        }
      } catch (error) {
        handleFailure(error);
      } finally {
        // Teardown must not throw: a rejection here would propagate past the
        // handlers above and overwrite a more accurate alert (e.g. the
        // "Results unavailable" set when only output generation failed).
        try {
          peer.disconnect();
        } catch (teardownError) {
          console.error(teardownError);
        }
        try {
          await mc?.close();
        } catch (teardownError) {
          console.error(teardownError);
        }
      }
    };

    if (role === "server") {
      setStageById("waiting for peer");
      waitForPeerId(session.uuid)
        .then(async (peerId) => {
          // Load and prepare before dialing the peer. Opening the connection
          // resolves a live Peer/DataConnection that only runExchangeOn tears
          // down, so a CSV or standardization failure must happen before it
          // exists, not after, or the connection leaks. The WASM load still
          // runs in parallel and is awaited (with the inbound listener already
          // attached) inside runExchangeOn.
          const psi = PSI() as Promise<PSILibrary>;
          const csvResult = await loadCSVFile(files[0]);
          const rawRows = csvResult.data as Array<Record<string, string>>;
          const prepared = prepareForExchange(
            {}, // no explicit spec; infer from input
            session.initiatedName,
            rawRows,
            csvResult.meta.fields ?? [],
          );
          setStages([
            ...serverPreStages,
            ...describeExchangeStages(prepared).map((s) => ({
              ...s,
              state: ProcessState.Working as const,
            })),
            doneStage,
          ]);

          const [peer, conn] = await openPeerConnection(peerId);
          await runExchangeOn(conn, "responder", prepared, psi, peer);
        })
        .catch((error) => {
          handleFailure(error);
        });
    } else {
      // role is client
      setStageById("before start");
      Promise.all([PSI() as Promise<PSILibrary>, loadCSVFile(files[0])])
        .then(async ([psi, csvResult]) => {
          const rawRows = csvResult.data as Array<Record<string, string>>;
          const prepared = prepareForExchange(
            {}, // no explicit spec; infer from input
            session.invitedName,
            rawRows,
            csvResult.meta.fields ?? [],
          );
          setStages([
            ...clientPreStages,
            ...describeExchangeStages(prepared).map((s) => ({
              ...s,
              state: ProcessState.Working as const,
            })),
            doneStage,
          ]);

          const peer = await createAndSharePeerId(session);

          try {
            // A single exchange runs per session: take the first incoming
            // connection, bounded so a peer that never dials in surfaces an
            // error instead of hanging on "Confirming protocol" forever.
            const conn = await waitForIncomingConnection(peer);
            await runExchangeOn(conn, "initiator", prepared, psi, peer);
          } catch (error) {
            // Reached only when no peer dialed in within the deadline;
            // runExchangeOn handles and tears down its own failures. Drop the
            // peer we created so the timed-out attempt does not leak it.
            handleFailure(error);
            peer.disconnect();
          }
        })
        .catch((error) => {
          handleFailure(error);
        });
    }
  };

  let url: URL | undefined;
  if (role === "server") {
    const searchParams = new URLSearchParams({ uuid: session.uuid });
    url = new URL(
      `${window.location.protocol}//${window.location.host}/psi?${searchParams}`,
    );
  }

  return (
    <Container>
      <Stack>
        <Group justify="space-between" align="stretch" grow>
          <SessionDetails session={session} />
          <Status
            stages={stages}
            stageId={stageId}
            resultsFileURL={resultURL}
          />
        </Group>
        {errorAlert && (
          <Alert color="red" title={errorAlert.title}>
            {errorAlert.message}
          </Alert>
        )}
        {url && (
          <Paper>
            <Title order={2}>Sharable Link</Title>
            <Code block={false} style={{ whiteSpace: "pre", flex: 1 }}>
              {url.toString()}
            </Code>
            {
              // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
              navigator.clipboard ? (
                <CopyButton value={url.toString()} timeout={100}>
                  {({ copied, copy }) => (
                    <Tooltip label="Copy to clipboard">
                      <ActionIcon
                        onClick={copy}
                        variant={copied ? "light" : "filled"}
                      >
                        {copied ? (
                          <IconCheck size={18} />
                        ) : (
                          <IconCopy size={18} />
                        )}
                      </ActionIcon>
                    </Tooltip>
                  )}
                </CopyButton>
              ) : (
                <Text>No cliboard available</Text>
              )
            }
          </Paper>
        )}
        <FileSelect
          handleSubmit={handleSubmit}
          submitted={submitted}
          files={files}
          setFiles={setFiles}
        />
      </Stack>
    </Container>
  );
}
