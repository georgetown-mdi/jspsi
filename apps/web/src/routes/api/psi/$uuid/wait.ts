import log from 'loglevel';

import {
  createServerFileRoute,
  getEvent,
  setResponseStatus
} from '@tanstack/react-start/server';

import { createEventStream } from 'h3';

import { useSessionManager } from '@utils/sessions';

const INVITED_PEER_ID_POLLING_FREQUENCY_MS = 250;

export const ServerRoute = createServerFileRoute('/api/psi/$uuid/wait').methods((api) => ({
  GET: api.handler(async ({ params }) => {
    if (!('uuid' in params)) {
      setResponseStatus(400, 'missing session uuid');
      return 'missing session uuid';
    }
    const sessionId = {uuid: params['uuid']};

    const sessionManager = await useSessionManager();

    if (!sessionManager.has(sessionId)) {
      setResponseStatus(400, `session id: ${sessionId.uuid} does not exist or has expired`);
      return `session id: ${sessionId.uuid} does not exist or has expired`;
    }
    const session = sessionManager.get(sessionId);
    if (Date.now() > session.timeToLive.getTime()) {
      setResponseStatus(400, `session id: ${sessionId.uuid} does not exist or has expired`);
      return `session id: ${sessionId.uuid} does not exist or has expired`;
    }

    const event = getEvent();
    const eventStream = createEventStream(event);
    
    let clientWaiting = true;
    eventStream.onClosed(() => {
      clientWaiting = false;
      log.info(`GET /api/psi/${session.uuid}/wait: event stream closed`);
    });

    const getInvitedPeerId = async () => {
      while (Date.now() <= session.timeToLive.getTime()) {
        if (!clientWaiting) {
          log.info(`GET /api/psi/${session.uuid}/wait: stream has closed`)
          return;
        }

        if (!('invitedPeerId' in session)) {
          const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
          await delay(INVITED_PEER_ID_POLLING_FREQUENCY_MS);
          continue;
        }

        log.info(
          `GET /api/psi/${session.uuid}/wait: SSE pushing peer id ${session.invitedPeerId}`
        );

        await eventStream.push(JSON.stringify({invitedPeerId: session.invitedPeerId}));

        return await eventStream.close();
      }
      log.info(`GET /api/psi/${session.uuid}/wait: SSE session expired}`);
      await eventStream.push(JSON.stringify({error: `session ${session.uuid} timed-out waiting`}));

      return await eventStream.close();
    }

    log.info(`GET /api/psi/${session.uuid}/wait: sending event stream`);
    const sentEventStream = eventStream.send();

    await getInvitedPeerId();

    return sentEventStream.then(() => {
      log.info(`GET /api/psi/${session.uuid}/wait: sending 200`);
      return new Response();
    });
  })
}));
