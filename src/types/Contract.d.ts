type Brand<T, B extends string> = T & { readonly __brand: B };
type TaskId = Brand<string, "TaskId">;
type StoryId = Brand<string, "StoryId">;
type AbsolutePath = Brand<string, "AbsolutePath">;

type TaskStatus = "pending" | "in_progress" | "done" | "failed";

interface Task {
  readonly id: TaskId;
  readonly title: string;
  readonly files: readonly AbsolutePath[];
  readonly acceptance: readonly string[];
  readonly depends_on: readonly TaskId[];
  readonly status: TaskStatus;
  readonly attempts: number;
  readonly maxAttempts: number;
}

interface Story {
  readonly id: StoryId;
  readonly title: string;
  readonly acceptance: readonly string[];
  readonly tasks: readonly Task[];
}

interface Feature {
  readonly feature: string;
  readonly goal: string;
  readonly constraints: readonly string[];
  readonly stories: readonly Story[];
}
