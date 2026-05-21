import { z } from "zod";

/**
 * Paired arrays of matched row indices produced by PSI linkage.
 *
 * `[0]` contains our (local) row indices; `[1]` contains the corresponding
 * partner row indices. Both arrays are the same length. The entries in `[0]`
 * are in strictly ascending order — this is a guaranteed invariant of
 * {@link linkViaPSI} and is relied upon by payload reconstruction.
 */
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
