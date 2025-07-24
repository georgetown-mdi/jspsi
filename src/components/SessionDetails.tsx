import { Paper, Title, Text, PaperProps } from '@mantine/core';

import type { Session } from '../utils/sessions'

interface SessionDetailProps extends PaperProps {
  session: Session;
}

export default function SessionDetails(props: SessionDetailProps) {
  const { session, ...paperProps } = props;

  return (
    <Paper {...paperProps}>
      <Title order={2}>Session Details</Title>
      <Title order={3}>Initiated By:</Title>
      <Text>{ session['initiatedName'] }</Text>
      <Title order={3}>Agency/Person Invited:</Title>
      <Text>{ session['invitedName'] }</Text>
      <Title order={3}>Description:</Title>
      <Text>{ session['description'] }</Text>
      <Title order={3}>Session ID</Title>
      <Text>{ session['id'] }</Text>
    </Paper>
  )
}