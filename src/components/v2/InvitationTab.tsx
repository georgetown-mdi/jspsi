import {
  ActionIcon,
  Alert,
  Button,
  Center,
  Fieldset,
  Group,
  NativeSelect,
  Paper,
  PasswordInput,
  Radio,
  SegmentedControl,
  Select,
  Stack,
  Text,
  TextInput,
  Textarea,
} from '@mantine/core';
import { IconBrandSamsungpass, IconClockShield, IconCloudLock, IconRepeat, IconUsers } from '@tabler/icons-react';
import { useState } from "react";

import { useForm } from '@tanstack/react-form';

import { v4 as uuidv4 } from 'uuid';

type Credential = 'passcode' | 'none';
type Channel = 'peer-to-peer' | 'server';
type PasscodeType = 'token' | 'password';

export function InvitationTab() {
  const form = useForm();
  const [credential, setCredential] = useState<Credential>('passcode');
  const [channel, setChannel] = useState<Channel>('peer-to-peer');
  const [passcodeType, setPassCodeType] = useState<PasscodeType>('token');

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
          <Group justify="center" grow preventGrowOverflow={false}>
          <Fieldset legend='Connection' style={{alignSelf: 'flex-start'}}>
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
          </Fieldset>
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
                  value: 'none',
                  disabled: channel === 'peer-to-peer'
                },
              ]}
            />
            {
              credential === 'passcode'
              ? (
                <form.Field
                  name='secret'
                  children={() => (
                    <Group grow preventGrowOverflow={false}>
                      <NativeSelect
                        name="passcodeType"
                        label="Passcode type"
                        value={passcodeType}
                        onChange={event => setPassCodeType(event.currentTarget.value as PasscodeType)}
                        data={[
                          { label: 'Single-use token', value: 'token' },
                          { label: 'Password', value: 'password' }
                        ]}
                      />
                      {
                        passcodeType === 'password'
                        ? <PasswordInput style={{alignSelf: 'flex-end'}}
                            withAsterisk
                            required
                            description='Something you and your invitee will know'
                          />
                        : <Group gap='xs' component='span' style={{alignSelf: 'flex-end'}}>
                            <TextInput value={uuidv4()}/>
                            <ActionIcon variant='light'>
                              <IconRepeat size={14}/>
                            </ActionIcon>
                          </Group>
                      }
                    </Group>
                  )}
                />
              )
              : <Text size="xs" c="dimmed">
                  Share login information with the person you invite; use no other credentials
                </Text>
            }
          </Fieldset>
          </Group>
          {
            credential !== 'none' || channel !== 'peer-to-peer'
            || (
              <Alert variant='outline' color='red' mt="sm">
                Peer-to-peer connections cannot be used with no credentialing. Select another option.
              </Alert>
            )
          }
          <Button type="submit">
            Create invitation
          </Button>
        </Stack>
      </form>
    </Paper>
  )
}