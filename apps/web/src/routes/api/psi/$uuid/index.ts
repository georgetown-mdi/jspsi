import { createFileRoute } from '@tanstack/react-router';
import { setResponseStatus } from '@tanstack/react-start/server';

import { json } from '@tanstack/react-start';

import { useSessionManager } from '@utils/sessions';

export const Route = createFileRoute('/api/psi/$uuid/')({
  server: {
    handlers: {
      GET: async ({ params }) => {
        if (!('uuid' in params) || typeof params['uuid'] !== 'string') {
          setResponseStatus(400, 'missing session uuid');
          return new Response('missing session uuid');
        }
        const sessionManager = await useSessionManager();

        const sessionId = {uuid: params['uuid']};
        if (!sessionManager.has(sessionId)) {
          setResponseStatus(400, `session id: ${sessionId.uuid} does not exist or has expired`);
          return new Response(`session id: ${sessionId.uuid} does not exist or has expired`);
        }
        const session = sessionManager.get(sessionId);
        if (Date.now() > session.timeToLive.getTime()) {
          sessionManager.remove(sessionId);
          setResponseStatus(400, `session id: ${sessionId.uuid} does not exist or has expired`);
          return new Response(`session id: ${sessionId.uuid} does not exist or has expired`);
        }
        console.log(`GET /api/psi/${sessionId.uuid}`);
        
        return json(session);
      },
      POST: async ({ request, params }) => {
        if (!('uuid' in params) || typeof params['uuid'] !== 'string') {
          setResponseStatus(400, 'missing session uuid');
          return new Response('missing session uuid');
        }
        const sessionId = {uuid: params['uuid']};

        const sessionManager = await useSessionManager();

        if (!sessionManager.has(sessionId)) {
          setResponseStatus(400, `session id: ${sessionId.uuid} does not exist or has expired`);
          return new Response(`session id: ${sessionId.uuid} does not exist or has expired`);
        }
        const session = sessionManager.get(sessionId);
        if (Date.now() > session.timeToLive.getTime()) {
          sessionManager.remove(sessionId);
          setResponseStatus(400, `session id: ${sessionId.uuid} does not exist or has expired`);
          return new Response(`session id: ${sessionId.uuid} does not exist or has expired`);
        }
        
        console.log(`POST /api/psi/${sessionId.uuid}: set peer id`);

        const requestJson = await request.json();

        if (!('invitedPeerId' in requestJson) || requestJson['invitedPeerId'] === undefined) {
          setResponseStatus(400, `missing id of peer session for session ${sessionId.uuid}`);
          return new Response(`missing id of peer session for session ${sessionId.uuid}`);
        }
        const invitedPeerId = requestJson['invitedPeerId'] as string;

        session['invitedPeerId'] = invitedPeerId;

        setResponseStatus(204);
        return new Response();
      }
    }
  }
});
