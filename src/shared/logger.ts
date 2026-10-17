import { pino } from "pino";
import { env } from "../config/env.js";

/**
 * Structured JSON logger. In development the output is pretty-printed;
 * in production it stays JSON so log tools can parse it.
 */
export const logger = pino({
  level: env.LOG_LEVEL,
  base: { service: "verity-ai-backend" },
  redact: ["req.headers.authorization", "req.headers.cookie"],
  ...(env.NODE_ENV === "development" && {
    transport: {
      target: "pino-pretty",
      options: { colorize: true, translateTime: "SYS:HH:MM:ss" },
    },
  }),
});
