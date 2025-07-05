const PEER_ID_SERVER_POLLING_FREQUENCY_MS = 100;

var eventList = null;
var file = null;
var serverSetup = null;

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

    /* await (async () => {
    await import("./psi/psi_wasm_web.js");
  })();
  psi = await PSI(); */
    console.log("loading PSI");
    import("./psi/psi_wasm_web.js").then(() => { PSI().then((psi) => {
      console.log("PSI loaded");
      conn.on("open", function() {
        
        const clientData = [
          "Carol",
          "Elizabeth",
          "Henry"
        ];

        const client = psi.client.createWithNewKey(true);

        console.log("sending client input size");
        addMessageToList("sending client input size");
        
        conn.send(clientData.length);
        
        conn.on("data", function(data) {
          if (serverSetup === null) {
            console.log("disconnecting from peer server");
            peer.disconnect();

            console.log("received setup message; sending request");
            addMessageToList("received setup message; sending request");

            serverSetup = psi.serverSetup.deserializeBinary(data);
            const clientRequest = client.createRequest(clientData);

            conn.send(clientRequest.serializeBinary());
          } else {
            console.log("received response message; calculating intersection");
            addMessageToList("received response message; calculating intersection");
            const serverResponse = psi.response.deserializeBinary(data);
            const intersection = client.getIntersection(
              serverSetup,
              serverResponse
            );
            console.log("intersection contains: ", intersection)
            var commonValues = [];
            for (var i = 0; i < intersection.length; i++) {
              commonValues.push(clientData[intersection[i]]);
            }
            console.log("common values: ", commonValues);
            addMessageToList("common values: " + commonValues);

            conn.close();
          }

        });

        
      });
    });});
  });

  peer.on('error', function(err) {
    console.error("peer error " + err);
  });
};