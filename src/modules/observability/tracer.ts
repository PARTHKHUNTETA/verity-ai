import { AsyncLocalStorage } from "node:async_hooks";
import type { Logger } from "pino";
import { v7 as uuidv7 } from "uuid";
import type { Database } from "../../infrastructure/database/client.js";
import { traceSpans, type NewTraceSpan } from "../../infrastructure/database/schema/index.js";

/**
 * A small OpenTelemetry-shaped tracer (docs/system-design.md §4.9).
 *
 * - A trace is a tree of spans (timed operations). For research runs, traceId = run id.
 * - The current span lives in AsyncLocalStorage, so `withSpan()` anywhere below finds its parent
 *   automatically (across awaits), without passing span objects through every function.
 * - Outside a trace, `withSpan()` does nothing: modules can instrument themselves safely.
 * - Finished spans are buffered and written in batches (every second, or every 100 spans).
 *
 * The API mirrors OpenTelemetry's, so swapping in a real OTel exporter later is a small change.
 */

export type SpanKind = "internal" | "client";

export interface Span {
  readonly spanId: string;
  readonly traceId: string;
  setAttributes(attributes: Record<string, unknown>): void;
  recordError(error: unknown): void;
  end(): void;
}

type TraceContext = { tracer: Tracer; traceId: string; organizationId: string; spanId: string };

const storage = new AsyncLocalStorage<TraceContext>();

const NOOP_SPAN: Span = {
  spanId: "",
  traceId: "",
  setAttributes() {},
  recordError() {},
  end() {},
};

/** Errors that interrupt work on purpose (pausing for approval, cancelling) aren't failures. */
export function isExpectedInterruption(error: unknown): boolean {
  return Boolean(
    error && typeof error === "object" && (error as { traceAsOk?: boolean }).traceAsOk,
  );
}

export type SpanOptions = {
  traceId: string;
  organizationId: string;
  parentSpanId?: string | null;
  kind?: SpanKind;
  attributes?: Record<string, unknown>;
};

export function createTracer({
  db,
  logger,
  flushIntervalMs = 1000,
  maxBuffer = 100,
}: {
  db: Database;
  logger: Logger;
  flushIntervalMs?: number;
  maxBuffer?: number;
}) {
  const buffer: NewTraceSpan[] = [];
  let pending: Promise<void> = Promise.resolve();

  async function writeBatch() {
    if (buffer.length === 0) return;
    const batch = buffer.splice(0);
    try {
      await db.insert(traceSpans).values(batch);
    } catch (err) {
      // Telemetry must never break the work it observes.
      logger.warn({ err, spans: batch.length }, "Writing trace spans failed");
    }
  }

  /** Writes buffered spans; resolves when everything ended so far is stored. */
  function flush(): Promise<void> {
    pending = pending.then(writeBatch);
    return pending;
  }

  const timer = setInterval(() => void flush(), flushIntervalMs);
  timer.unref();

  function startSpan(name: string, options: SpanOptions): Span {
    const spanId = uuidv7();
    const start = new Date();
    const attributes: Record<string, unknown> = { ...options.attributes };
    let status: "ok" | "error" = "ok";
    let errorMessage: string | null = null;
    let ended = false;

    return {
      spanId,
      traceId: options.traceId,
      setAttributes(more) {
        Object.assign(attributes, more);
      },
      recordError(error) {
        status = "error";
        errorMessage = (error instanceof Error ? error.message : String(error)).slice(0, 500);
      },
      end() {
        if (ended) return;
        ended = true;
        const end = new Date();
        buffer.push({
          spanId,
          traceId: options.traceId,
          parentSpanId: options.parentSpanId ?? null,
          organizationId: options.organizationId,
          name,
          kind: options.kind ?? "internal",
          status,
          attributes,
          errorMessage,
          startTime: start,
          endTime: end,
          durationMs: end.getTime() - start.getTime(),
        });
        if (buffer.length >= maxBuffer) void flush();
      },
    };
  }

  /** Runs `fn` inside a new span (a root, or a child of `parentSpanId`), ending it afterwards. */
  async function inSpan<T>(
    name: string,
    options: SpanOptions,
    fn: (span: Span) => Promise<T>,
  ): Promise<T> {
    const span = startSpan(name, options);
    const context: TraceContext = {
      tracer,
      traceId: options.traceId,
      organizationId: options.organizationId,
      spanId: span.spanId,
    };
    try {
      return await storage.run(context, () => fn(span));
    } catch (err) {
      if (isExpectedInterruption(err)) span.setAttributes({ interrupted: (err as Error).name });
      else span.recordError(err);
      throw err;
    } finally {
      span.end();
    }
  }

  const tracer = {
    startSpan,
    inSpan,
    flush,
    async shutdown() {
      clearInterval(timer);
      await flush();
    },
  };
  return tracer;
}

export type Tracer = ReturnType<typeof createTracer>;

/** Runs `fn` in a child span of the current trace. Outside a trace it just runs `fn`. */
export async function withSpan<T>(
  name: string,
  attributes: Record<string, unknown>,
  fn: (span: Span) => Promise<T>,
  kind: SpanKind = "internal",
): Promise<T> {
  const context = storage.getStore();
  if (!context) return fn(NOOP_SPAN);
  return context.tracer.inSpan(
    name,
    {
      traceId: context.traceId,
      organizationId: context.organizationId,
      parentSpanId: context.spanId,
      kind,
      attributes,
    },
    fn,
  );
}

/** Truncates long strings so span attributes stay small. */
export function short(value: string | null | undefined, max = 200): string | null {
  if (value == null) return null;
  return value.length > max ? `${value.slice(0, max)}…` : value;
}
