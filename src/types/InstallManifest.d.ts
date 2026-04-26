/** Persisted at .tap/manifest.json — written last during init, read first during update/remove. */
interface InstallManifest {
  readonly version: string;
  readonly files: string[];
}

type ScaffoldError =
  | { readonly _tag: "ManifestReadFailed"; readonly path: string; readonly cause: unknown }
  | { readonly _tag: "ManifestWriteFailed"; readonly path: string; readonly cause: unknown }
  | { readonly _tag: "FileCopyFailed"; readonly src: string; readonly dest: string; readonly cause: unknown }
  | { readonly _tag: "ConfirmationDeclined" };
