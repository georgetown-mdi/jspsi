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

import FileSelect from "@components/FileSelect";
import SessionDetails from "@components/SessionDetails";
import { Status } from "@components/Status";

import { DataConnectionAdapter } from "@psi/dataConnectionAdapter";
import { waitForConnectionOpen } from "@psi/waitForOpen";

import type { PSILibrary } from "@openmined/psi.js/implementation/psi.d.ts";

import type { ExchangeResult, PreparedExchange } from "@psilink/core";
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
  const [errorMessage, setErrorMessage] = useState<string>();

  const handleSubmit = () => {
    setSubmitted(true);
    setErrorMessage(undefined);

    const handleFailure = (error: unknown) => {
      console.error(error);
      setErrorMessage(error instanceof Error ? error.message : String(error));
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

    if (role === "server") {
      setStageById("waiting for peer");
      waitForPeerId(session.uuid)
        .then(async (peerId) => {
          const [psi, csvResult, [peer, conn]] = await Promise.all([
            PSI() as Promise<PSILibrary>,
            loadCSVFile(files[0]),
            openPeerConnection(peerId),
          ]);
          const adapter = new DataConnectionAdapter(conn);
          adapter.once("data", () => peer.disconnect());

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

          try {
            const exchangeResult = await runExchange(
              adapter,
              "responder",
              prepared,
              {
                psiLibrary: psi,
                onStage: setStageById,
              },
            );
            finishExchange(exchangeResult, prepared);
          } catch (error) {
            peer.disconnect();
            handleFailure(error);
          } finally {
            adapter.close();
          }
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

          peer.on("connection", (conn) => {
            waitForConnectionOpen(conn)
              .then(async () => {
                const adapter = new DataConnectionAdapter(conn);
                adapter.once("data", () => peer.disconnect());
                try {
                  const exchangeResult = await runExchange(
                    adapter,
                    "initiator",
                    prepared,
                    { psiLibrary: psi, onStage: setStageById },
                  );
                  finishExchange(exchangeResult, prepared);
                } catch (error) {
                  peer.disconnect();
                  handleFailure(error);
                } finally {
                  adapter.close();
                }
              })
              .catch((error) => {
                peer.disconnect();
                handleFailure(error);
              });
          });
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
        {errorMessage && (
          <Alert color="red" title="Exchange failed">
            {errorMessage}
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
