import type { Logger } from "pino";
import type { Database } from "../../../infrastructure/database/client.js";
import type {
  NewAgentStep,
  ResearchRun,
  ResearchTask,
} from "../../../infrastructure/database/schema/index.js";
import type { RunEventPublisher } from "../../../infrastructure/events/run-events.js";
import type { LlmClient, LlmUsage } from "../../../infrastructure/llm/index.js";
import type { ExecuteOptions, ToolOutcome } from "../../policies/executor.js";
import type { ToolName } from "../../policies/policy-rules.js";
import type { AcquisitionService } from "../../retrieval/acquisition.js";
import type { SearchService } from "../../retrieval/search.js";
import type { CodeSandbox } from "../../tools/code.tool.js";
import type { DiscoveryProviders } from "../../tools/search.tool.js";
import type { Budget } from "../budget.js";
import type { RunState } from "../state.js";

export type RunConfig = {
  collectionIds?: string[];
  /** Passages retrieved per sub-question. */
  topK?: number;
  discovery?: { enabled?: boolean };
  budget?: Partial<Budget>;
  /** Whether the evaluation stage may revise a weak report (default true). */
  revise?: boolean;
  /**
   * Nobody is watching (offline evaluation): a tool call that needs approval is denied instead
   * of pausing the run, and running out of budget fails the run instead of asking for more.
   */
  unattended?: boolean;
  /** Set on runs created by an offline eval run (Phase 11). */
  eval?: { runId: string; caseId: string };
};

export type DiscoveryDeps = {
  providers: DiscoveryProviders;
  acquisition: AcquisitionService;
  /** How many documents to fetch and index per run. */
  maxSources: number;
};

/** Everything a stage needs. Stages read and update `state`; the runtime saves it after each stage. */
export type StageContext = {
  db: Database;
  llm: LlmClient;
  search: SearchService;
  events: RunEventPublisher;
  logger: Logger;
  sandbox: CodeSandbox;
  discovery?: DiscoveryDeps;
  run: ResearchRun;
  task: ResearchTask;
  config: RunConfig;
  state: RunState;
  signal: AbortSignal;
  publishIntervalMs: number;
  persistIntervalMs: number;
  /** Records an agent step (next seq) and returns its id. */
  recordStep: (step: Omit<NewAgentStep, "organizationId" | "runId" | "seq">) => Promise<string>;
  /** Adds an LLM call's usage to the run totals, checks the budget, returns the call's cost. */
  trackUsage: (model: string, usage: LlmUsage) => number | null;
  /** Throws if the run was cancelled or timed out. */
  checkCancelled: () => void;
  /**
   * Runs an agent tool through the policy gateway (the only way stages may use tools).
   * Throws ApprovalRequiredError when a human has to decide first.
   */
  tools: {
    call<T>(
      tool: ToolName,
      args: Record<string, unknown>,
      fn: () => Promise<T>,
      options: ExecuteOptions<T>,
    ): Promise<ToolOutcome<T>>;
  };
};
