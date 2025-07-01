const PEER_ID_SERVER_POLLING_FREQUENCY_MS = 100;

var eventList = null;
var file = null;

function addMessageToList(message) {
  const newElement = document.createElement("li");
  newElement.textContent = message
  eventList.appendChild(newElement);
}

function startPSI(event) {
  event.preventDefault();

  document.getElementById("clientStartup").style.display = "none";
  document.getElementById("messageLog").style.removeProperty("display");

  file = document.getElementById("inputFile").files[0];
  document.getElementById("fileName").innerHTML = file.name;

  openPeerConnection();
}

async function openPeerConnection() {
  eventList = document.querySelector('ul#messages');

  const peer = new Peer({
    host: "/",
    path: "/peerjs/",
    port: 3000,
    debug: 2
  });

  peer.on('open', async function(id) {
    console.log(`peer id identified as: ${id}; sending to server`);
    addMessageToList(`peer id identified as: ${id}; sending to server`)

    try {
      const response = await fetch(
        './client/peerId',
      {
        headers: {
          'Accept': 'application/json',
          'Content-Type': 'application/json'
        },
        method: 'POST',
        body: JSON.stringify({
          sessionId: sessionId,
          invitedPeerId: peer.id
        })
      })

      if (!response.ok) {
        const responseText = await response.text();
        throw new Error(`Response status: ${response.status}, text: ${responseText}`);
      }
    } catch (error) {
      console.error(error.message);
    }
  });

  peer.on('connection', function(conn) {
    console.log('connection event recieved');
    addMessageToList(`connection event recieved`);

    conn.on('data', function(data) {
      console.log('Received', data);
      addMessageToList(`received message ${data}; sending response`)

      conn.send('I see you!');

      conn.close();
    })
  });

  peer.on('error', function(err) {
    console.error("peer error " + err);
  });
};