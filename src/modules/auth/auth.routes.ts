import { Router } from "express";
import type { Database } from "../../infrastructure/database/client.js";
import { authenticate } from "../../middleware/authenticate.js";
import { credentialsRateLimit, sessionRateLimit } from "../../middleware/rate-limit.js";
import { validate } from "../../middleware/validate.js";
import { createAuthController } from "./auth.controller.js";
import { loginSchema, registerSchema } from "./auth.schema.js";
import { createAuthService } from "./auth.service.js";

export function authRoutes(db: Database): { auth: Router; me: Router } {
  const controller = createAuthController(createAuthService(db));

  const auth = Router();
  auth.post(
    "/register",
    credentialsRateLimit,
    validate({ body: registerSchema }),
    controller.register,
  );
  auth.post("/login", credentialsRateLimit, validate({ body: loginSchema }), controller.login);
  auth.post("/refresh", sessionRateLimit, controller.refresh);
  auth.post("/logout", sessionRateLimit, controller.logout);

  const me = Router();
  me.get("/", authenticate(db), controller.me);

  return { auth, me };
}
