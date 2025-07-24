import {
  Center,
  Group,
  Loader,
  Stack,
  Text,
  Title,
  Transition,
  Paper,
  PaperProps,
  Progress,
  ActionIcon
} from '@mantine/core';

import type { Session } from '../utils/sessions';
import { IconDownload } from '@tabler/icons-react';
import { Link } from '@tanstack/react-router';

export interface StatusProps extends PaperProps {
  session: Session
  stageName: string
  resultsFileURL: string | undefined
}

export type ProtocolStage = [
  name: string,
  description: string,
  showSpinner: boolean,
  showProgressBar: boolean
]

type ProtocolStageInfo = [
  description: string,
  showSpinner: boolean,
  showProgressBar: boolean,
  index: number
]

export function StatusFactory(stages: ProtocolStage[]) {
  let numProgressBarStages = 0;
  const stageMap = Object.fromEntries(stages.map((value) => {
    const [ name, ...otherValues] = value;
    let index = -1;
    if (otherValues[2]) {
      index = numProgressBarStages;
      numProgressBarStages += 1;
    }
    return [ name, [ ...otherValues, index ] as ProtocolStageInfo ]
  }));

  return (
    function Status(props: StatusProps) {
      const { session, stageName, resultsFileURL, ...paperProps } = props;
      const [ stageDescription, showSpinner, showProgressBar, progressBarIndex ] = stageMap[stageName];
      const isDone = progressBarIndex === numProgressBarStages - 1;

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

          { showSpinner &&  
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
                animated={!isDone}
              />

              <Group
                justify='center'
                gap='xs'
                component='span'
              >
                <Text>
                  Download result:
                </Text>
                <Link to={resultsFileURL} download='results.txt' disabled={!isDone}>
                  <ActionIcon onClick={() => {}} variant="light" color="blue" disabled={!isDone}>
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
