import type { ErrorRequestHandler } from "express";
import { MulterError } from "multer";
import { ZodError } from "zod";
import { AppError } from "../shared/errors.js";
import { logger } from "../shared/logger.js";

/**
 * The single place where errors become HTTP responses.
 * Known errors keep their status and code; anything unexpected becomes a 500
 * whose details are logged but never sent to the client.
 */
export const errorHandler: ErrorRequestHandler = (err, req, res, _next) => {
  const requestId = req.requestId;

  if (err instanceof AppError) {
    res.status(err.statusCode).json({
      error: { code: err.code, message: err.message, details: err.details, requestId },
    });
    return;
  }

  if (err instanceof ZodError) {
    res.status(400).json({
      error: {
        code: "VALIDATION_ERROR",
        message: "Request validation failed",
        details: err.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
        requestId,
      },
    });
    return;
  }

  // Upload limits (multer): file too large, too many files, unexpected field.
  if (err instanceof MulterError) {
    const tooLarge = err.code === "LIMIT_FILE_SIZE";
    res.status(tooLarge ? 413 : 400).json({
      error: {
        code: tooLarge ? "FILE_TOO_LARGE" : "UPLOAD_ERROR",
        message: tooLarge ? "The file is too large" : err.message,
        requestId,
      },
    });
    return;
  }

  // Client errors raised by Express itself, e.g. malformed JSON or a body that is too large.
  if (isClientHttpError(err)) {
    const invalidJson = err.type === "entity.parse.failed";
    res.status(err.status).json({
      error: {
        code: invalidJson ? "INVALID_JSON" : "BAD_REQUEST",
        message: invalidJson ? "Request body is not valid JSON" : err.message,
        requestId,
      },
    });
    return;
  }

  logger.error({ err, requestId }, "Unhandled error");
  res.status(500).json({
    error: { code: "INTERNAL_ERROR", message: "Something went wrong", requestId },
  });
};

/** Errors created by the `http-errors` package (used by Express body parsing). */
function isClientHttpError(
  err: unknown,
): err is { status: number; message: string; type?: string; expose: true } {
  if (typeof err !== "object" || err === null) return false;
  const { status, expose } = err as { status?: unknown; expose?: unknown };
  return typeof status === "number" && status >= 400 && status < 500 && expose === true;
}
