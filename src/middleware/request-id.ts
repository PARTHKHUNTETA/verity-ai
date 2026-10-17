import type { RequestHandler } from "express";
import { v7 as uuidv7 } from "uuid";

const HEADER = "x-request-id";
const SAFE_ID = /^[A-Za-z0-9._-]{1,128}$/;

/**
 * Gives every request an id. An incoming X-Request-Id (e.g. from a proxy) is reused
 * when it looks safe; otherwise a new UUID v7 is generated. The id is echoed back
 * in the response header and attached to every log line.
 */
export const requestId: RequestHandler = (req, res, next) => {
  const incoming = req.get(HEADER);
  req.requestId = incoming && SAFE_ID.test(incoming) ? incoming : uuidv7();
  res.setHeader(HEADER, req.requestId);
  next();
};
