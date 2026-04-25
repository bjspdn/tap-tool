import type { Option } from "effect";

declare global {
  type Brand<T, B extends string> = T & { readonly __brand: B };
  type TaskId = Brand<string, "TaskId">;
  type StoryId = Brand<string, "StoryId">;
  type AbsolutePath = Brand<string, "AbsolutePath">;

  type TaskStatus = "pending" | "in_progress" | "done" | "failed";

  /** Lenient acceptance criterion: legacy plain string or dual-form struct. */
  type AcceptanceCriterion =
    | string
    | { readonly behavioral: string; readonly mechanism: Option<string> };

  interface Task {
    readonly id: TaskId;
    readonly title: string;
    readonly files: readonly AbsolutePath[];
    readonly acceptance: ReadonlyArray<AcceptanceCriterion>;
    readonly depends_on: readonly TaskId[];
    readonly status: TaskStatus;
    readonly attempts: number;
    readonly maxAttempts: number;
  }

  interface Story {
    readonly id: StoryId;
    readonly title: string;
    readonly acceptance: ReadonlyArray<AcceptanceCriterion>;
    readonly tasks: readonly Task[];
  }

  interface Feature {
    readonly feature: string;
    readonly goal: string;
    readonly constraints: readonly string[];
    readonly stories: readonly Story[];
  }
}

// Type-level assertion: Task and Story acceptance fields carry the dual-form union shape.
type _FeatureTypeMatches = {
  task: Task["acceptance"] extends ReadonlyArray<AcceptanceCriterion> ? true : never;
  story: Story["acceptance"] extends ReadonlyArray<AcceptanceCriterion> ? true : never;
};

// Allow AcceptanceCriterion values in toContain calls whose receiver is a string
// (i.e. checking rendered prompt output contains a criterion).  Adds a third
// overload without removing the two built-in ones; pre-existing string calls
// are unaffected.
declare module "bun:test" {
  interface Matchers<T> {
    toContain(
      expected: T extends Iterable<infer U>
        ? string extends U
          ? AcceptanceCriterion
          : U
        : T,
    ): void;
  }
}
