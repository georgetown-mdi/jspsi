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
  Transition
} from '@mantine/core';

import { IconDownload } from '@tabler/icons-react';
import { Link } from '@tanstack/react-router';

import { ProcessState } from 'psi-link';

import type { PaperProps } from '@mantine/core';

import type { LinkSession } from '@utils/sessions';

export interface StatusProps<T extends Array<{ id: string, label: string, state: ProcessState }>> extends PaperProps {
  session: LinkSession;
  stageId: T[number]['id']
  resultsFileURL: string | undefined
}

type ProtocolStageInfo = [
  label: string,
  state: ProcessState,
  progressBarIndex: number
]

export function StatusFactory
<T extends Array<{ id: string, label: string, state: ProcessState }>>
(stages: T) {
  let numProgressBarStages = 0;
  const stageMap = Object.fromEntries(stages.map(({id, label, state}) => {
    let progressBarIndex = -1;
    if (state === ProcessState.Working || state === ProcessState.Done)
    {
      progressBarIndex = numProgressBarStages;
      numProgressBarStages += 1;
    }
    return [id, [label, state, progressBarIndex] as ProtocolStageInfo]
  }))

  return (
    function Status(props: StatusProps<T>) {
      const { session, stageId, resultsFileURL, ...paperProps } = props;
      const [ stageDescription, state, progressBarIndex ] = stageMap[stageId];

      const showSpiner = state === ProcessState.Waiting;
      const showProgressBar = (
        state === ProcessState.Working || state === ProcessState.Done
      );
      const isCompleted = state === ProcessState.Done

      return (
        <Paper {...paperProps} >
          <Title order={2}>Status</Title>
          <Transition mounted={true} transition="fade" duration={200} timingFunction="ease">
            {(styles) => (
              <div style={styles}>
                <Text ta="center" size="lg" fw={500}>
                  {stageDescription}
                </Text>
              </div>
            )}
          </Transition>

          { showSpiner &&  
            (
              <Center mt="md">
                <Loader size="sm" />
              </Center>
            )
          }
          
          { showProgressBar && (
            <Stack
              align='stretch'
              justify='center'
              gap='md'
            >
              <Progress
                mt="md"
                value={(progressBarIndex / (numProgressBarStages - 1)) * 100}
                radius="xl"
                striped
                animated={!isCompleted}
              />

              <Group
                justify='center'
                gap='xs'
                component='span'
              >
                <Text>
                  Download result:
                </Text>
                <Link to={resultsFileURL} download='results.txt' disabled={!isCompleted}>
                  <ActionIcon onClick={() => {}} variant="light" color="blue" disabled={!isCompleted}>
                    <IconDownload size={18} />
                  </ActionIcon>
                </Link>
              </Group>
            </Stack>
          ) }
        </Paper>
      );
    }
  )
}
