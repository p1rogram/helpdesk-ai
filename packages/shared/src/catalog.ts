import { z } from 'zod';

/**
 * AI: Catalog = the "sphere" of the assistant. Swapping the sphere (IT support -> university
 * -> ISP) means swapping the JSON file that satisfies this schema. No code changes.
 */
export const ExtractRuleSchema = z.object({
  /** AI: Regex over the lowercased message; the first non-empty capture group is the value. */
  pattern: z.string().min(1),
  /** AI: How to render the captured value, `$1` = capture. Defaults to the capture itself. */
  format: z.string().optional(),
  /** AI: Whitelist of captured values that really exist. Everything else is rejected. */
  allow: z.array(z.string()).optional(),
  /** AI: Shown when the value is not in `allow`; `{value}` is replaced with what was captured. */
  reject: z.string().optional(),
});
export type ExtractRule = z.infer<typeof ExtractRuleSchema>;

export const ClarifyingFieldSchema = z.object({
  id: z.string().min(1),
  /** AI: Human label for the ticket card ("Срочность", not "urgency"). */
  label: z.string().min(1).optional(),
  /** AI: Question shown to the user when the field is missing. Deterministic - no LLM cost. */
  question: z.string().min(1),
  /** AI: Optional quick-reply options rendered as buttons. */
  options: z.array(z.string()).optional(),
  /** AI: Only ask when the field is required to pick/adapt a solution. */
  required: z.boolean().default(true),
  /**
   * AI: Conditionally required: asked only when another field's value matches the pattern
   * ("room" is needed for a dorm, not for a lecture building). Evaluated after `required`.
   */
  requiredWhen: z.object({ field: z.string().min(1), pattern: z.string().min(1) }).optional(),
  /**
   * AI: Deterministic extraction rules. Let the engine pull the value straight out of the user's
   * text (dorm number, room, building) without relying on the model, and reject values that do not
   * exist in the organisation. Several rules = several forms of the same place ("общежитие 12",
   * "корпус 8"); the first rule whose pattern matches decides. Lives in the catalog - i.e. in the
   * database - not in the code.
   */
  extract: z.union([ExtractRuleSchema, z.array(ExtractRuleSchema).min(1)]).optional(),
});

export const KbArticleSchema = z.object({
  id: z.string().min(1),
  categoryId: z.string().min(1),
  title: z.string().min(1),
  /** AI: Free-text symptoms used for retrieval. */
  symptoms: z.string().min(1),
  /** AI: Ordered steps. Shown verbatim in LLM-less fallback mode. */
  steps: z.array(z.string().min(1)).min(1),
  /** AI: Conditions under which the article does not apply - helps the model not to guess. */
  notApplicableWhen: z.string().optional(),
  /** AI: If true - only a human can fully resolve; assistant does what it can and escalates. */
  escalateAfter: z.boolean().default(false),
  /** AI: 'public' articles are visible to guests (admission, contacts, addresses); the rest
   * require an organisation login. */
  audience: z.enum(['public', 'internal']).default('internal'),
  /** AI: Where the article came from (link shown to the user in KB search). */
  source: z.string().url().optional(),
});

export const CategorySchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  description: z.string().min(1),
  /** AI: Fields the engine asks for before searching for a solution. */
  clarify: z.array(ClarifyingFieldSchema).default([]),
  /** AI: Default priority for tickets of this category. */
  priority: z.enum(['low', 'normal', 'high']).default('normal'),
});

export const CatalogSchema = z.object({
  /** AI: Tenant id. One installation serves many tenants (spheres) side by side. */
  id: z.string().regex(/^[a-z0-9-]{2,32}$/, 'tenant id: lowercase letters, digits, dashes'),
  sphere: z.string().min(1),
  /** AI: Short description of the organisation - goes into the system prompt. */
  organisation: z.string().min(1),
  language: z.string().default('ru'),
  categories: z.array(CategorySchema).min(1),
  articles: z.array(KbArticleSchema).min(1),
});

export type ClarifyingField = z.infer<typeof ClarifyingFieldSchema>;
export type KbArticle = z.infer<typeof KbArticleSchema>;
export type Category = z.infer<typeof CategorySchema>;
export type Catalog = z.infer<typeof CatalogSchema>;
