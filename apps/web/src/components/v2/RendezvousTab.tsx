import {
  Alert,
  Button,
  Center,
  Fieldset,
  Paper,
  PasswordInput,
  SegmentedControl,
  Stack,
  Text,
  TextInput,
} from '@mantine/core';
import { IconBrandSamsungpass, IconCloudLock, IconUsers } from '@tabler/icons-react';
import { useForm } from '@tanstack/react-form';
import { useState } from "react";

type Credential = 'passcode' | 'none';
type Channel = 'peer-to-peer' | 'server';


export function RendezvousTab() {
  const form = useForm();
  const [credential, setCredential] = useState<Credential>('passcode');
  const [channel, setChannel] = useState<Channel>('peer-to-peer');

  return (
    <Paper>
      <Text size='md'>Join a recurring exchange without needing an invitation</Text>
      <form>
        <Stack>
          <Fieldset legend='Credentials'>
            <Text size='sm' mb={3}>
              How you will ensure you can trust the other partner
            </Text>
            <SegmentedControl
              value={credential}
              onChange={value => setCredential(value as Credential)}
              mb="xs"
              data={[
                {
                  label: (
                    <Center style={{ gap: 10 }}>
                      <IconBrandSamsungpass size={14}/>
                      Passcode
                    </Center>
                  ),
                  value: 'passcode'
                },
                {
                  label: (
                    <Center style={{ gap: 10 }}>
                      <IconCloudLock size={14}/>
                      Trusted server
                    </Center>
                  ),
                  value: 'none'
                },
              ]}
            />
            {
              credential === 'passcode'
              ? (<form.Field
              name='secret'
              children={() => (
                <PasswordInput
                  withAsterisk
                  required
                  description='Something you and your partner know'
                />
              )}
              />)
              : (<Text size="xs" c="dimmed">Enter connection information below</Text>)
            }
          </Fieldset>
          <Fieldset legend='Connection'>
            <Text size='sm' mb={3}>
              How you will you communicate
            </Text>
            <SegmentedControl
              value={channel}
              onChange={value => setChannel(value as Channel)}
              mb="xs"
              data={[
                {
                  label: (
                    <Center style={{ gap: 10 }}>
                      <IconUsers size={14}/>
                      Peer-to-peer
                    </Center>
                  ),
                  value: 'peer-to-peer',
                  disabled: credential === 'none'
                },
                {
                  label: (
                    <Center style={{ gap: 10 }}>
                      <IconCloudLock size={14}/>
                      Trusted server
                    </Center>
                  ),
                  value: 'trusted-server'
                }
              ]}
            />
            {
              channel === 'peer-to-peer'
              ? (<Text size="xs" c="dimmed">Your browser will handle the connection</Text>)
              : (<form.Field
                name='connectionInfo'
                children={() => (
                  <TextInput
                    withAsterisk
                    required
                    description='Connection url'
                  />
                )}
              />)
            }
            {
              credential !== 'none' || channel !== 'peer-to-peer'
              || (
                <Alert variant='outline' color='red' mt="sm">
                  Peer-to-peer connections cannot be used with no credentialing. Select another option.
                </Alert>
              )
            }
          </Fieldset>
          <Button type="submit">
            Join exchange
          </Button>
        </Stack>
      </form>
    </Paper>
  )
}