export interface Session {
  sessionName: string;
  initiatedName: string;
  invitedName: string;
  description: string;
  invitedPeerId?: string;
  clientReady?: boolean;
}

export const sessions: { [key: string]: Session } = {};
