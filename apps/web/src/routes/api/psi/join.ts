import { setResponseHeader, setResponseStatus } from '@tanstack/react-start/server';
import { createFileRoute } from '@tanstack/react-router';
import { json } from '@tanstack/react-start';

import { useSessionManager } from '@utils/sessions';

const DEFAULT_SESSION_DURATION_MS = 1000 * 60 * 5;

export const Route = createFileRoute('/api/psi/join')({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const payload = await request.json();
        if (!('password' in payload) || !payload['password']) {
          setResponseStatus(400);
          return new Response('missing password');
        }
        if (!('peerId' in payload) || !payload['peerId']) {
          setResponseStatus(400);
          return new Response('missing peerId');
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
        const hashedPassword = sessionManager.hash(payload['password']);
        const sessionId = {hashedPassword};

        if (sessionManager.has(sessionId)) {
          const session = sessionManager.get(sessionId);

          if (Date.now() > session.timeToLive.getTime()) {
            // this should have expired
            // TODO: clear the timeout on the hashed password
            
            setResponseStatus(503, 'session may have expired; try again later');
            setResponseHeader('Retry-After', '1');
            return new Response('session may have expired; try again later');
          }
          sessionManager.remove(sessionId);
          return json({partnerPeerId: session.partnerPeerId});
        }

        sessionManager.set({
          hashedPassword,
          partnerPeerId: payload['peerId'],
          timeToLive
        });

        setResponseStatus(204);
        return new Response();
      }
    }
  }
});
