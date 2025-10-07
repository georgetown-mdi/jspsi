import { createFileRoute } from '@tanstack/react-router';
import { json } from '@tanstack/react-start';
import { setResponseStatus } from '@tanstack/react-start/server';

import { useSessionManager } from '@utils/sessions';

const DEFAULT_SESSION_DURATION_MS = 1000 * 60 * 15;

export const Route = createFileRoute('/api/psi/create')({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const payload = await request.json();
        if (!('initiatedName' in payload) || !payload['initiatedName']
        ) {
          setResponseStatus(400);
          return new Response('missing name of person initiating PSI');
        }
        if (!('invitedName' in payload) || !payload['invitedName']) {
          setResponseStatus(400);
          return new Response('missing name of person invited to PSI');
        }
        let timeToLive: Date;
        if (!('valid_duration_minutes' in payload)
            || typeof(payload['valid_duration_minutes']) !== "number"
            || payload['valid_duration_minutes'] <= 0
          ) {
          timeToLive = new Date(Date.now() + DEFAULT_SESSION_DURATION_MS);
        } else {
          timeToLive = new Date(
            Date.now() + 1000 * 60 * payload['valid_duration_minutes']
          );
        }

        const sessionManager = await useSessionManager();

        const session = sessionManager.set(
          {
            initiatedName: payload['initiatedName'] as string,
            invitedName: payload['invitedName'] as string,
            description:
              'description' in payload && payload['description']
                ? (payload['description'] as string)
                : '',
            timeToLive: timeToLive,
          }
        );
        
        console.log(`POST /api/psi/create: session ${session.uuid} created`);

        return json({uuid: session.uuid, timeToLive: timeToLive});
      },
    }
  }
});
