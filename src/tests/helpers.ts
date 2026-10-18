import { sql } from "drizzle-orm";
import request from "supertest";
import { createApp } from "../app.js";
import { db, pingDatabase } from "../infrastructure/database/client.js";
import { createInMemoryRunEventBus } from "../infrastructure/events/run-events.js";

/** Records enqueued run ids instead of using pg-boss. */
export const fakeQueue = {
  enqueued: [] as string[],
  async enqueueResearchRun(runId: string) {
    this.enqueued.push(runId);
  },
};

/** In-process event bus; `testEvents.published` lists every event. */
export const testEvents = createInMemoryRunEventBus();

export const testResearchDeps = { queue: fakeQueue, events: testEvents, model: "fake-model" };

export const app = createApp({ db, pingDatabase, research: testResearchDeps });

/** Empties every app table between tests (keeps the schema and migration history). */
export async function resetDatabase(): Promise<void> {
  await db.execute(
    sql`truncate table reports, agent_steps, research_runs, research_tasks, audit_logs, refresh_tokens, organization_members, users, organizations restart identity cascade`,
  );
  fakeQueue.enqueued.length = 0;
  testEvents.published.length = 0;
}

export const PASSWORD = "correct-horse-battery";

/** Extracts "verity_refresh=<value>" from a response's Set-Cookie header. */
export function refreshCookie(res: request.Response): string {
  const header = res.headers["set-cookie"] as unknown as string[] | undefined;
  const cookie = header?.find((c) => c.startsWith("verity_refresh="));
  if (!cookie) throw new Error("No refresh cookie in response");
  return cookie.split(";")[0]!;
}

export type TestSession = {
  accessToken: string;
  cookie: string;
  userId: string;
  organizationId: string;
  email: string;
};

export async function registerUser(
  email: string,
  organizationName = `${email.split("@")[0]} org`,
): Promise<TestSession> {
  const res = await request(app)
    .post("/api/v1/auth/register")
    .send({ email, password: PASSWORD, organizationName });
  if (res.status !== 201)
    throw new Error(`register failed: ${res.status} ${JSON.stringify(res.body)}`);
  return {
    accessToken: res.body.accessToken,
    cookie: refreshCookie(res),
    userId: res.body.user.id,
    organizationId: res.body.organization.id,
    email,
  };
}

export async function login(email: string, organizationId?: string): Promise<TestSession> {
  const res = await request(app)
    .post("/api/v1/auth/login")
    .send({ email, password: PASSWORD, organizationId });
  if (res.status !== 200)
    throw new Error(`login failed: ${res.status} ${JSON.stringify(res.body)}`);
  return {
    accessToken: res.body.accessToken,
    cookie: refreshCookie(res),
    userId: res.body.user.id,
    organizationId: res.body.organization.id,
    email,
  };
}

export const bearer = (s: { accessToken: string }) => `Bearer ${s.accessToken}`;
