import { createHmac, randomBytes } from 'node:crypto';

import { v4 as uuidv4 } from 'uuid';

const PASSWORD_HASH_ALGORITHM = 'sha256';

// import { Config } from '@utils/config'

interface LinkSessionProperties {
  initiatedName: string;
  invitedName: string;
  description: string;
  timeToLive: Date;
}
export interface LinkSession extends LinkSessionProperties {
  uuid: string;
  invitedPeerId?: string;
}

interface PasswordSession {
  hashedPassword: string;
  partnerPeerId: string;
  timeToLive: Date;
}

interface LinkSessionId {
  uuid: string;
  hashedPassword?: never;
}

interface PasswordSessionId {
  uuid?: never;
  hashedPassword: string;
}

export type SessionId = LinkSessionId | PasswordSessionId;

export type SessionProp = {
  session: LinkSession
};

class SessionManagerFactory {
  private static instance: SessionManagerFactory | undefined;

  private linkSessions: { [key: string]: LinkSession };
  private passwordSessions: { [key: string] : PasswordSession }
  private salt: string;
  
  private constructor() {
    this.linkSessions = {};
    this.passwordSessions = {};
    this.salt = randomBytes(16).toString('hex');
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  public static async getSessionManager() : Promise<SessionManagerFactory> {
    if (!SessionManagerFactory.instance) {
      SessionManagerFactory.instance = new SessionManagerFactory();
    }
    return SessionManagerFactory.instance;
  }

  public hash(password: string): string {
    const hash = createHmac(PASSWORD_HASH_ALGORITHM, this.salt);
    return hash.update(password).digest('hex');
  }

  public get(id: LinkSessionId): LinkSession;
  public get(id: PasswordSessionId): PasswordSession;
  get(id: SessionId): LinkSession | PasswordSession {
    if (id.uuid !== undefined) {
      return this.linkSessions[id.uuid];
    }
    return this.passwordSessions[id.hashedPassword];
  }

  has(id: SessionId) : boolean {
    if (id.uuid !== undefined) {
      return id.uuid in this.linkSessions;
    }
    return id.hashedPassword in this.passwordSessions;
  }

  remove(id: SessionId) : void {
    if (id.uuid !== undefined) {
      delete this.linkSessions[id.uuid];
      return;
    }
    delete this.passwordSessions[id.hashedPassword];
  }

  public set(sessionProperties: LinkSessionProperties) : LinkSession;
  public set(sessionProperties: PasswordSession) : void;
  set(sessionProperties: LinkSessionProperties | PasswordSession)
  {
    const delay = sessionProperties.timeToLive.getTime() - Date.now();
    if (delay <= 0) throw new Error('cannot create session: has already expired')

    let result;
    let id: SessionId;

    if ('initiatedName' in sessionProperties) {
      const session: LinkSession = {
        uuid: uuidv4(),
        ...sessionProperties
      }
      
      this.linkSessions[session.uuid] = session;

      result = session;
      id = {uuid: session.uuid};
    } else {
      this.passwordSessions[sessionProperties.hashedPassword] = sessionProperties;
      id = {hashedPassword: sessionProperties.hashedPassword};
    }

    setTimeout(
      () => {if (this.has(id)) this.remove(id)},
      delay
    )

    if (result) return result;
  }
}

export const useSessionManager = async function() {
  return SessionManagerFactory.getSessionManager();
}

/* 
const configManager = new Config();
const config = await configManager.load();

if (config.TEST_SESSION) {
  sessions['1111111-1111-1111-1111-11111111111'] = {
    id: '1111111-1111-1111-1111-11111111111',
    initiatedName: 'Test Server',
    invitedName: 'Test Client',
    description: 'Default testing session',
    timeToLive: new Date(Date.now() + 1000 * 60 * 60 * 24)
  }
}
*/