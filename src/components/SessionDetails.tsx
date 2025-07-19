import { Paper, Title, Text } from '@mantine/core';

import type { Session } from '../utils/sessions'

export function SessionDetails({session: session}: {session: Session}) {
  return (
    <Paper shadow="xs" p="xl">
        <Title order={1}>Session Details</Title>
        <Title order={2}>Initiated By:</Title>
        <Text>{ session['initiatedName'] }</Text>
        <Title order={2}>Agency/Person Invited:</Title>
        <Text>{ session['invitedName'] }</Text>
        <Title order={2}>Description:</Title>
        <Text>{ session['description'] }</Text>
        <Title order={2}>Session ID</Title>
        <Text>{ session['id'] }</Text>
    </Paper>
  )
}