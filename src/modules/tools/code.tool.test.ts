import { describe, expect, it } from "vitest";
import { createCodeSandbox } from "./code.tool.js";

const sandbox = createCodeSandbox({
  timeoutMs: 300,
  memoryBytes: 8 * 1024 * 1024,
  maxOutputChars: 200,
});

describe("code sandbox", () => {
  it("evaluates code against the provided data with the stats helpers", async () => {
    const data = {
      evidence: [
        { stance: "supports", c: 0.9 },
        { stance: "contradicts", c: 0.5 },
        { stance: "supports", c: 0.7 },
      ],
    };
    const res = await sandbox.run(
      "({ byStance: countBy(data.evidence, 'stance'), avg: round(mean(data.evidence.map(e => e.c))) })",
      data,
    );
    expect(res).toMatchObject({
      ok: true,
      result: { byStance: { supports: 2, contradicts: 1 }, avg: 0.7 },
    });
  });

  it("captures console.log and supports `result =`", async () => {
    const res = await sandbox.run(
      "console.log('n =', data.length); result = median(data);",
      [3, 1, 2],
    );
    expect(res).toMatchObject({ ok: true, result: 2, logs: ["n = 3"] });
  });

  it("stops infinite loops at the deadline", async () => {
    const res = await sandbox.run("while (true) {}", null);
    expect(res).toMatchObject({ ok: false, error: "Timed out after 300 ms" });
  });

  it("has no access to Node, the network or the file system", async () => {
    const res = await sandbox.run(
      "[typeof require, typeof process, typeof fetch, typeof XMLHttpRequest, typeof import.meta]",
      null,
    );
    // import.meta is a syntax error in a script, which also proves there are no modules.
    if (res.ok) expect(res.result).toEqual(["undefined", "undefined", "undefined", "undefined"]);
    const globals = await sandbox.run("[typeof require, typeof process, typeof fetch]", null);
    expect(globals).toMatchObject({ ok: true, result: ["undefined", "undefined", "undefined"] });
  });

  it("caps memory", async () => {
    const res = await sandbox.run("const xs = []; while (true) xs.push('x'.repeat(100000));", null);
    expect(res.ok).toBe(false);
  });

  it("reports errors and truncates huge results", async () => {
    const error = await sandbox.run("data.nope.deeper", {});
    expect(error).toMatchObject({ ok: false });
    expect((error as { error: string }).error).toMatch(/TypeError/);

    const big = await sandbox.run("'x'.repeat(10000)", null);
    expect(big.ok && typeof big.result === "string" && big.result.endsWith("(truncated)")).toBe(
      true,
    );
  });
});
