import { useMemo } from "react";

import {
  ActionIcon,
  Center,
  Group,
  Loader,
  Paper,
  Progress,
  Stack,
  Text,
  Title,
  Transition,
} from "@mantine/core";

import { IconDownload } from "@tabler/icons-react";

import { ProcessState } from "@psilink/core";

import type { PaperProps } from "@mantine/core";

export interface StatusProps extends PaperProps {
  stages: Array<{ id: string; label: string; state: ProcessState }>;
  stageId: string;
  resultsFileURL: string | undefined;
  /** Self-attested audit record (JSON); safe to retain or share. */
  recordFileURL?: string | undefined;
  /** Private opening data (JSON); as sensitive as the matched data. */
  openingFileURL?: string | undefined;
}

type ProtocolStageInfo = [
  label: string,
  state: ProcessState,
  progressBarIndex: number,
];

export function Status(props: StatusProps) {
  const {
    stages,
    stageId,
    resultsFileURL,
    recordFileURL,
    openingFileURL,
    ...paperProps
  } = props;

  const { stageMap, numProgressBarStages } = useMemo(() => {
    let count = 0;
    const map: Partial<Record<string, ProtocolStageInfo>> = Object.fromEntries(
      stages.map(({ id, label, state }) => {
        let progressBarIndex = -1;
        if (state === ProcessState.Working || state === ProcessState.Done) {
          progressBarIndex = count;
          count += 1;
        }
        return [id, [label, state, progressBarIndex] as ProtocolStageInfo];
      }),
    );
    return { stageMap: map, numProgressBarStages: count };
  }, [stages]);

  const info = stageMap[stageId];
  if (!info) {
    if (import.meta.env.DEV)
      console.warn(`Status: unknown stageId "${stageId}"`);
    return (
      <Paper {...paperProps}>
        <Title order={2}>Status</Title>
        <Center mt="md">
          <Loader size="sm" />
        </Center>
      </Paper>
    );
  }
  const [stageDescription, state, progressBarIndex] = info;

  const showSpinner = state === ProcessState.Waiting;
  const showProgressBar =
    state === ProcessState.Working || state === ProcessState.Done;
  const isCompleted = state === ProcessState.Done;

  return (
    <Paper {...paperProps}>
      <Title order={2}>Status</Title>
      <Transition
        mounted={true}
        transition="fade"
        duration={200}
        timingFunction="ease"
      >
        {(styles) => (
          <div style={styles}>
            <Text ta="center" size="lg" fw={500}>
              {stageDescription}
            </Text>
          </div>
        )}
      </Transition>

      {showSpinner && (
        <Center mt="md">
          <Loader size="sm" />
        </Center>
      )}

      {showProgressBar && (
        <Stack align="stretch" justify="center" gap="md">
          <Progress
            mt="md"
            value={
              numProgressBarStages <= 1
                ? 100
                : (progressBarIndex / (numProgressBarStages - 1)) * 100
            }
            radius="xl"
            striped
            animated={!isCompleted}
          />

          <Group justify="center" gap="xs" component="span">
            <Text>Download result:</Text>
            <a href={resultsFileURL} download="results.csv">
              <ActionIcon variant="light" color="blue" disabled={!isCompleted}>
                <IconDownload size={18} />
              </ActionIcon>
            </a>
          </Group>

          {recordFileURL !== undefined && (
            <Group justify="center" gap="xs" component="span">
              <Text>Download audit record:</Text>
              <a href={recordFileURL} download="psilink-record.json">
                <ActionIcon
                  variant="light"
                  color="blue"
                  disabled={!isCompleted}
                >
                  <IconDownload size={18} />
                </ActionIcon>
              </a>
            </Group>
          )}

          {openingFileURL !== undefined && (
            <Group justify="center" gap="xs" component="span">
              <Text>Download opening data (keep private):</Text>
              <a href={openingFileURL} download="psilink-record.opening.json">
                <ActionIcon
                  variant="light"
                  color="blue"
                  disabled={!isCompleted}
                >
                  <IconDownload size={18} />
                </ActionIcon>
              </a>
            </Group>
          )}
        </Stack>
      )}
    </Paper>
  );
}
