import { pinoHttp } from "pino-http";
import { logger } from "../shared/logger.js";

/** Logs one line per request (method, url, status, duration) with the request id. */
export const requestLogger = pinoHttp({
  logger,
  genReqId: (req) => req.requestId,
  customLogLevel: (_req, res, err) => {
    if (err || res.statusCode >= 500) return "error";
    if (res.statusCode >= 400) return "warn";
    return "info";
  },
  // Keep request logs to one short line; headers can contain secrets and are rarely useful.
  serializers: {
    req: (req: { method: string; url: string }) => ({ method: req.method, url: req.url }),
    res: (res: { statusCode: number }) => ({ statusCode: res.statusCode }),
  },
  autoLogging: { ignore: (req) => req.url === "/api/v1/health" },
});
