import {
  createServerFileRoute,
  setResponseStatus
} from '@tanstack/react-start/server';

import { json } from '@tanstack/react-start';


import { sessions } from '../../../../utils/sessions';

export const ServerRoute = createServerFileRoute('/api/psi/$id/').methods({
  GET: async ({ request, params }) => {
    if (!('id' in params) || params['id'] === undefined) {
      setResponseStatus(400);
      return new Response('Missing id of PSI session');
    }
    const sessionId = params['id'] as string;
    if (!(sessionId in sessions)) {
      setResponseStatus(400);
      return new Response('Invalid session id');
    }
    const session = sessions[sessionId];
    if (Date.now() > session.timeToLive.getTime()) {
      setResponseStatus(400);
      return new Response('Expired session id');
    }
    console.log(`getting psi session ${sessionId}`);
    
    return json(session);
  }
});
