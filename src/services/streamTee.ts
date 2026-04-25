import { Effect, Fiber, Stream, type Scope } from "effect";

/**
 * Forks a fiber that drains `source` element-by-element, mapping any
 * source error to the caller's domain error type before passing each item
 * to `handler`. Returns the forked fiber so callers can `Fiber.join` it.
 *
 * The fiber is scoped — callers must run inside an `Effect.scoped` block
 * (or otherwise provide a `Scope`) so the fiber is interrupted cleanly on
 * scope close.
 */
export const teeStream = <A, ESource, EOut, R>(
  source: Stream.Stream<A, ESource, R>,
  errorMapper: (cause: ESource) => EOut,
  handler: (item: A) => Effect.Effect<void, EOut, R>,
): Effect.Effect<Fiber.RuntimeFiber<void, EOut>, never, R | Scope.Scope> =>
  Effect.fork(
    Stream.runForEach(
      source.pipe(Stream.mapError(errorMapper)),
      handler,
    ),
  );
