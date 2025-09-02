/// <reference types="@vitest/browser/providers/playwright" />

import { expect, test } from 'vitest'

import Peer from "peerjs";

import { PSIParticipant } from "../../src/psi/participant.js";

import { sortAssociationTable } from '../utils/associationTable.js';

import type { DataConnection } from 'peerjs';

import type { Config as PSIConfig } from "../../src/psi/psi.js";

import '../../public/js/psi_wasm_web.js'

interface AddressInfo {
	address: string;
	family: string;
	port: number;
}

const addressInfo: AddressInfo = {
	address: '127.0.0.1',
	family: 'IpV4',
  port: 3000
};
const protocol = 'http:';

const hostString = `${protocol}//${addressInfo.address}${addressInfo.port ? ':' + addressInfo.port.toString() : ''}`;

const session = await (async () => {
  const response = await fetch(
		`${hostString}/api/psi/create`,
		{
			method: 'POST',
			body: JSON.stringify({
				initiatedName: 'Test Server',
				invitedName: 'Test Code',
				description: 'Testing invited'
			})
		}
	);
	return await response.json();
})();

const clientPeer: Peer = await (() => {
	return new Promise((resolve, reject) => {
    const peer = new Peer({
      host: addressInfo.address,
      path: "/api/",
			port: addressInfo.port,
	  });
		peer.on('open', (id: string) => {
			fetch(`${hostString}/api/psi/${session['uuid']}`, {
				headers: {
					'Content-Type': 'application/json'
				},
				method: 'POST',
				body: JSON.stringify({
					invitedPeerId: id
				})
			}).then((response) => {
				if (!response.ok) {
					reject(new Error(`error posting peer id: ${response.status}, text: ${response.statusText}`));
				} else {
					resolve(peer);
				}
			})
		});
	});
})();

const clientConnPromise: Promise<DataConnection> = (() => {
	return new Promise((resolve) => {
    clientPeer.on('connection', (conn) => {
      conn.on('open', () => {
				resolve(conn);
			});
		});
	});
})();

const clientPeerId: string = await (() => {
	return new Promise((resolve, reject) => {
    const eventSource = new EventSource(
      `${hostString}/api/psi/${session.uuid}/wait`, { withCredentials: false }
    );

    eventSource.addEventListener('message', (ev: MessageEvent<any>) => {
      try {
        const messageData = ev.data && JSON.parse(ev.data);
        if (!("invitedPeerId" in messageData)) {
          throw new Error('unexpected message from server: ' + ev.data);
        } else {
          const invitedPeerId = messageData["invitedPeerId"];
          eventSource.close();
          resolve(invitedPeerId);
        }
      } catch (err) {
        eventSource.close();
        reject(err);
      }
    });

    eventSource.addEventListener('error', (ev: Event) => {
      eventSource.close();
      reject(new Error('EventSource connection error:' + JSON.stringify(ev)));
    });
	})
})();

const [serverPeer, serverConn]: [Peer, DataConnection] = await (async () => {
  return new Promise((resolve, reject) => {
		const peer = new Peer({
      host: addressInfo.address,
      path: "/api/",
			port: addressInfo.port
	  });
		peer.on('open', () => {
      const conn = peer.connect(clientPeerId, {reliable: true});
      resolve([peer, conn]);
    });

    peer.on('error', (err) => reject(err));
	})
})();

const psiLibrary = await (async () => {
  // @ts-ignore PSI defined by import
	const module = await PSI;
	return await module();
})();

const clientConn = await clientConnPromise;

const serverData = [
	'Alice', 'Bob', 'Carol', 'David', 'Elizabeth', 'Frank', 'Greta'
];
const clientData = ['Carol', 'Elizabeth', 'Henry'];

const runServerPSI = async () => {
  serverConn.once('data', () => serverPeer.disconnect());

	const psiConfig: PSIConfig = {role: 'starter', verbose: 0};
	const participant = new PSIParticipant(
		'server',
		psiLibrary,
		psiConfig
	);

	await participant.exchangeRoles(serverConn, true);
	return participant.identifyIntersection(serverConn, serverData);
}

const runClientPSI = async () => {
	clientConn.once('data', () => clientPeer.disconnect());

	const psiConfig: PSIConfig = {role: 'joiner', verbose: 0};
	const participant = new PSIParticipant(
		'client',
		psiLibrary,
		psiConfig,
	);
	await participant.exchangeRoles(clientConn, false);
	return await participant.identifyIntersection(clientConn, clientData);
}

let [serverResult, clientResult] = await Promise.all([
	runServerPSI(),
	runClientPSI()
]);

serverConn.close();
clientConn.close();

serverResult = sortAssociationTable(serverResult);
clientResult = sortAssociationTable(clientResult, true);

test('server and client yield identical results', () => {
  expect(serverResult[0]).toStrictEqual(clientResult[1]);
  expect(serverResult[1]).toStrictEqual(clientResult[0]);
});

test('psi yields correct results', () => {
  expect(serverResult[0]).toStrictEqual([2, 4]);
  expect(serverResult[1]).toStrictEqual([0, 1]);
});

