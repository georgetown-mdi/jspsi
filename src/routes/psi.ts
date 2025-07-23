import express from 'express';
import { v4 as uuidv4 } from 'uuid';
import { debug as debugConstructor } from 'debug';
const debug = debugConstructor('jspsi:psi');

import { sessions } from '../models/session';

const router = express.Router();

// how often the server should check to see if a client has accepted an
// invitation
const INVITED_PEER_ID_POLLING_FREQUENCY_MS = 250;

/* GET home page. */
router.get('/', function (_req, res) {
  res.render('index', { title: 'Private Set Intersection Online' });
});

router.get('/client', function (req, res) {
  if (!('sessionId' in req.query) || req.query['sessionId'] === undefined) {
    return res.status(400).send('Missing id of PSI session');
  }
  const sessionId = req.query['sessionId'] as string;
  if (!(sessionId in sessions)) {
    return res.status(400).send('Invalid session id: ' + sessionId);
  }
  const session = sessions[sessionId];

  if (
    !('initiatedName' in session)
    || !('invitedName' in session)
    || !('description' in session)
  ) {
    return res.status(500).send('Invalid session content');
  }

  debug(`client joining session ${sessionId}`);

  res.render('psi', {
    title: 'Private Set Intersection Session',
    isServer: false,
    sessionId: sessionId,
    initiatedName: session['initiatedName'],
    invitedName: session['invitedName'],
    description: session['description']
  });
});

router.post('/client/peerId', function (req, res) {
  if (!('sessionId' in req.body)) {
    return res.status(400).send('Missing id of PSI session');
  }
  const sessionId = req.body['sessionId'];
  if (!('invitedPeerId' in req.body)) {
    return res.status(400).send('Missing id of peer session');
  }
  const invitedPeerId = req.body['invitedPeerId'];

  if (!(sessionId in sessions)) {
    return res.status(400).send('Invalid session id');
  }
  const session = sessions[sessionId];

  if ('invitedPeerId' in sessions) {
    return res.status(500).send('Invited peer id already in session');
  }

  debug(
    `setting invited peer id to ${invitedPeerId} for ${sessionId} and sending status 200`
  );

  session['invitedPeerId'] = invitedPeerId;

  res.sendStatus(200);
});





router.get('/server', function (req, res) {
  if (
    !('initiatedName' in req.query)
    || req.query['initiatedName'] === undefined
  ) {
    return res.status(400).send('Missing name of person initiating PSI');
  }
  if (!('invitedName' in req.query) || req.query['invitedName'] === undefined) {
    return res.status(400).send('Missing name of person invited to PSI');
  }
  const sessionId = uuidv4();

  sessions[sessionId] = {
    sessionName: `${req.query['initiatedName']} and ${req.query['invitedName']}'s PSI Quick Session`,
    initiatedName: req.query['initiatedName'] as string,
    invitedName: req.query['invitedName'] as string,
    description:
      'description' in req.query && req.query['description'] !== undefined
        ? (req.query['description'] as string)
        : ''
  };
  const session = sessions[sessionId];

  debug(`new psi session ${sessionId} created`);

  res.render('psi', {
    title: 'Private Set Intersection Session',
    link: `${req.protocol}://${req.hostname}:${req.socket.localPort}/client?sessionId=${sessionId}`,
    isServer: true,
    sessionId: sessionId,
    initiatedName: session['initiatedName'],
    invitedName: session['invitedName'],
    description: session['description']
  });
});







router.get('/server/peerId', function (req, res) {
  if (!('sessionId' in req.query) || req.query['sessionId'] === undefined) {
    return res.status(400).send('Missing id of PSI session');
  }
  const sessionId = req.query['sessionId'] as string;
  if (!(sessionId in sessions)) {
    return res.status(400).send('Invalid session id');
  }
  const session = sessions[sessionId];

  // see https://developer.mozilla.org/en-US/docs/Web/API/Server-sent_events/Using_server-sent_events
  // headers from https://stackoverflow.com/a/59041709
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  function getInvitedPeerId() {
    if ('invitedPeerId' in session) {
      const payload = {
        invitedPeerId: session['invitedPeerId']
      };
      debug(
        `sending SSE peer id ${session['invitedPeerId']} for session ${sessionId}`
      );

      res.write(`data: ${JSON.stringify(payload)}\n\n`);
      res.end();
      return;
    }
    setTimeout(getInvitedPeerId, INVITED_PEER_ID_POLLING_FREQUENCY_MS);
  }

  debug(
    `established SSE connection for session ${sessionId} and waiting until invited peer id is available`
  );

  setTimeout(getInvitedPeerId, INVITED_PEER_ID_POLLING_FREQUENCY_MS);

  res.on('close', () => {
    res.end();
  });
});

//can include stuff about advanced psi protocol later
router.post('/api/session', function (req, res) {
  const { sessionName, initiatedName, invitedName, description} = req.body;

  // Validate input
  let finalSessionName = sessionName;

  if (!sessionName) {
    finalSessionName = `${initiatedName} and ${invitedName}'s PSI Quick Session`;
  }
  if (!initiatedName) {
    return res
      .status(400)
      .json({ error: 'Missing name of person initiating PSI' });
  }
  if (!invitedName) {
    return res
      .status(400)
      .json({ error: 'Missing name of person invited to PSI' });
  }

  const sessionId = uuidv4();

  sessions[sessionId] = {
    sessionName: finalSessionName,
    initiatedName,
    invitedName,
    description: description || ''
  };

  const link = `${req.protocol}://${req.get('host')}/client?sessionId=${sessionId}`;
  debug(`new psi session ${sessionId} created`);

  // Respond with JSON containing the session info
  res.json({
    sessionId,
    sessionName: finalSessionName,
    initiatedName,
    invitedName,
    description: description || '',
    link
  });
});

router.get('/api/session/:id', (req, res) => {
  const session = sessions[req.params.id];
  if (!session) {
    return res.status(404).json({ error: 'Session not found' });
  }
  res.json(session);
});

router.get('/api/test', (req, res) => {
  res.json({ message: 'API is working!' });
});

export default router;
