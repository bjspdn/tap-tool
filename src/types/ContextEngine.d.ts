import type { Option } from "effect";

declare global {
  type ComposerRenderInput = {
    readonly task: Task;
    readonly feature: Feature;
    readonly specsPath: AbsolutePath;
    readonly contractPath: AbsolutePath;
    readonly attempt: number;
    readonly priorEval: Option.Option<AbsolutePath>;
    readonly gitStatus: string;
  };

  type ReviewerRenderInput = {
    readonly task: Task;
    readonly feature: Feature;
    readonly specsPath: AbsolutePath;
    readonly contractPath: AbsolutePath;
    readonly attempt: number;
    readonly evalPath: AbsolutePath;
  };

  type TemplateRenderError = {
    readonly _tag: "TemplateRenderFailed";
    readonly template: string;
    readonly missingKey: string;
  };
}
