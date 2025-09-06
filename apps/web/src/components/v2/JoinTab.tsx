import {
  Button,
  Center,
  Paper,
  PasswordInput,
  SegmentedControl,
  Stack,
  Text,
  TextInput,
} from '@mantine/core';
import { IconBrandSamsungpass, IconClockShield } from '@tabler/icons-react';
import { useForm } from '@tanstack/react-form';
import { useState } from "react";

type Credential = 'token' | 'passcode';

export function JoinTab() {
  const form = useForm();
  const [credential, setCredential] = useState<Credential>('token');

  return (
    <Paper>
      <Text size='md'>Review an invitation and choose whether to accept it</Text>
      <form>
        <Stack>
          <Text size='sm' mb={3}>
            Enter the credentials given to you by the person who invited you
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
            ]}
          />
          {
            credential === 'passcode'
            ? (
              <form.Field
                name='secret'
                children={() => (
                  <PasswordInput
                    withAsterisk
                    required
                    description='Passcode you share'
                  />
                )}
              />)
            : (
              <form.Field
                name='token'
                children={() => (
                  <TextInput
                    withAsterisk
                    required
                    description='Code you were given'
                  />
                )}
              />
            )
          }
          <Button type="submit">
            See exchange details
          </Button>
        </Stack>
      </form>
    </Paper>
  )
}