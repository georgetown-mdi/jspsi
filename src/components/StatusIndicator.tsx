import { useState, useEffect } from 'react';
import { Button, Text, Center, Loader, Transition, Paper, PaperProps, Progress } from '@mantine/core';

import type { Session } from '../utils/sessions';

export type PSIStatus =
  | 'stopped'
  | 'waiting for peer';

type StatusInfo = [
  description: string,
  stage: number
]

const statusInfos = {
  'stopped': ['Stopped', 0] as StatusInfo,
  'waiting for peer': ['Waiting for peer', 1] as StatusInfo
};


interface StatusIndicatorProps extends PaperProps {
  session: Session;
  status: PSIStatus
}

export default function StatusIndicator(props: StatusIndicatorProps) {
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

      <Center mt="md">
        <Loader size="sm" />
      </Center>
      <Progress
        mt="md"
        value={((statusInfos[status]['stage'] + 1) / Object.keys(statusInfos).length) * 100}
        radius="xl"
        striped
        animated
      />
    </Paper>
  );
}
