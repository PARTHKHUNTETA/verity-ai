import "http";

declare module "http" {
  interface IncomingMessage {
    /** Set by the request-id middleware; also used by logs and (later) traces. */
    requestId: string;
  }
}
