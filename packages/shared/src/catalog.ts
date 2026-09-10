import { z } from 'zod';

/**
 * Catalog = the "sphere" of the assistant. Swapping the sphere (IT support -> university
 * -> ISP) means swapping the JSON file that satisfies this schema. No code changes.
 */
export const ClarifyingFieldSchema = z.object({
  id: z.string().min(1),
  /** Question shown to the user when the field is missing. Deterministic - no LLM cost. */
  question: z.string().min(1),
  /** Optional quick-reply options rendered as buttons. */
  options: z.array(z.string()).optional(),
  /** Only ask when the field is required to pick/adapt a solution. */
  required: z.boolean().default(true),
});

export const KbArticleSchema = z.object({
  id: z.string().min(1),
  categoryId: z.string().min(1),
  title: z.string().min(1),
  /** Free-text symptoms used for retrieval. */
  symptoms: z.string().min(1),
  /** Ordered steps. Shown verbatim in LLM-less fallback mode. */
  steps: z.array(z.string().min(1)).min(1),
  /** Conditions under which the article does not apply - helps the model not to guess. */
  notApplicableWhen: z.string().optional(),
  /** If true - only a human can fully resolve; assistant does what it can and escalates. */
  escalateAfter: z.boolean().default(false),
  /** Where the article came from (link shown to the user in KB search). */
  source: z.string().url().optional(),
});

export const CategorySchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  description: z.string().min(1),
  /** Fields the engine asks for before searching for a solution. */
  clarify: z.array(ClarifyingFieldSchema).default([]),
  /** Default priority for tickets of this category. */
  priority: z.enum(['low', 'normal', 'high']).default('normal'),
});

export const CatalogSchema = z.object({
  /** Tenant id. One installation serves many tenants (spheres) side by side. */
  id: z
    .string()
    .regex(/^[a-z0-9-]{2,32}$/, 'tenant id: lowercase letters, digits, dashes'),
  sphere: z.string().min(1),
  /** Short description of the organisation - goes into the system prompt. */
  organisation: z.string().min(1),
  language: z.string().default('ru'),
  categories: z.array(CategorySchema).min(1),
  articles: z.array(KbArticleSchema).min(1),
});

export type ClarifyingField = z.infer<typeof ClarifyingFieldSchema>;
export type KbArticle = z.infer<typeof KbArticleSchema>;
export type Category = z.infer<typeof CategorySchema>;
export type Catalog = z.infer<typeof CatalogSchema>;
