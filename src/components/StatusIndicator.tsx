import { useState, useEffect } from 'react';
import { Button, Text, Center, Loader, Transition, Paper, PaperProps, Progress } from '@mantine/core';

import type { Session } from '../utils/sessions';

interface StatusIndicatorProps extends PaperProps {
  session: Session;
}

const protocolStages = [
  'Initializing...',
  'Connecting to server...',
  'Authenticating...',
  'Fetching data...',
  'Processing...',
  'Finalizing...',
  'Complete!',
];

export default function StatusIndicator(props: StatusIndicatorProps) {
  const { session, ...paperProps } = props;

  const [started, setStarted] = useState(false);
  const [currentStage, setCurrentStage] = useState(0);
  const [visible, setVisible] = useState(true);

  useEffect(() => {
    let timer: NodeJS.Timeout;

    if (started && currentStage < protocolStages.length - 1) {
      timer = setTimeout(() => {
        setVisible(false);
        setTimeout(() => {
          setCurrentStage((prev) => prev + 1);
          setVisible(true);
        }, 200); // match transition duration
      }, 1500);
    }

    return () => clearTimeout(timer);
  }, [started, currentStage]);

  const handleStart = () => {
    setStarted(true);
    setCurrentStage(0);
  };

  return (
    <Paper {...paperProps} >
      {!started ? (
        <Button size="lg" onClick={handleStart}>
          Start
        </Button>
      ) : (
        <>
          <Transition mounted={visible} transition="fade" duration={200} timingFunction="ease">
            {(styles) => (
              <div style={styles}>
                <Text ta="center" size="lg" fw={500}>
                  {protocolStages[currentStage]}
                </Text>
              </div>
            )}
          </Transition>

          {currentStage < protocolStages.length - 1 ? (
            <>
              <Center mt="md">
                <Loader size="sm" />
              </Center>
              <Progress
                mt="md"
                value={((currentStage + 1) / protocolStages.length) * 100}
                radius="xl"
                striped
                animated
              />
            </>
          ) : (
            <Text mt="md" ta="center" c="green" fw={600}>
              Protocol Complete!
            </Text>
          )}
        </>
      )}
    </Paper>
  );
}
