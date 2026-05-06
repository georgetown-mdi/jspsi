// NOTE: These types are candidates to be moved to types.ts once the broader
// type hierarchy is established.

import { z } from 'zod';

export const AlgorithmSchema = z.enum(['psi', 'psi-c']);
export type Algorithm = z.infer<typeof AlgorithmSchema>;

export const MultiplicitySchema = z.enum(['one-to-one', 'one-to-many', 'many-to-many']);
export type Multiplicity = z.infer<typeof MultiplicitySchema>;

export const PsiRoleSchema = z.enum(['sender', 'receiver']);
export type PsiRole = z.infer<typeof PsiRoleSchema>;
