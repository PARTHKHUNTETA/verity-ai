export type HealthStatus = {
  status: "ok" | "degraded";
  db: "ok" | "error";
  uptimeSeconds: number;
  timestamp: string;
};

export type HealthDependencies = {
  pingDatabase: () => Promise<void>;
};

export function createHealthService({ pingDatabase }: HealthDependencies) {
  return {
    async check(): Promise<HealthStatus> {
      let db: HealthStatus["db"] = "ok";
      try {
        await pingDatabase();
      } catch {
        db = "error";
      }
      return {
        status: db === "ok" ? "ok" : "degraded",
        db,
        uptimeSeconds: Math.round(process.uptime()),
        timestamp: new Date().toISOString(),
      };
    },
  };
}

export type HealthService = ReturnType<typeof createHealthService>;
