export type Session = {
  initiatedName: string;
  invitedName: string;
  description: string;
  invitedPeerId?: string;
  timeToLive: Date;
}

export const sessions: { [key: string]: Session } = {};
