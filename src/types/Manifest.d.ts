type ManifestEntry = {
  readonly path: string;
  readonly reason: string;
  readonly module?: string;
};

type ScoutManifest = {
  readonly targets: ReadonlyArray<ManifestEntry>;
  readonly context: ReadonlyArray<ManifestEntry>;
};
