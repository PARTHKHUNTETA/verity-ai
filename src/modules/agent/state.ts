import { eq } from "drizzle-orm";
import type { Database } from "../../infrastructure/database/client.js";
import { researchRuns, type RunStage } from "../../infrastructure/database/schema/index.js";

/**
 * Persistent run state (docs/system-design.md §4.4). Saved after every stage, so a run whose
 * worker crashed can be resumed by another worker: completed stages are skipped and their
 * outputs are read back from here (or from their tables).
 */

/** A retrieved passage, numbered P1..Pn for the evidence-extraction prompts. */
export type Passage = {
  number: number;
  subQuestionId: string;
  chunkId: string;
  sourceId: string;
  sourceTitle: string;
  origin: string;
  pageStart: number | null;
  pageEnd: number | null;
  content: string;
  score: number;
};

export type RunState = {
  version: 1;
  completed: RunStage[];
  /** Agent steps recorded so far (the next step gets seq = steps + 1). */
  steps: number;
  usage: { inputTokens: number; outputTokens: number; costUsd: number | null };
  title: string | null;
  acquiredSourceIds: string[];
  passages: Passage[];
  analysis: string | null;
};

export function initialState(): RunState {
  return {
    version: 1,
    completed: [],
    steps: 0,
    usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
    title: null,
    acquiredSourceIds: [],
    passages: [],
    analysis: null,
  };
}

export function loadState(raw: unknown): RunState {
  const state = raw as Partial<RunState> | null;
  return state?.version === 1 ? { ...initialState(), ...state } : initialState();
}

/** Checkpoint: state plus the live totals shown in the UI. */
export async function saveState(db: Database, runId: string, state: RunState): Promise<void> {
  await db
    .update(researchRuns)
    .set({
      state,
      stepCount: state.steps,
      tokensInput: state.usage.inputTokens,
      tokensOutput: state.usage.outputTokens,
      costUsd: state.usage.costUsd,
    })
    .where(eq(researchRuns.id, runId));
}
