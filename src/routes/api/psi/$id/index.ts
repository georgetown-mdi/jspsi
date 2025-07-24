import { createServerFileRoute, setResponseStatus } from '@tanstack/react-start/server';

import { json } from '@tanstack/react-start';

import { sessions } from '../../../../utils/sessions';

export const ServerRoute = createServerFileRoute('/api/psi/$id/').methods({
  GET: ({ request, params }) => {
    if (!('id' in params) || params['id'] === undefined) {
      setResponseStatus(400, 'missing session id');
      return 'missing session id';
    }
    const sessionId = params['id'] as string;
    if (!(sessionId in sessions)) {
      setResponseStatus(400, `invalid session id: ${sessionId}`);
      return `invalid session id: ${sessionId}`;
    }
    const session = sessions[sessionId];
    if (Date.now() > session.timeToLive.getTime()) {
      setResponseStatus(400, `session ${sessionId} has expired`);
      return `session ${sessionId} has expired`;
    }
    console.log(`getting psi session ${sessionId}`);
    
    return json(session);
  },
  POST: async ({ request, params }) => {
    if (!('id' in params) || params['id'] === undefined) {
      setResponseStatus(400, 'missing session id');
      return 'missing session id';
    }
    const sessionId = params['id'] as string;
    if (!(sessionId in sessions)) {
      setResponseStatus(400, `invalid session id: ${sessionId}`);
      return `invalid session id: ${sessionId}`;
    }
    const session = sessions[sessionId];
    if (Date.now() > session.timeToLive.getTime()) {
      setResponseStatus(400, `session ${sessionId} has expired`);
      return `session ${sessionId} has expired`;
    }
    console.log(`setting peer id for session ${sessionId}`);

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
