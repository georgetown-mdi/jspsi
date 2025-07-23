import { useState, useEffect } from 'react';
import { Button, Text, Center, Loader, Transition, Paper, PaperProps, Progress } from '@mantine/core';

import type { Session } from '../utils/sessions';

export interface StatusIndicatorProps extends PaperProps {
  session: Session
  stageName: string
}

export type ProtocolStage = [
  name: string,
  description: string
]

type ProtocolStageInfo = [
  description: string,
  index: number
]

export function StatusIndicatorFactory(stages: ProtocolStage[]) {
  const stageMap = Object.fromEntries(stages.map((value, index) => {
    return [ value[0], [ value[1], index ] as ProtocolStageInfo ]
  }))
  const numStages = stages.length;

  return (
    function StatusIndicator(props: StatusIndicatorProps) {
      const { session, stageName, ...paperProps } = props;
      const [ stageDescription, stageIndex ] = stageMap[stageName];

      console.log('starting with stage ' + stageName + ', index is: ' + stageIndex);

      const started = stageIndex > 0;
      const visible = started;

      return (
        <Paper {...paperProps} >
          <Transition mounted={true} transition="fade" duration={200} timingFunction="ease">
            {(styles) => (
              <div style={styles}>
                <Text ta="center" size="lg" fw={500}>
                  {stageDescription}
                </Text>
              </div>
            )}
          </Transition>

          { visible &&  
            (
              <Center mt="md">
                <Loader size="sm" />
              </Center>
            )
          }
          
          { visible && (
          <Progress
            mt="md"
            value={(stageIndex / (numStages - 1)) * 100}
            radius="xl"
            striped
            animated
          /> ) }
        </Paper>
      );
    }
  )
}

/* export default function StatusIndicator(props: StatusIndicatorProps) {
  const { session, status, ...paperProps } = props;

  const started = status != 'stopped';
  const visible = started;
  let stage = 0;

  return (
    <Paper {...paperProps} >
      <Transition mounted={visible} transition="fade" duration={200} timingFunction="ease">
        {(styles) => (
          <div style={styles}>
            <Text ta="center" size="lg" fw={500}>
              {statusInfos[status]['description']}
            </Text>
          </div>
        )}
      </Transition>

      { visible &&  
        (
          <Center mt="md">
            <Loader size="sm" />
          </Center>
        )
      }
      
      <Progress
        mt="md"
        value={((statusInfos[status]['stage'] + 1) / Object.keys(statusInfos).length) * 100}
        radius="xl"
        striped
        animated
      />
    </Paper>
  );
} */
