import { z } from "zod";

export type AssociationTable = [Array<number>, Array<number>];

export type Connection = {
  on: (
    event: "data",
    fn: (data: unknown) => void,
    context?: undefined,
  ) => Connection;
  once: (
    event: "data",
    fn: (data: unknown) => void,
    context?: undefined,
  ) => Connection;
  removeListener: (
    event: "data",
    fn?: ((data: unknown) => void) | undefined,
    context?: undefined,
    once?: boolean,
  ) => Connection;
  send: (data: unknown, chunked?: boolean) => void | Promise<void>;
  close: () => void;
};

export type Role = "starter" | "joiner" | "either";

export interface Config {
  role: Role;
  verbose?: number;
}

export interface KeyAliases {
  [key: string]: Array<string>;
}

export type Formatter = (x: unknown) => string | undefined;

export interface LinkageKeyFieldDefinition {
  outputFieldName: string;
  inputFieldName: string;
  formatter: Formatter;
}

export type LinkageKeyDefinition = Array<LinkageKeyFieldDefinition>;

export const AlgorithmSchema = z.enum(["psi", "psi-c"]);
export type Algorithm = z.infer<typeof AlgorithmSchema>;

export const PsiRoleSchema = z.enum(["sender", "receiver"]);
export type PsiRole = z.infer<typeof PsiRoleSchema>;
