// NOTE: These types are candidates to be moved to types.ts once the broader
// type hierarchy is established.

import { z } from "zod";

export const AlgorithmSchema = z.enum(["psi", "psi-c"]);
export type Algorithm = z.infer<typeof AlgorithmSchema>;

// Per-party multiplicity: 'one' means this party's records match at most once;
// 'many' means a single record may appear in multiple matched pairs.
// The combined exchange multiplicity is inferred when both agreements are
// compared.
export const MultiplicitySchema = z.enum(["one", "many"]);
export type Multiplicity = z.infer<typeof MultiplicitySchema>;

export const PsiRoleSchema = z.enum(["sender", "receiver"]);
export type PsiRole = z.infer<typeof PsiRoleSchema>;
