import * as z from 'zod';

import { getLoggerForVerbosity } from '../utils/logger';

import { EventHandlerQueue } from './connection/eventHandlerQueue';

import type {
  AssociationTable,
  Config,
  Connection,
  Role
} from './psi';

const protocolMessage = z.object({
  role: z.literal(['starter', 'joiner', 'either'])
});

const statusMessage = z.object({
  status: z.literal(['completed'])
});

const numberArrayMessage = z.array(z.number());
const associationTableMessage = z.array(z.array(z.number()));


const DEFAULT_VERBOSITY = 1;

export enum ProcessState {
  BeforeStart,
  Waiting,
  Working,
  Done
};

function defineProtocol
<const T extends Array<{ id: string, label: string, state: ProcessState }>>
(stages: T) {
  return stages;
}
type ProtocolStageId<T extends Array<{id: string}>> = T[number]['id'];

export const starterProtocolStages = defineProtocol([
  { id: 'confirming protocol', label: 'Confirming protocol', state: ProcessState.BeforeStart },
  { id: 'sending startup message', label: 'Sending my encrypted data', state: ProcessState.Working },
  { id: 'waiting for client request', label: 'Waiting for partner\'s encrypted data', state: ProcessState.Working },
  { id: 'processing client request', label: 'Doubly-encrypting partner\'s data', state: ProcessState.Working },
  { id: 'sending response', label: 'Sending partner\'s doubly-encrypted data', state: ProcessState.Working },
  { id: 'waiting for association table', label: 'Waiting for shared elements', state: ProcessState.Working },
  { id: 'processing association table', label: 'Cleaning result', state: ProcessState.Working },
  { id: 'done', label: 'Done', state: ProcessState.Done },
] as const);


export const joinerProtocolStages = defineProtocol([
  { id: 'confirming protocol', label: 'Confirming protocol', state: ProcessState.BeforeStart },
  { id: 'waiting for startup message', label: 'Waiting for partner\'s encrypted data', state: ProcessState.Working },
  { id: 'processing startup message', label: 'Encrypting my data', state: ProcessState.Working },
  { id: 'sending client request', label: 'Sending my encrypted data', state: ProcessState.Working },
  { id: 'waiting for response', label: 'Waiting for my doubly-encrypted data', state: ProcessState.Working },
  { id: 'creating association table', label: 'Identifying shared elements', state: ProcessState.Working },
  { id: 'sending association table', label: 'Sending results', state: ProcessState.Working },
  { id: 'waiting for permutation', label: 'Waiting for clean result', state: ProcessState.Working },
  { id: 'done', label: 'Done', state: ProcessState.Done },
] as const);

type StarterProtocolStageId = ProtocolStageId<typeof starterProtocolStages>
type JoinerProtocolStageId = ProtocolStageId<typeof joinerProtocolStages>

type ProtocolId = StarterProtocolStageId | JoinerProtocolStageId;

export class PSIParticipant {
  id: string;
  private library: any;
  config: Config;
  private setStage: (id: ProtocolId) => void;
  private stages: typeof joinerProtocolStages | typeof starterProtocolStages | undefined;
  private log: ReturnType<typeof getLoggerForVerbosity>;

  private psi;

  constructor(
    id: string,
    library: any,
    config: Config,
    setStage?: (id: ProtocolId) => void,
  ) {
    this.id = id;
    this.library = library;
    this.config = config;
    this.setStage = setStage ? setStage : () => {};

    if (this.config.verbose === undefined) {
      this.config.verbose = DEFAULT_VERBOSITY;
    }

    this.log = getLoggerForVerbosity('participant', this.config.verbose);

    if (this.config.role === 'starter') {
      this.psi = library.server.createWithNewKey(true);
    } else if (this.config.role === 'joiner') {
      this.psi = library.client.createWithNewKey(true);
    }
  }

  private setStages() {
    if (this.config.role === 'starter') {
      this.stages = starterProtocolStages;
    } else {
      this.stages = joinerProtocolStages;
    }
  }

  getStages() { return this.stages; }

  async exchangeRoles(conn: Connection, firstToParty: boolean): Promise<Role> {
    this.log.info(`${this.id}: starting role exchange with role ${this.config.role}`);
    this.setStage('confirming protocol');

    if (!firstToParty) {
      return new Promise((resolve) => {
        // last to party kicks things off by sending their role (see below)
        // last to party will prefer to be the joiner
        conn.once('data', (rawData: any) => {

          const peerConfig = protocolMessage.parse(rawData);
          this.log.debug(`${this.id}: received peer role '${peerConfig.role}'`);
          if (peerConfig.role === this.config.role && this.config.role !== 'either') {
            throw new Error(
              `peer role '${peerConfig.role}' is incompatible with `
              + `own role '${this.config.role}'`
            );
          }
          if (this.config.role === 'either') {
            this.config.role = peerConfig.role === 'joiner' ? 'starter' : 'joiner';
            this.log.debug(`${this.id}: setting role to '${this.config.role}'`);
          }

          if (!this.psi) {
            if (this.config.role === 'starter') {
              this.psi = this.library.server.createWithNewKey(true);
            } else {
              this.psi = this.library.client.createWithNewKey(true);
            }
          }

          this.setStages();
          resolve(this.config.role);
        });

        this.log.debug(`${this.id}: sending role ${this.config.role}`);
        conn.send({role: this.config.role});
      });
    } else {
      return new Promise((resolve) => {
        // first to party waits to receive role
        // first to party will prefer to be the starter
        conn.once('data', (rawData: any) => {

          const peerConfig = protocolMessage.parse(rawData);
          this.log.debug(`${this.id}: received peer role '${peerConfig.role}'`);
          if (peerConfig.role === this.config.role && this.config.role !== 'either') {
            throw new Error(
              `peer role '${peerConfig.role}' is incompatible with `
              + `own role '${this.config.role}'`
            );
          }
          if (this.config.role === 'either') {
            this.config.role = peerConfig.role === 'either' ? 'starter' : 'joiner';
          }

          if (!this.psi) {
            if (this.config.role === 'starter') {
              this.psi = this.library.server.createWithNewKey(true);
            } else {
              this.psi = this.library.client.createWithNewKey(true);
            }
          }

          this.log.debug(`${this.id}: sending role '${this.config.role}'`);
          conn.send({role: this.config.role});

          this.setStages();
          resolve(this.config.role);
        });
      });
    }
  }

  /** Returns an association table with elements [myIndices, theirIndices] */
  public async identifyIntersection(conn: Connection, set: Array<string>):
    Promise<AssociationTable>
  {
    if (this.config.role === 'starter') {
      return new Promise((resolve) => {
        const sortingPermutation: Array<number> = [];

        const serverSetup = this.psi.createSetupMessage(
          0.0,
          -1,
          set,
          this.library.dataStructure.Raw,
          sortingPermutation
        );
        let result: Array<Array<number>>;

        const eventHandlerQueue = new EventHandlerQueue([
          (rawData: any) => {
            this.log.debug(`${this.id}: received client data encrypted by client`);
            this.setStage('processing client request');

            const clientRequest = this.library.request.deserializeBinary(rawData);
            const serverResponse = this.psi.processRequest(clientRequest).serializeBinary();

            this.log.debug(`${this.id}: sending client data encrypted by both server and client`);
            this.setStage('sending response');

            conn.send(serverResponse);

            this.setStage('waiting for association table');
          },
          (rawData: any) => {
            this.log.debug(`${this.id}: received association table`);
            this.setStage('processing association table');
            // note: what we receive is backwards, so this is correct
            const [theirIndices, myIndices] = associationTableMessage.parse(rawData);

            result = [myIndices, theirIndices];
            for (let i = 0; i < result[0].length; ++i) {
              result[0][i] = sortingPermutation[result[0][i]];
            }

            this.log.debug(`${this.id}: sending my original indices`);
            conn.send(result[0]);

            this.log.debug(`${this.id}: waiting for status completed`);
          },
          (rawData: any) => {
            statusMessage.parse(rawData);

            this.setStage('done');

            conn.removeListener('data', eventHandlerQueue.handleEvent);

            resolve([result[0], result[1]]);
          }
        ]);
        conn.on('data', eventHandlerQueue.handleEvent);

        this.log.info(`${this.id}: starting identify-intersection protocol`);
        this.log.debug(`${this.id}: sending server data encrypted by server`);
        this.setStage('sending startup message');
        conn.send(serverSetup.serializeBinary())

        this.setStage('waiting for client request');
      });
    } else {
      return new Promise((resolve) => {
        let serverSetup: any = undefined;
        let myIndices: Array<number>;

        this.setStage('waiting for startup message');

        const eventHandlerQueue = new EventHandlerQueue([
          (rawData: any) => {
            this.log.debug(`${this.id}: receiving server data encrypted by server`);
            this.setStage('processing startup message');

            serverSetup = this.library.serverSetup.deserializeBinary(rawData);

            const clientRequest = this.psi.createRequest(set);

            this.log.debug(`${this.id}: sending client data encrypted by client`);
            this.setStage('sending client request');

            conn.send(clientRequest.serializeBinary());

            this.setStage('waiting for response');
          },
          (rawData: any) => {
            this.log.debug(`${this.id}: receiving server data encrypted by both by server and client`);
            this.setStage('creating association table');

            const serverResponse = this.library.response.deserializeBinary(rawData);
            /** association table is indexes into client data mapped to the indexes
             * given by the server (which are likely permuted).
             */
            const associationTable: Array<Array<number>> = this.psi.getAssociationTable(
              serverSetup,
              serverResponse
            );
            myIndices = associationTable[0];

            this.log.debug(`${this.id}: sending association table with permuted server indices`);
            this.setStage('sending association table');

            conn.send(associationTable);

            this.setStage('waiting for permutation');
          },
          (rawData: any) => {
            this.log.debug(`${this.id}: receiving original server indices`);
            this.setStage('done');

            this.log.debug(`${this.id}: sending status completed`);
            conn.send({status: 'completed'});

            conn.removeListener('data', eventHandlerQueue.handleEvent);

            resolve([myIndices, numberArrayMessage.parse(rawData)]);
          }
        ]);
        conn.on('data', eventHandlerQueue.handleEvent);
        this.log.info(`${this.id}: starting identify-intersection protocol`);
      });
    }
  }
}
