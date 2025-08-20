import { createServerFileRoute, setResponseStatus } from '@tanstack/react-start/server';

import { json } from '@tanstack/react-start';

import { useSessionManager } from '@utils/sessions';

export const ServerRoute = createServerFileRoute('/api/psi/$uuid/').methods({
  GET: async ({ params }) => {
    if (!('uuid' in params)) {
      setResponseStatus(400, 'missing session uuid');
      return 'missing session uuid';
    }
    const sessionManager = await useSessionManager();

    const sessionId = {uuid: params['uuid']};
    if (!sessionManager.has(sessionId)) {
      setResponseStatus(400, `session id: ${sessionId.uuid} does not exist or has expired`);
      return `session id: ${sessionId.uuid} does not exist or has expired`;
    }
    const session = sessionManager.get(sessionId);
    if (Date.now() > session.timeToLive.getTime()) {
      sessionManager.remove(sessionId);
      setResponseStatus(400, `session id: ${sessionId.uuid} does not exist or has expired`);
      return `session id: ${sessionId.uuid} does not exist or has expired`;
    }
    console.log(`GET /api/psi/${sessionId.uuid}`);
    
    return json(session);
  },
  POST: async ({ request, params }) => {
    if (!('uuid' in params)) {
      setResponseStatus(400, 'missing session uuid');
      return 'missing session uuid';
    }
    const sessionId = {uuid: params['uuid']};

    const sessionManager = await useSessionManager();

    if (!sessionManager.has(sessionId)) {
      setResponseStatus(400, `session id: ${sessionId.uuid} does not exist or has expired`);
      return `ssession id: ${sessionId.uuid} does not exist or has expired`;
    }
    const session = sessionManager.get(sessionId);
    if (Date.now() > session.timeToLive.getTime()) {
      sessionManager.remove(sessionId);
      setResponseStatus(400, `session id: ${sessionId.uuid} does not exist or has expired`);
      return `session id: ${sessionId.uuid} does not exist or has expired`;
    }
    
    console.log(`POST /api/psi/${sessionId.uuid}: set peer id`);

    const requestJson = await request.json();

    if (!('invitedPeerId' in requestJson) || requestJson['invitedPeerId'] === undefined) {
      setResponseStatus(400, `missing id of peer session for session ${sessionId.uuid}`);
      return `missing id of peer session for session ${sessionId.uuid}`;
    }
    const invitedPeerId = requestJson['invitedPeerId'] as string;

    session['invitedPeerId'] = invitedPeerId;

    setResponseStatus(204);
    return new Response();
  }
});
