import { z } from "zod";
import { runCodeParameters } from "../tools/code.tool.js";

/**
 * An organization's policy: what the agent may do on its behalf (docs/system-design.md §4.7).
 * Stored as versioned JSON in `policies.rules`; edited by owners/admins (policy:manage).
 */

const domain = z
  .string()
  .trim()
  .toLowerCase()
  .transform((d) => d.replace(/^www\./, ""))
  .pipe(z.string().regex(/^[a-z0-9.-]+\.[a-z]{2,}$/, "Not a valid domain"));

export const policyRulesSchema = z.object({
  tools: z.object({
    search: z.object({ enabled: z.boolean() }),
    fetch: z.object({ enabled: z.boolean(), maxPerRun: z.number().int().min(0).max(50) }),
    rag: z.object({ enabled: z.boolean() }),
    run_code: z.object({
      enabled: z.boolean(),
      requireApproval: z.boolean(),
      maxPerRun: z.number().int().min(0).max(10),
    }),
  }),
  domains: z.object({
    blocked: z.array(domain).max(500),
    /** If not empty, only these domains (and their subdomains) may be fetched. */
    allowed: z.array(domain).max(500),
  }),
  budget: z.object({
    maxCostUsd: z.number().positive().max(100),
    maxTokens: z.number().int().positive().max(10_000_000),
    maxSteps: z.number().int().positive().max(500),
    /** What happens when a run hits a limit: stop it, or pause it until an admin approves more. */
    onExceed: z.enum(["fail", "require_approval"]),
  }),
});

export type PolicyRules = z.infer<typeof policyRulesSchema>;

export const DEFAULT_POLICY_RULES: PolicyRules = {
  tools: {
    search: { enabled: true },
    fetch: { enabled: true, maxPerRun: 10 },
    rag: { enabled: true },
    run_code: { enabled: true, requireApproval: false, maxPerRun: 3 },
  },
  domains: { blocked: [], allowed: [] },
  budget: { maxCostUsd: 1, maxTokens: 400_000, maxSteps: 60, onExceed: "require_approval" },
};

/** Reads stored rules, filling gaps from the defaults (older versions may lack new fields). */
export function parseRules(raw: unknown): PolicyRules {
  const stored = (raw ?? {}) as Partial<PolicyRules>;
  const merged = {
    tools: { ...DEFAULT_POLICY_RULES.tools, ...stored.tools },
    domains: { ...DEFAULT_POLICY_RULES.domains, ...stored.domains },
    budget: { ...DEFAULT_POLICY_RULES.budget, ...stored.budget },
  };
  const result = policyRulesSchema.safeParse(merged);
  return result.success ? result.data : DEFAULT_POLICY_RULES;
}

/** The tools the agent can call, with the arguments the gateway accepts for each. */
export const toolArgumentSchemas = {
  search: z.object({
    provider: z.string().min(1),
    query: z.string().min(1).max(400),
    limit: z.number().int().min(1).max(10),
  }),
  fetch: z.object({ url: z.url(), pdfUrl: z.url().nullable() }),
  rag: z.object({
    query: z.string().min(1).max(2000),
    collectionIds: z.array(z.uuid()),
    sourceIds: z.array(z.uuid()),
  }),
  run_code: runCodeParameters,
} as const;

export type ToolName = keyof typeof toolArgumentSchemas;
export const toolNames = Object.keys(toolArgumentSchemas) as ToolName[];
