import "express-serve-static-core";
import type { AuthContext } from "../modules/auth/auth.types.js";

declare module "express-serve-static-core" {
  interface Request {
    /** Set by the authenticate middleware. Use `getAuth(req)` to read it in handlers. */
    auth?: AuthContext;
  }
}
