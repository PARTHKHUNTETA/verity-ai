import { Router, type RequestHandler } from "express";
import { z } from "zod";
import type { Database } from "../../infrastructure/database/client.js";
import { authenticate, getAuth } from "../../middleware/authenticate.js";
import { requirePermission } from "../../middleware/require-permission.js";
import { validate } from "../../middleware/validate.js";
import { requestMeta } from "../../shared/request-meta.js";
import { recordAudit } from "../audit/audit.repository.js";
import {
  createApprovalsService,
  type ApprovalDecisionInput,
  type ApprovalsDeps,
} from "./approvals.service.js";
import { getActivePolicy, listVersions, saveNewVersion } from "./policies.repository.js";
import {
  DEFAULT_POLICY_RULES,
  parseRules,
  policyRulesSchema,
  type PolicyRules,
} from "./policy-rules.js";

/** GET/PUT the organization's policy (owners and admins). */
export function policiesRoutes(db: Database): Router {
  const router = Router();
  router.use(authenticate(db), requirePermission("policy:manage"));

  const toDto = (p: Awaited<ReturnType<typeof getActivePolicy>>) => ({
    id: p.id,
    version: p.version,
    rules: parseRules(p.rules),
    createdBy: p.createdBy,
    createdAt: p.createdAt,
  });

  const getActive: RequestHandler = async (req, res) => {
    const policy = await getActivePolicy(db, getAuth(req).organizationId);
    res.json({ ...toDto(policy), defaults: DEFAULT_POLICY_RULES });
  };

  const versions: RequestHandler = async (req, res) => {
    res.json({ versions: await listVersions(db, getAuth(req).organizationId) });
  };

  const update: RequestHandler = async (req, res) => {
    const auth = getAuth(req);
    const { rules } = req.body as { rules: PolicyRules };
    const { previous, current } = await saveNewVersion(db, auth.organizationId, rules, auth.userId);
    await recordAudit(db, {
      organizationId: auth.organizationId,
      actorUserId: auth.userId,
      action: "policy.update",
      resourceType: "policy",
      resourceId: current.id,
      metadata: { fromVersion: previous.version, toVersion: current.version },
      meta: requestMeta(req),
    });
    res.json(toDto(current));
  };

  router.get("/active", getActive);
  router.get("/versions", versions);
  router.put("/active", validate({ body: z.object({ rules: policyRulesSchema }) }), update);
  return router;
}

const decisionSchema = z.object({
  decision: z.enum(["approve", "reject"]),
  comment: z.string().trim().max(500).optional(),
  newLimit: z.number().positive().optional(),
});

/** The approvals inbox (owners and admins: approval:decide). */
export function approvalsRoutes(db: Database, deps: ApprovalsDeps): Router {
  const service = createApprovalsService(db, deps);
  const router = Router();
  router.use(authenticate(db), requirePermission("approval:decide"));

  router.get(
    "/",
    validate({ query: z.object({ status: z.enum(["pending", "all"]).default("pending") }) }),
    async (req, res) => {
      const { status } = req.query as unknown as { status: "pending" | "all" };
      res.json({ approvals: await service.list(getAuth(req), status) });
    },
  );
  router.get("/count", async (req, res) => {
    res.json({ pending: await service.pendingCount(getAuth(req)) });
  });
  router.post(
    "/:approvalId/decision",
    validate({ params: z.object({ approvalId: z.uuid() }), body: decisionSchema }),
    async (req, res) => {
      res.json(
        await service.decide(
          getAuth(req),
          req.params.approvalId as string,
          req.body as ApprovalDecisionInput,
          requestMeta(req),
        ),
      );
    },
  );
  return router;
}
