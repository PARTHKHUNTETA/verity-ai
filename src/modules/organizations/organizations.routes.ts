import { Router } from "express";
import type { Database } from "../../infrastructure/database/client.js";
import { authenticate } from "../../middleware/authenticate.js";
import { requirePermission } from "../../middleware/require-permission.js";
import { validate } from "../../middleware/validate.js";
import { createMembersController } from "./members.controller.js";
import { addMemberSchema, changeRoleSchema, memberParamsSchema } from "./members.schema.js";
import { createMembersService } from "./members.service.js";

/** Everything here acts on the caller's current organization (from their access token). */
export function organizationRoutes(db: Database): Router {
  const controller = createMembersController(createMembersService(db));
  const router = Router();

  router.use(authenticate(db));

  router.get("/", requirePermission("member:read"), controller.getOrganization);
  router.get("/members", requirePermission("member:read"), controller.list);
  router.post(
    "/members",
    requirePermission("member:manage"),
    validate({ body: addMemberSchema }),
    controller.add,
  );
  router.patch(
    "/members/:userId",
    requirePermission("member:manage"),
    validate({ params: memberParamsSchema, body: changeRoleSchema }),
    controller.changeRole,
  );
  router.delete(
    "/members/:userId",
    requirePermission("member:manage"),
    validate({ params: memberParamsSchema }),
    controller.remove,
  );

  return router;
}
