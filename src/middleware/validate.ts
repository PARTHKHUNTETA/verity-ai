import type { RequestHandler } from "express";
import type { ZodType } from "zod";

type Schemas = { body?: ZodType; params?: ZodType; query?: ZodType };

/**
 * Validates and normalizes request input with zod before the controller runs.
 * On success the parsed values replace the raw ones (e.g. trimmed, lower-cased email).
 * On failure zod throws a ZodError, which the error handler turns into a 400.
 */
export function validate(schemas: Schemas): RequestHandler {
  return (req, _res, next) => {
    if (schemas.body) req.body = schemas.body.parse(req.body);
    if (schemas.params) req.params = schemas.params.parse(req.params) as typeof req.params;
    if (schemas.query) {
      // Express 5 exposes req.query as a getter, so it is redefined instead of assigned.
      Object.defineProperty(req, "query", { value: schemas.query.parse(req.query) });
    }
    next();
  };
}
