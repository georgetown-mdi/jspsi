import log from 'loglevel';

import { createFileRoute } from '@tanstack/react-router';

import {
  setResponseStatus
} from '@tanstack/react-start/server';

import { createSSEStream } from '@utils/sse';

import { useSessionManager } from '@utils/sessions';

const INVITED_PEER_ID_POLLING_FREQUENCY_MS = 250;

export const Route = createFileRoute('/api/psi/$uuid/wait')({
  server: {
    handlers: {
      GET: async ({params}) => {
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
          setResponseStatus(400, `session id: ${sessionId.uuid} does not exist or has expired`);
          return new Response(`session id: ${sessionId.uuid} does not exist or has expired`);
        }

        const eventStream = createSSEStream();
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

            eventStream.push(JSON.stringify({invitedPeerId: session.invitedPeerId}));

            return eventStream.close();
          }
          log.info(`GET /api/psi/${session.uuid}/wait: SSE session expired}`);
          eventStream.push(JSON.stringify({error: `session ${session.uuid} timed-out waiting`}));

          return eventStream.close();
        }

        log.info(`GET /api/psi/${session.uuid}/wait: sending event stream`);
        const response = eventStream.send();

        getInvitedPeerId();

        return response;
      }
    }
  }
});
