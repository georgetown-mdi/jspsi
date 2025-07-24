import { createServerFileRoute, setResponseStatus } from '@tanstack/react-start/server';

import { json } from '@tanstack/react-start';

import { sessions } from '@utils/sessions';

export const ServerRoute = createServerFileRoute('/api/psi/$id/').methods({
  GET: ({ params }) => {
    if (!('id' in params)) {
      setResponseStatus(400, 'missing session id');
      return 'missing session id';
    }
    const sessionId = params['id'];
    if (!(sessionId in sessions)) {
      setResponseStatus(400, `invalid session id: ${sessionId}`);
      return `invalid session id: ${sessionId}`;
    }
    const session = sessions[sessionId];
    if (Date.now() > session.timeToLive.getTime()) {
      setResponseStatus(400, `session ${sessionId} has expired`);
      return `session ${sessionId} has expired`;
    }
    console.log(`GET /api/psi/${sessionId}`);
    
    return json(session);
  },
  POST: async ({ request, params }) => {
    if (!('id' in params)) {
      setResponseStatus(400, 'missing session id');
      return 'missing session id';
    }
    const sessionId = params['id'];
    if (!(sessionId in sessions)) {
      setResponseStatus(400, `invalid session id: ${sessionId}`);
      return `invalid session id: ${sessionId}`;
    }
    const session = sessions[sessionId];
    if (Date.now() > session.timeToLive.getTime()) {
      setResponseStatus(400, `session ${sessionId} has expired`);
      return `session ${sessionId} has expired`;
    }
    
    console.log(`POST /api/psi/${sessionId}: set peer id`);

    const requestJson = await request.json();

    if (!('invitedPeerId' in requestJson) || requestJson['invitedPeerId'] === undefined) {
      setResponseStatus(400, `missing id of peer session for session ${sessionId}`);
      return `missing id of peer session for session ${sessionId}`;
    }
    const invitedPeerId = requestJson['invitedPeerId'] as string;

    session['invitedPeerId'] = invitedPeerId;

    setResponseStatus(200);
    return new Response();
  }
});
