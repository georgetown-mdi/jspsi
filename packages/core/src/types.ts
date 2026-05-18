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
export type HandshakeRole = "initiator" | "responder";

export interface Config {
  role: Role;
  verbose?: number;
}

export const AlgorithmSchema = z.enum(["psi", "psi-c"]);
export type Algorithm = z.infer<typeof AlgorithmSchema>;

export const PsiRoleSchema = z.enum(["sender", "receiver"]);
export type PsiRole = z.infer<typeof PsiRoleSchema>;

export const SEMANTIC_TYPES = [
  "ssn",
  "ssn4",
  "firstName",
  "lastName",
  "dateOfBirth",
  "identifier",
  "phoneNumber",
  "emailAddress",
  "other",
] as const;

export type SemanticType = (typeof SEMANTIC_TYPES)[number];

export type Prettify<T> = {
  [K in keyof T]: T[K];
} & {};
