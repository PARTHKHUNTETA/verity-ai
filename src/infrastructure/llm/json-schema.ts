import { z, type ZodType } from "zod";

/**
 * Converts a zod schema to the JSON Schema subset OpenAI accepts for strict structured outputs
 * and tool parameters: every object closed (additionalProperties: false) with all fields
 * required (zod 4 already emits that for non-optional fields), and no unsupported keywords.
 * Length limits are still enforced: we validate the parsed result with zod afterwards.
 */
const UNSUPPORTED = new Set(["$schema", "minLength", "maxLength", "default"]);

export function toStrictJsonSchema(schema: ZodType): Record<string, unknown> {
  return clean(z.toJSONSchema(schema)) as Record<string, unknown>;
}

function clean(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(clean);
  if (node === null || typeof node !== "object") return node;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node)) {
    if (!UNSUPPORTED.has(key)) out[key] = clean(value);
  }
  return out;
}
