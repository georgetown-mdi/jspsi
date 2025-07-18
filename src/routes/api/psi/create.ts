import { createServerFileRoute, setResponseStatus } from '@tanstack/react-start/server';
import { json } from '@tanstack/react-start';
import { sessions } from '../../../utils/sessions';
import { v4 as uuidv4 } from 'uuid';

const DEFAULT_SESSION_DURATION_MS = 1000 * 60 * 15;

export const ServerRoute = createServerFileRoute('/api/psi/create').methods({
  POST: async ({ request }) => {
    console.log('creating psi session');
    const payload = await request.json();
    if (!('initiatedName' in payload) || payload['initiatedName'] === undefined
    ) {
      setResponseStatus(400);
      return new Response('Missing name of person initiating PSI');
    }
    if (!('invitedName' in payload) || payload['invitedName'] === undefined) {
      setResponseStatus(400);
      return new Response('Missing name of person invited to PSI');
    }
    let timeToLive: Date;
    if (!('valid_duration_minutes' in payload) || typeof(payload['valid_duration_minutes']) !== "number") {
      timeToLive = new Date(Date.now() + DEFAULT_SESSION_DURATION_MS);
    } else {
      timeToLive = new Date(Date.now() + 1000 * 60 * payload['valid_duration_minutes']);
    }

    const id = uuidv4();
    
    sessions[id] = {
      initiatedName: payload['initiatedName'] as string,
      invitedName: payload['invitedName'] as string,
      description:
        'description' in payload && payload['description'] !== undefined
          ? (payload['description'] as string)
          : '',
      timeToLive: timeToLive
    };
    
    console.log(`new psi session ${id} created`);

    return json({id: id, timeToLive: timeToLive});
  },
})
