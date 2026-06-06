import log from "loglevel";

import { createFileRoute, useSearch } from "@tanstack/react-router";

import { useEffect, useRef, useState } from "react";

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
  errorMessage,
  loadCSVFile,
  prepareForExchange,
  serializeExchangeRecord,
  serializeOpeningData,
} from "@psilink/core";
import { openPeerConnection, waitForPeerId } from "@psi/server";
import { createAndSharePeerId } from "@psi/client";
import { runExchangeLifecycle } from "@psi/exchangeLifecycle";
import { waitForIncomingConnection } from "@psi/waitForConnection";

import FileSelect from "@components/FileSelect";
import SessionDetails from "@components/SessionDetails";
import { Status } from "@components/Status";

import type { PSILibrary } from "@openmined/psi.js/implementation/psi.d.ts";

import type {
  Acquire,
  ExchangeOutputs,
  StageDefinition,
} from "@psi/exchangeLifecycle";
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

function preStagesFor(role: "server" | "client"): Array<StageDefinition> {
  return role === "server" ? serverPreStages : clientPreStages;
}

function buildInitialStages(role: "server" | "client"): Array<StageDefinition> {
  return [
    ...preStagesFor(role),
    {
      id: CONFIRMING_PROTOCOL_STAGE_ID,
      label: "Confirming protocol",
      state: ProcessState.Working,
    },
    doneStage,
  ];
}

/** Full per-exchange stage tree, emitted once after load/prepare via `onStages`:
 * the role's pre-stages, the protocol stages derived from the prepared exchange,
 * and the terminal done stage. */
function buildStageList(
  role: "server" | "client",
  prepared: PreparedExchange,
): Array<StageDefinition> {
  return [
    ...preStagesFor(role),
    ...describeExchangeStages(prepared).map((stage) => ({
      ...stage,
      state: ProcessState.Working as const,
    })),
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
  const [outputs, setOutputs] = useState<ExchangeOutputs>();
  const [errorAlert, setErrorAlert] = useState<{
    title: string;
    message: string;
  }>();

  // Drives the lifecycle's AbortSignal. A useEffect cleanup aborts it on
  // unmount, so the owner tears down any in-flight wait or exchange and every
  // owner-driven seam stops firing (no setState after unmount).
  const abortRef = useRef<AbortController | undefined>(undefined);
  useEffect(() => () => abortRef.current?.abort(), []);

  const handleSubmit = () => {
    setSubmitted(true);
    setErrorAlert(undefined);

    const controller = new AbortController();
    abortRef.current = controller;

    // Pure output-generation half of the former finishExchange: build the local
    // results file plus the self-attested record and its private opening data,
    // returning a download URL for each. No React state and no previous-URL
    // revoke (a fresh session sets these at most once per component lifetime).
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
      return {
        resultsUrl: window.URL.createObjectURL(
          new Blob([csv], { type: "text/csv" }),
        ),
        recordUrl: jsonUrl(serializeExchangeRecord(result.record)),
        openingUrl: jsonUrl(serializeOpeningData(result.recordOpening)),
      };
    };

    // Server (PSI responder, PeerJS dialer): load/prepare, emit the stage tree,
    // then wait for the invited peer id over SSE and dial. The WASM library
    // stays pending - the responder must attach its inbound listener before it
    // resolves - so it is returned unresolved and awaited late inside the owner.
    const serverAcquire: Acquire = async ({ signal, onStage, onStages }) => {
      const psi = PSI() as Promise<PSILibrary>;
      const csvResult = await loadCSVFile(files[0]);
      const rawRows = csvResult.data as Array<Record<string, string>>;
      const prepared = prepareForExchange(
        {}, // no explicit spec; infer from input
        session.initiatedName,
        rawRows,
        csvResult.meta.fields ?? [],
      );
      onStages(buildStageList("server", prepared));

      onStage("waiting for peer");
      const peerId = await waitForPeerId(session.uuid, { signal });
      const [peer, conn] = await openPeerConnection(peerId);
      return { peer, conn, psi, prepared };
    };

    // Client (PSI initiator, PeerJS receiver): load/prepare, emit the stage
    // tree, await the WASM early (fail before publishing the peer id), publish
    // the id, then wait for the incoming connection. A wait failure destroys the
    // published peer so acquisition stays atomic.
    const clientAcquire: Acquire = async ({ signal, onStage, onStages }) => {
      const psi = PSI() as Promise<PSILibrary>;
      const csvResult = await loadCSVFile(files[0]);
      const rawRows = csvResult.data as Array<Record<string, string>>;
      const prepared = prepareForExchange(
        {}, // no explicit spec; infer from input
        session.invitedName,
        rawRows,
        csvResult.meta.fields ?? [],
      );
      onStages(buildStageList("client", prepared));

      await psi;
      const peer = await createAndSharePeerId(session);
      try {
        onStage("waiting for peer");
        const conn = await waitForIncomingConnection(peer, { signal });
        return { peer, conn, psi, prepared };
      } catch (error) {
        // The peer was published but no data channel ever opened, so destroy it
        // (freeing the broker id) before propagating - acquisition is atomic.
        peer.destroy();
        throw error;
      }
    };

    void runExchangeLifecycle({
      acquire: role === "server" ? serverAcquire : clientAcquire,
      exchangeRole: role === "server" ? "responder" : "initiator",
      signal: controller.signal,
      generateOutput,
      onStages: setStages,
      onStage: setStageById,
      onResult: (o) => {
        setOutputs(o);
        setStageById("done");
      },
      onError: ({ category, error }) => {
        console.error(error);
        if (category === "output") {
          // The exchange succeeded; only results-file generation failed. The
          // user must not be told to re-run a privacy-sensitive exchange.
          setErrorAlert({
            title: "Results unavailable",
            message:
              "The linkage completed, but generating the results file failed: " +
              errorMessage(error),
          });
        } else {
          setErrorAlert({
            title: "Exchange failed",
            message: errorMessage(error),
          });
        }
      },
    });
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
            resultsFileURL={outputs?.resultsUrl}
            recordFileURL={outputs?.recordUrl}
            openingFileURL={outputs?.openingUrl}
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
