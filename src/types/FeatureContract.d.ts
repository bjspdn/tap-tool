type FeatureContractError =
  | { readonly _tag: "ContractReadFailed"; readonly path: AbsolutePath; readonly cause: unknown }
  | { readonly _tag: "ContractInvalidJson"; readonly path: AbsolutePath; readonly cause: unknown }
  | { readonly _tag: "ContractSchemaFailed"; readonly path: AbsolutePath; readonly issues: string }
  | { readonly _tag: "ContractCycleDetected"; readonly path: AbsolutePath; readonly cycle: ReadonlyArray<TaskId> }
  | { readonly _tag: "ContractWriteFailed"; readonly path: AbsolutePath; readonly cause: unknown };
