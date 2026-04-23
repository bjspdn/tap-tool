type RenderInput = {
  readonly task: Task;
  readonly feature: Feature;
  readonly specsPath: AbsolutePath;
  readonly contractPath: AbsolutePath;
  readonly featureRoot: AbsolutePath;
  readonly attempt: number;
  readonly priorEvalPath: AbsolutePath | null;
  readonly gitStatus: string;
};

type TemplateRenderError = {
  readonly _tag: "TemplateRenderFailed";
  readonly template: string;
  readonly missingKey: string;
};
