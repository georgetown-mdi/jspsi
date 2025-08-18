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

import { ShowStatusElements } from './StatusStages';

import type { PaperProps } from '@mantine/core';

import type { LinkSession } from '@utils/sessions';
import type { ProtocolStage } from './StatusStages';


export interface StatusProps extends PaperProps {
  session: LinkSession
  stageName: string
  resultsFileURL: string | undefined
}

type ProtocolStageInfo = [
  description: string,
  showElements: ShowStatusElements,
  progressBarIndex: number
]

export function StatusFactory(stages: Array<ProtocolStage>) {
  let numProgressBarStages = 0;
  const stageMap = Object.fromEntries(stages.map((value) => {
    const [ name, ...otherValues] = value;
    let progressBarIndex = -1;
    if (otherValues[1] === ShowStatusElements.ProgressBar
      || otherValues[1] === ShowStatusElements.Completion)
    {
      progressBarIndex = numProgressBarStages;
      numProgressBarStages += 1;
    }
    return [ name, [ ...otherValues, progressBarIndex ] as ProtocolStageInfo ]
  }));

  return (
    function Status(props: StatusProps) {
      const { session, stageName, resultsFileURL, ...paperProps } = props;
      const [ stageDescription, showElements, progressBarIndex ] = stageMap[stageName];

      const showSpiner = showElements === ShowStatusElements.Spinner;
      const showProgressBar = (
        showElements === ShowStatusElements.ProgressBar
        || showElements === ShowStatusElements.Completion
      );
      const isCompleted = showElements == ShowStatusElements.Completion

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
