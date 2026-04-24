#!/usr/bin/env bun
/**
 * Bootstrap driver — ad-hoc replacement for the LoopRunner service until it
 * lands as a proper Effect Tag + Layer. Drives one feature's task list through
 * `runTask` one task at a time, updating FEATURE_CONTRACT.json on disk between
 * tasks.
 *
 * Usage: bun run scripts/bootstrap.ts <feature-slug>
 *
 * Known limitations (all resolved when the real LoopRunner lands):
 *   - No Schema validation on the contract (trusts the JSON shape).
 *   - No priorEval threading on retries — runTask still defaults to None.
 *   - No gitStatus population — runTask still defaults to "".
 *   - No atomic writes — crash mid-save can leave a half-written contract.
 *   - Hard stop after one failed task (no skip-and-continue).
 */

import { Effect, Layer, Match, Option } from "effect";
import * as path from "node:path";
import { FileSystem } from "@effect/platform";
import { BunContext } from "@effect/platform-bun";
import { ContextEngineLive } from "../src/services/ContextEngine";
import { EvalParserLive } from "../src/services/EvalParser";
import { AgentRunnerLive } from "../src/services/AgentRunner";
import { runTask } from "../src/services/RunTask";
import { brand } from "../src/services/brand";

// ---------------------------------------------------------------------------
// CLI entry
// ---------------------------------------------------------------------------

const featureSlug = process.argv[2];
if (!featureSlug) {
  console.error("usage: bun run scripts/bootstrap.ts <feature-slug>");
  process.exit(1);
}

const FEATURE_ROOT = path.resolve(process.cwd(), `.tap/features/${featureSlug}`);
const CONTRACT_PATH = path.resolve(FEATURE_ROOT, "FEATURE_CONTRACT.json");
const SPECS_PATH = path.resolve(FEATURE_ROOT, "SPECS.md");
const MAX_ITERATIONS = 100;

// ---------------------------------------------------------------------------
// Error formatting
// ---------------------------------------------------------------------------

const formatRunTaskError = Match.type<RunTaskError>().pipe(
  Match.tag("AgentSpawnFailed", (e) => `spawn failed [${e.role}]: exit ${e.exitCode} — ${e.stderr}`),
  Match.tag("AgentMaxTurnsExceeded", (e) => `agent max turns exceeded [${e.role}]`),
  Match.tag("EvalResultMissing", (e) => `eval result missing: ${e.expectedPath}`),
  Match.tag("EvalParseFailed", (e) => `eval parse failed: ${e.reason}`),
  Match.tag("TemplateRenderFailed", (e) => `template render failed [${e.template}]: missing key "${e.missingKey}"`),
  Match.tag("FilesystemError", (e) => `filesystem error at ${e.path}: ${String(e.cause)}`),
  Match.exhaustive,
);

// ---------------------------------------------------------------------------
// Contract I/O (no Schema — a proper FeatureContract service will replace this)
// ---------------------------------------------------------------------------

const loadContract = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const raw = yield* fs.readFileString(CONTRACT_PATH);
  return JSON.parse(raw) as Feature;
});

const saveContract = (feature: Feature) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    yield* fs.writeFileString(
      CONTRACT_PATH,
      JSON.stringify(feature, null, 2) + "\n",
    );
  });

// ---------------------------------------------------------------------------
// Topo pick: first task whose depends_on are all done, status pending or
// in_progress, and attempts < maxAttempts
// ---------------------------------------------------------------------------

const findReadyTask = (feature: Feature): Option.Option<Task> => {
  const allTasks = feature.stories.flatMap((s) => s.tasks);
  const doneIds = new Set(
    allTasks.filter((t) => t.status === "done").map((t) => t.id),
  );
  const ready = allTasks.find(
    (t) =>
      (t.status === "pending" || t.status === "in_progress") &&
      t.attempts < t.maxAttempts &&
      t.depends_on.every((dep) => doneIds.has(dep)),
  );
  return ready ? Option.some(ready) : Option.none();
};

const updateTask = (
  feature: Feature,
  taskId: TaskId,
  patch: Partial<Task>,
): Feature => ({
  ...feature,
  stories: feature.stories.map((s) => ({
    ...s,
    tasks: s.tasks.map((t) => (t.id === taskId ? { ...t, ...patch } : t)),
  })),
});

// ---------------------------------------------------------------------------
// Main driver loop
// ---------------------------------------------------------------------------

const driver = Effect.gen(function* () {
  let feature = yield* loadContract;
  console.log(`[bootstrap] loaded ${featureSlug}`);

  for (let iteration = 1; iteration <= MAX_ITERATIONS; iteration++) {
    const next = findReadyTask(feature);
    if (Option.isNone(next)) {
      console.log("[bootstrap] no ready tasks — stopping");
      return;
    }
    const task = next.value;
    const attempt = task.attempts + 1;
    console.log(
      `[bootstrap] iter ${iteration} — task ${task.id} "${task.title}" attempt ${attempt}/${task.maxAttempts}`,
    );

    feature = updateTask(feature, task.id, {
      status: "in_progress",
      attempts: attempt,
    });
    yield* saveContract(feature);

    const outcome = yield* runTask(task, feature, {
      featureRoot: brand<"AbsolutePath">(FEATURE_ROOT),
      specsPath: brand<"AbsolutePath">(SPECS_PATH),
      contractPath: brand<"AbsolutePath">(CONTRACT_PATH),
      attempt,
    }).pipe(
      Effect.match({
        onFailure: (err) => ({ kind: "error" as const, err }),
        onSuccess: (result) => ({ kind: "result" as const, result }),
      }),
    );

    if (outcome.kind === "error") {
      console.error(
        `[bootstrap] task ${task.id} pipeline error:`,
        formatRunTaskError(outcome.err),
      );
      if (attempt >= task.maxAttempts) {
        feature = updateTask(feature, task.id, { status: "failed" });
        yield* saveContract(feature);
        console.error(
          `[bootstrap] task ${task.id} exhausted attempts — halting`,
        );
        return;
      }
      continue;
    }

    const { result } = outcome;
    if (result.verdict === "PASS") {
      feature = updateTask(feature, task.id, { status: "done" });
      yield* saveContract(feature);
      console.log(
        `[bootstrap] task ${task.id} PASS (${result.durationMs}ms)`,
      );
      continue;
    }

    console.log(
      `[bootstrap] task ${task.id} FAIL — ${result.issues.length} issues`,
    );
    for (const issue of result.issues) {
      console.log(
        `  · [${issue.file}] ${issue.acceptanceFailed}: ${issue.problem}`,
      );
    }
    if (attempt >= task.maxAttempts) {
      feature = updateTask(feature, task.id, { status: "failed" });
      yield* saveContract(feature);
      console.error(
        `[bootstrap] task ${task.id} exhausted attempts — halting`,
      );
      return;
    }
  }

  console.error(
    `[bootstrap] hit MAX_ITERATIONS (${MAX_ITERATIONS}) safety stop`,
  );
});

// ---------------------------------------------------------------------------
// Layer composition: real ContextEngineLive + EvalParserLive + AgentRunnerLive
// on top of BunContext (provides FileSystem + CommandExecutor).
// ---------------------------------------------------------------------------

const appLayer = Layer.mergeAll(
  ContextEngineLive,
  EvalParserLive,
  AgentRunnerLive,
).pipe(Layer.provideMerge(BunContext.layer));

await Effect.runPromise(driver.pipe(Effect.provide(appLayer)));
