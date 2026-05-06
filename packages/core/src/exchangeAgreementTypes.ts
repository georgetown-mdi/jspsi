// NOTE: These types are candidates to be moved to types.ts once the broader
// type hierarchy is established.

import { z } from "zod";

export const AlgorithmSchema = z.enum(["psi", "psi-c"]);
export type Algorithm = z.infer<typeof AlgorithmSchema>;

export const PsiRoleSchema = z.enum(["sender", "receiver"]);
export type PsiRole = z.infer<typeof PsiRoleSchema>;
