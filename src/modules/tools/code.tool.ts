import {
  getQuickJS,
  shouldInterruptAfterDeadline,
  type QuickJSWASMModule,
} from "quickjs-emscripten";
import { z } from "zod";

/**
 * The code tool (docs/system-design.md §4.5): lets the agent compute things (counts, averages,
 * comparisons) instead of guessing numbers in prose.
 *
 * Model-written code is untrusted, so it runs in QuickJS compiled to WebAssembly: a separate
 * JavaScript engine with its own memory. There is no `require`, `process`, `fetch`, file system
 * or network inside; only what we inject: `data` (the run's evidence, as plain JSON), a few
 * statistics helpers, and `console.log`. A deadline and a memory cap stop runaway code.
 */

export const runCodeParameters = z.object({
  purpose: z.string().describe("One sentence: what this computation is for"),
  code: z
    .string()
    .describe(
      "JavaScript. The evidence is in `data`. The value of the last expression is the result. Helpers: sum, mean, median, stdev, min, max, round, countBy, groupBy, percent.",
    ),
});

export type RunCodeArgs = z.infer<typeof runCodeParameters>;

export type CodeResult =
  | { ok: true; result: unknown; logs: string[]; durationMs: number }
  | { ok: false; error: string; logs: string[]; durationMs: number };

export type SandboxOptions = {
  timeoutMs?: number;
  memoryBytes?: number;
  /** Results and logs are truncated to this many characters (they go back to the model). */
  maxOutputChars?: number;
};

const PRELUDE = `
const sum = (xs) => xs.reduce((a, b) => a + b, 0);
const mean = (xs) => (xs.length ? sum(xs) / xs.length : NaN);
const median = (xs) => {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b), m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const stdev = (xs) => { const m = mean(xs); return Math.sqrt(mean(xs.map((x) => (x - m) ** 2))); };
const min = (xs) => Math.min(...xs);
const max = (xs) => Math.max(...xs);
const round = (x, digits = 2) => Math.round(x * 10 ** digits) / 10 ** digits;
const countBy = (xs, key) => xs.reduce((acc, x) => {
  const k = typeof key === "function" ? key(x) : x[key];
  acc[k] = (acc[k] || 0) + 1; return acc;
}, {});
const groupBy = (xs, key) => xs.reduce((acc, x) => {
  const k = typeof key === "function" ? key(x) : x[key];
  (acc[k] = acc[k] || []).push(x); return acc;
}, {});
const percent = (part, whole) => (whole ? round((100 * part) / whole, 1) : 0);
`;

let quickjs: Promise<QuickJSWASMModule> | undefined;

export function createCodeSandbox({
  timeoutMs = 2000,
  memoryBytes = 32 * 1024 * 1024,
  maxOutputChars = 8000,
}: SandboxOptions = {}) {
  const truncate = (text: string) =>
    text.length > maxOutputChars ? `${text.slice(0, maxOutputChars)}… (truncated)` : text;

  return {
    async run(code: string, data: unknown): Promise<CodeResult> {
      const started = Date.now();
      const logs: string[] = [];
      quickjs ??= getQuickJS();
      const runtime = (await quickjs).newRuntime();
      runtime.setMemoryLimit(memoryBytes);
      runtime.setMaxStackSize(1024 * 1024);
      runtime.setInterruptHandler(shouldInterruptAfterDeadline(Date.now() + timeoutMs));
      const vm = runtime.newContext();

      try {
        // console.log → captured lines
        const log = vm.newFunction("log", (...args) => {
          if (logs.length < 100) logs.push(truncate(args.map((a) => format(vm.dump(a))).join(" ")));
        });
        const consoleObj = vm.newObject();
        vm.setProp(consoleObj, "log", log);
        vm.setProp(vm.global, "console", consoleObj);
        log.dispose();
        consoleObj.dispose();

        // Data goes in as a JSON literal: plain values only, nothing callable.
        const setup = vm.evalCode(`${PRELUDE}\nglobalThis.data = ${JSON.stringify(data ?? null)};`);
        if (setup.error) {
          const message = vm.dump(setup.error);
          setup.error.dispose();
          throw new Error(`Sandbox setup failed: ${format(message)}`);
        }
        setup.value.dispose();

        const evaluated = vm.evalCode(code, "analysis.js");
        if (evaluated.error) {
          const error = vm.dump(evaluated.error) as { name?: string; message?: string } | string;
          evaluated.error.dispose();
          const message =
            typeof error === "string" ? error : `${error.name ?? "Error"}: ${error.message ?? ""}`;
          return {
            ok: false,
            error: /interrupted/.test(message)
              ? `Timed out after ${timeoutMs} ms`
              : /out of memory/i.test(message)
                ? "Ran out of memory"
                : truncate(message),
            logs,
            durationMs: Date.now() - started,
          };
        }
        let result = vm.dump(evaluated.value);
        evaluated.value.dispose();
        if (result === undefined) {
          // Allow `result = …` as an alternative to a final expression.
          const fallback = vm.getProp(vm.global, "result");
          result = vm.dump(fallback);
          fallback.dispose();
        }
        const serialized = JSON.stringify(result ?? null);
        return {
          ok: true,
          result: serialized.length > maxOutputChars ? truncate(serialized) : (result ?? null),
          logs,
          durationMs: Date.now() - started,
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          ok: false,
          error: /out of memory/i.test(message) ? "Ran out of memory" : truncate(message),
          logs,
          durationMs: Date.now() - started,
        };
      } finally {
        vm.dispose();
        runtime.dispose();
      }
    },
  };
}

export type CodeSandbox = ReturnType<typeof createCodeSandbox>;

function format(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value);
}
