const { v4: uuidv4 } = require('uuid');

var express = require('express');
var router = module.exports = express.Router();

// how often the server should check to see if a client has accepted an
// invitation
const INVITED_PEER_ID_POLLING_FREQUENCY_MS = 250

var sessions = {};

/* GET home page. */
router.get('/', function(req, res, next) {
  res.render('index', { title: 'Private Set Intersection Online' });
});

router.post('/client_peer_id', function(req, res) {
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
  var session = sessions[sessionId];
  
  if ('invitedPeerId' in sessions) {
    return res.status(500).send('Invited peer id already in session');
  }

  console.log(`setting invited peer id to ${invitedPeerId} for ${sessionId} and sending status 200`);

  session['invitedPeerId'] = invitedPeerId;

  res.sendStatus(200);
});

router.get('/client', function(req, res) {
  if (!('sessionId' in req.query)) {
    return res.status(400).send('Missing id of PSI session');
  }
  const sessionId = req.query['sessionId'];

  res.render('client', {
    title: 'PSI as Client',
    sessionId: sessionId,
  });
})

router.get('/server_sse', function(req, res) {
  if (!('sessionId' in req.query)) {
    return res.status(400).send("Missing id of PSI session");
  }
  const sessionId = req.query['sessionId'];
  if (!(sessionId in sessions)) {
    return res.status(400).send("Invalid session id");
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
      payload = {
        invitedPeerId: session['invitedPeerId']
      };
      console.log('sending peer id')
      res.write(`data: ${JSON.stringify(payload)}\n\n`);
      res.end();
      return;
    } 
    setTimeout(getInvitedPeerId, INVITED_PEER_ID_POLLING_FREQUENCY_MS);
  }

  console.log(`established SSE connection for session ${sessionId} and waiting until invited peer id is available`)

  setTimeout(getInvitedPeerId, INVITED_PEER_ID_POLLING_FREQUENCY_MS)

  res.on('close', () => {
    console.log('client disconnected from SSE stream');
    res.end();
  });
});

router.get("/join", function(req, res) {
  if (!('sessionId' in req.query)) {
    return res.status(400).send("Missing id of PSI session");
  }
  const sessionId = req.query['sessionId'];
  if (!(sessionId in sessions)) {
    return res.status(400).send('Invalid session id: ' + sessionId);
  }
  const session = sessions[sessionId];

  if (!('initiatedName' in session) || !('invitedName' in session) || !('description' in session)) {
    return res.status(500).send('Invalid session content');
  }

  res.render('join', {
    title: 'Join PSI',
    sessionId: sessionId,
    initiatedName: session['initiatedName'],
    invitedName: session['invitedName'],
    description: session['description']
  });
});

router.get('/new', function(req, res) {
  if (!('initiatedName' in req.query)) {
    return res.status(400).send("Missing name of person initiating PSI");
  }
  if (!('invitedName' in req.query)) {
    return res.status(400).send("Missing name of person invited to PSI");
  }
  const sessionId = uuidv4();

  sessions[sessionId] = {
    initiatedName: req.query['initiatedName'],
    invitedName: req.query['invitedName'],
    description: 'description' in req.query ? req.query['description'] : null
  };

  res.render('server', {
    title: 'New PSI',
    link: `${req.protocol}://${req.hostname}:${req.socket.localPort}/join?sessionId=${sessionId}`,
    sessionId: sessionId
  });
});