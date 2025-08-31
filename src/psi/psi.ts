export type AssociationTable = [Array<number>, Array<number>];

export type Connection = {
  on: (event: "data", fn: (data: unknown) => void, context?: undefined) => Connection
  once: (event: "data", fn: (data: unknown) => void, context?: undefined) => Connection
  removeListener: (
    event: "data",
    fn?: ((data: unknown) => void) | undefined,
    context?: undefined, once?: boolean
  ) => Connection
  send: (data: any, chunked?: boolean) => void | Promise<void>;
};

export type Role = 'starter' | 'joiner' | 'either';

export interface Config {
  role: Role;
  verbose?: number;
}
