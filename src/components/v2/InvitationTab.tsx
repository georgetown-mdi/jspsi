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
  Textarea,
} from '@mantine/core';
import { IconBrandSamsungpass, IconClockShield, IconCloudLock, IconUsers } from '@tabler/icons-react';
import { useState } from "react";

import { useForm } from '@tanstack/react-form';

type Credential = 'token' | 'passcode' | 'none';
type Channel = 'peer-to-peer' | 'server';

export function InvitationTab() {
  const form = useForm();
  const [credential, setCredential] = useState<Credential>('token');
  const [channel, setChannel] = useState<Channel>('peer-to-peer');

  return (
    <Paper>
      <Text size='md'>Invite someone to join you in a data exchange</Text>
      <form>
        <Stack>
          <form.Field
            name='initiatedName'
            children={() => (
              <TextInput
                withAsterisk
                required
                label='Your name'
                description='So that your partner can identify you'
                placeholder='Your name'
                />
            )}
            />
          <form.Field
            name='invitedName'
            children={() => (
              <TextInput
                withAsterisk
                required
                label="Partner's name"
                description='So that your partner knows they received the right invitation'
                placeholder="Partner's name"
                />
            )}
            />
          <form.Field
            name='description'
            children={() => (
              <Textarea
                label='Description'
                description='Describe the purposes of the data exchange'
                placeholder='Description'
                autosize
                minRows={2}
                />
            )}
            />
          <Fieldset legend='Credentialing'>
            <Text size='sm' mb={3}>
              How you will ensure the right person joins
            </Text>
            <SegmentedControl
              value={credential}
              onChange={value => setCredential(value as Credential)}
              mb="xs"
              data={[
                {
                  label: (
                    <Center style={{ gap: 10 }}>
                      <IconClockShield size={14}/>
                      Single use token
                    </Center>
                  ),
                  value: 'token'
                },
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
                  description='Something you and your invitee will know'
                />
              )}
              />)
              : (
                credential === 'token'
                ? (<Text size="xs" c="dimmed">A code will be generated that you can use</Text>)
                : (<Text size="xs" c="dimmed">Share login information with the person you invite; use no other credentials</Text>)
              )
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
              : (<Text size="xs" c="dimmed">Enter connection information on the next page</Text>)
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
            Create invitation
          </Button>
        </Stack>
      </form>
    </Paper>
  )
}