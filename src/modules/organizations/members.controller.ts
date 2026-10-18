import type { RequestHandler } from "express";
import { getAuth } from "../../middleware/authenticate.js";
import { requestMeta } from "../../shared/request-meta.js";
import type { AddMemberInput, ChangeRoleInput } from "./members.schema.js";
import type { MembersService } from "./members.service.js";

export function createMembersController(service: MembersService) {
  const getOrganization: RequestHandler = async (req, res) => {
    res.json(await service.getOrganization(getAuth(req)));
  };

  const list: RequestHandler = async (req, res) => {
    res.json({ members: await service.list(getAuth(req)) });
  };

  const add: RequestHandler = async (req, res) => {
    const member = await service.add(getAuth(req), req.body as AddMemberInput, requestMeta(req));
    res.status(201).json(member);
  };

  const changeRole: RequestHandler<{ userId: string }> = async (req, res) => {
    const { role } = req.body as ChangeRoleInput;
    await service.changeRole(getAuth(req), req.params.userId, role, requestMeta(req));
    res.status(204).end();
  };

  const remove: RequestHandler<{ userId: string }> = async (req, res) => {
    await service.remove(getAuth(req), req.params.userId, requestMeta(req));
    res.status(204).end();
  };

  return { getOrganization, list, add, changeRole, remove };
}
