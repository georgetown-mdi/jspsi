export interface Session {
  initiatedName: string;
  invitedName: string;
  description: string;
  invitedPeerId?: string;
}

export const sessions: { [key: string]: Session } = {};
