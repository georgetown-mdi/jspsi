
import {
  Container,
  Paper,
  Stack,
  Tabs,
  Text,
  TextInput,
  Textarea,
  Title,
} from '@mantine/core';
import { createFileRoute } from '@tanstack/react-router';

import {  IconCalendarTime,  IconShare2, IconWorldCheck } from '@tabler/icons-react';

import { InvitationTab } from '@components/v2/InvitationTab';
import { JoinTab } from '@components/v2/JoinTab';
import { RendezvousTab } from '@components/v2/RendezvousTab';

export const Route = createFileRoute('/v2/')({
  component: Home
});



function Home() {
  return (
    <Container>
    <Tabs variant="pills" defaultValue="invite" activateTabWithKeyboard={false} mt="md">
      <Tabs.List grow justify='center'>
        <Tabs.Tab value="invite" leftSection={<IconShare2/>}>
          Create an invitation
        </Tabs.Tab>
        <Tabs.Tab value="join" leftSection={<IconWorldCheck/>}>
          Accept an invitation
        </Tabs.Tab>
        <Tabs.Tab value="rendezvous" leftSection={<IconCalendarTime/>}>
          Join a prearranged exchange
        </Tabs.Tab>
      </Tabs.List>
      <Tabs.Panel value="invite">
        <InvitationTab/>
      </Tabs.Panel>
      <Tabs.Panel value="join">
        <JoinTab/> 
      </Tabs.Panel>
      <Tabs.Panel value="rendezvous">
        <RendezvousTab/>
      </Tabs.Panel>
    </Tabs>
    </Container>
  );
}
