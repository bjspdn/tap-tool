/**
 * Runtime helper for constructing branded string values (e.g. `AbsolutePath`,
 * `TaskId`). The single `as` cast lives here; every caller gets a type-safe
 * construction without re-casting.
 */
export const brand = <B extends string>(s: string): string & { readonly __brand: B } =>
  s as string & { readonly __brand: B };
