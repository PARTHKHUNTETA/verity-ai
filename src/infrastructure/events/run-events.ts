import { EventEmitter } from "node:events";
import { Client, type Pool } from "pg";
import type { Logger } from "pino";
import type { RunStage, RunStatus } from "../database/schema/index.js";

/**
 * Live progress of research runs, from the worker process to API processes (and back for
 * cancellation), using Postgres LISTEN/NOTIFY: no extra infrastructure needed.
 *
 *   worker ──pg_notify('run_events', json)──▶ Postgres ──▶ every LISTENing process
 *
 * NOTIFY is fire-and-forget: a process that isn't listening at that moment misses the event.
 * That's fine because the source of truth is the database; events only make the UI live.
 */

export type RunEvent =
  | { type: "status"; runId: string; status: RunStatus; stage: RunStage | null }
  /** A piece of generated text. `offset` = length of the answer before this piece. */
  | { type: "delta"; runId: string; offset: number; text: string };

export type RunEventListener = (event: RunEvent) => void;

export interface RunEventPublisher {
  publish(event: RunEvent): Promise<void>;
}

export interface RunEventSubscriber {
  /** Listen to one run's events, or "*" for all. Returns an unsubscribe function. */
  subscribe(runId: string, listener: RunEventListener): () => void;
}

export type RunEventBus = RunEventPublisher & RunEventSubscriber;

const CHANNEL = "run_events";
/** NOTIFY payloads must be under 8000 bytes; 1500 chars leaves room for 4-byte UTF-8 + JSON. */
const MAX_DELTA_CHARS = 1500;

/** Splits large deltas so each NOTIFY payload stays under Postgres's size limit. */
export function splitEvent(event: RunEvent): RunEvent[] {
  if (event.type !== "delta" || event.text.length <= MAX_DELTA_CHARS) return [event];
  const parts: RunEvent[] = [];
  for (let i = 0; i < event.text.length; i += MAX_DELTA_CHARS) {
    parts.push({
      ...event,
      offset: event.offset + i,
      text: event.text.slice(i, i + MAX_DELTA_CHARS),
    });
  }
  return parts;
}

function createEmitterSubscriber() {
  const emitter = new EventEmitter();
  emitter.setMaxListeners(0); // one listener per open SSE connection
  return {
    emit(event: RunEvent) {
      emitter.emit(event.runId, event);
      emitter.emit("*", event);
    },
    subscribe(runId: string, listener: RunEventListener) {
      emitter.on(runId, listener);
      return () => emitter.off(runId, listener);
    },
  };
}

/** Production bus: publishes with pg_notify, receives on a dedicated LISTEN connection. */
export function createPgRunEventBus(options: {
  pool: Pool;
  connectionString: string;
  logger: Logger;
}): RunEventBus & { start(): Promise<void>; stop(): Promise<void> } {
  const { pool, connectionString, logger } = options;
  const local = createEmitterSubscriber();
  let client: Client | null = null;
  let stopped = false;
  let reconnecting = false;

  async function connect() {
    // LISTEN needs one long-lived connection (a pooled one could be handed to someone else).
    const c = new Client({ connectionString });
    c.on("notification", (msg) => {
      if (msg.channel !== CHANNEL || !msg.payload) return;
      try {
        local.emit(JSON.parse(msg.payload) as RunEvent);
      } catch (err) {
        logger.warn({ err }, "Ignoring malformed run event");
      }
    });
    c.on("error", (err) => logger.error({ err }, "Run event listener connection error"));
    c.on("end", () => {
      if (client === c) {
        client = null;
        void reconnect();
      }
    });
    await c.connect();
    await c.query(`LISTEN ${CHANNEL}`);
    client = c;
  }

  /** Retries with exponential backoff (1s, 2s, 4s … max 30s) until connected or stopped. */
  async function reconnect() {
    if (reconnecting) return;
    reconnecting = true;
    for (let delay = 1000; !stopped; delay = Math.min(delay * 2, 30_000)) {
      await new Promise((resolve) => setTimeout(resolve, delay).unref());
      try {
        await connect();
        logger.info("Run event listener reconnected");
        break;
      } catch (err) {
        logger.error({ err }, "Run event listener reconnect failed");
      }
    }
    reconnecting = false;
  }

  return {
    subscribe: local.subscribe,
    async publish(event) {
      for (const part of splitEvent(event)) {
        await pool.query("select pg_notify($1, $2)", [CHANNEL, JSON.stringify(part)]);
      }
    },
    start: connect,
    async stop() {
      stopped = true;
      await client?.end().catch(() => {});
      client = null;
    },
  };
}

/** Test/dev bus: delivers events within the current process and records them. */
export function createInMemoryRunEventBus(): RunEventBus & { published: RunEvent[] } {
  const local = createEmitterSubscriber();
  const published: RunEvent[] = [];
  return {
    published,
    subscribe: local.subscribe,
    async publish(event) {
      for (const part of splitEvent(event)) {
        published.push(part);
        local.emit(part);
      }
    },
  };
}
