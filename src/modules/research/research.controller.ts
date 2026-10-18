import type { RequestHandler } from "express";
import { getAuth } from "../../middleware/authenticate.js";
import type { CreateTaskInput } from "./research.schema.js";
import type { ResearchService } from "./research.service.js";

export function createResearchController(service: ResearchService) {
  const listTasks: RequestHandler = async (req, res) => {
    res.json({ tasks: await service.listTasks(getAuth(req)) });
  };

  const createTask: RequestHandler = async (req, res) => {
    res.status(201).json(await service.createTask(getAuth(req), req.body as CreateTaskInput));
  };

  const getTask: RequestHandler<{ taskId: string }> = async (req, res) => {
    res.json(await service.getTask(getAuth(req), req.params.taskId));
  };

  const startRun: RequestHandler<{ taskId: string }> = async (req, res) => {
    res.status(201).json(await service.startRun(getAuth(req), req.params.taskId));
  };

  const getRun: RequestHandler<{ runId: string }> = async (req, res) => {
    res.json(await service.getRunDetail(getAuth(req), req.params.runId));
  };

  const cancelRun: RequestHandler<{ runId: string }> = async (req, res) => {
    res.json(await service.cancel(getAuth(req), req.params.runId));
  };

  return { listTasks, createTask, getTask, startRun, getRun, cancelRun };
}
