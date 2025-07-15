import { createServerFileRoute } from '@tanstack/react-start/server';
import { json } from '@tanstack/react-start';
import { sessions } from '../../utils/sessions';
import { setResponseStatus } from '@tanstack/react-start/server';
import { v4 as uuidv4 } from 'uuid';

export const ServerRoute = createServerFileRoute('/api/psi').methods({
  GET: async ({ request }) => {
    const query = new URL(request.url).searchParams
    if (!('initiatedName' in query) || query['initiatedName'] === undefined
    ) {
      setResponseStatus(400);
      return new Response('Missing name of person initiating PSI');
    }
    if (!('invitedName' in query) || query['invitedName'] === undefined) {
      setResponseStatus(400);
      return new Response('Missing name of person invited to PSI');
    }
    const sessionId = uuidv4();
    
    sessions[sessionId] = {
      initiatedName: query['initiatedName'] as string,
      invitedName: query['invitedName'] as string,
      description:
        'description' in query && query['description'] !== undefined
          ? (query['description'] as string)
          : ''
    };
    
    console.log(`new psi session ${sessionId} created`);

    return json({sessionId: sessionId});
  },
})
