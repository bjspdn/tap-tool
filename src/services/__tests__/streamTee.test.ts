import { describe, test, expect } from "bun:test";
import { Effect, Exit, Fiber, Stream } from "effect";
import { teeStream } from "../streamTee";

describe("teeStream", () => {
  test("happy path: 3-item stream, all items processed, fiber completes", async () => {
    const collected: number[] = [];

    const program = Effect.scoped(
      Effect.gen(function* () {
        const source = Stream.fromIterable([1, 2, 3]);
        const fiber = yield* teeStream(
          source,
          (cause: never) => cause,
          (item) => Effect.sync(() => { collected.push(item); }),
        );
        yield* Fiber.join(fiber);
      }),
    );

    const exit = await Effect.runPromiseExit(program);
    expect(Exit.isSuccess(exit)).toBe(true);
    expect(collected).toEqual([1, 2, 3]);
  });

  test("error path: stream fails, handler never called, joined fiber carries mapped error", async () => {
    const collected: number[] = [];

    const program = Effect.scoped(
      Effect.gen(function* () {
        const source = Stream.fail("stream-error");
        const fiber = yield* teeStream(
          source,
          (cause: string) => ({ _tag: "MappedError" as const, cause }),
          (item: never) => Effect.sync(() => { collected.push(item); }),
        );
        return yield* Fiber.join(fiber);
      }),
    );

    const exit = await Effect.runPromiseExit(program);
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      // The failure channel carries our mapped error
      const cause = exit.cause;
      // Cause.fail wraps the mapped error — check its _tag
      expect(JSON.stringify(cause)).toContain("MappedError");
      expect(JSON.stringify(cause)).toContain("stream-error");
    }
    // Handler was never invoked
    expect(collected).toHaveLength(0);
  });
});
