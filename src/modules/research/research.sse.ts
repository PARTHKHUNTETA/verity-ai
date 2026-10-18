import type { RequestHandler, Response } from "express";
import type { RunEvent, RunEventSubscriber } from "../../infrastructure/events/run-events.js";
import { getAuth } from "../../middleware/authenticate.js";
import { isTerminal, type ResearchService } from "./research.service.js";

/**
 * GET /research/runs/:runId/stream — Server-Sent Events.
 *
 * Protocol (each message is `event: <name>\ndata: <json>\n\n`):
 *   snapshot  full run detail from the DB (sent first, and again when the run finishes)
 *   status    { status, stage } changed
 *   delta     { offset, text }: append `text` at position `offset` of the answer
 *   done      the run is finished; the server closes the stream
 *
 * Ordering trick: we subscribe to live events BEFORE reading the snapshot and buffer them,
 * so nothing that happens in between is lost. The client uses `offset` to skip text it already
 * has from the snapshot.
 */
export function createRunStreamHandler(
  service: ResearchService,
  events: RunEventSubscriber,
  heartbeatMs = 15_000,
): RequestHandler<{ runId: string }> {
  return async (req, res) => {
    const auth = getAuth(req);
    const { runId } = req.params;
    // Throws 404 (as normal JSON) before any SSE headers are sent if the run isn't visible.
    await service.getRunDetail(auth, runId);

    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no", // tell proxies like nginx not to buffer the stream
    });

    let closed = false;
    let buffering = true;
    const buffered: RunEvent[] = [];

    const finish = async () => {
      if (closed) return;
      send(res, "snapshot", await service.getRunDetail(auth, runId));
      send(res, "done", {});
      cleanup();
      res.end();
    };

    const handle = (event: RunEvent) => {
      if (closed) return;
      if (buffering) {
        buffered.push(event);
        return;
      }
      if (event.type === "delta") {
        send(res, "delta", { offset: event.offset, text: event.text });
      } else {
        send(res, "status", { status: event.status, stage: event.stage });
        if (isTerminal(event.status)) void finish().catch(() => cleanup());
      }
    };

    const unsubscribe = events.subscribe(runId, handle);
    const heartbeat = setInterval(() => !closed && res.write(": ping\n\n"), heartbeatMs);
    const cleanup = () => {
      closed = true;
      clearInterval(heartbeat);
      unsubscribe();
    };
    req.on("close", cleanup);

    const snapshot = await service.getRunDetail(auth, runId);
    send(res, "snapshot", snapshot);
    if (isTerminal(snapshot.run.status)) {
      send(res, "done", {});
      cleanup();
      res.end();
      return;
    }
    buffering = false;
    for (const event of buffered.splice(0)) handle(event);
  };
}

function send(res: Response, event: string, data: unknown) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}
