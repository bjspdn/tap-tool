import { Context, Effect, Layer, Option, Ref } from "effect";
import { Terminal } from "@effect/platform";
import { renderFrame } from "./renderFrame";

// ---------------------------------------------------------------------------
// ANSI constants
// ---------------------------------------------------------------------------

const CURSOR_HOME = "\x1b[H";
const ERASE_DOWN = "\x1b[J";
const HIDE_CURSOR = "\x1b[?25l";
const SHOW_CURSOR = "\x1b[?25h";

// ---------------------------------------------------------------------------
// Dashboard service
// ---------------------------------------------------------------------------

/**
 * Service that drives the terminal dashboard.
 *
 * In TTY mode: renders full-screen ANSI frames at ~200ms intervals.
 * Pressing `q` quits the dashboard early.
 *
 * In non-TTY mode: emits plain status lines to stdout whenever state
 * changes, and a final line when the loop terminates.
 */
export class Dashboard extends Context.Tag("Dashboard")<
  Dashboard,
  {
    /** Run the dashboard until the loop completes or the user presses `q`. */
    readonly run: (ref: Ref.Ref<DashboardState>) => Effect.Effect<void>;
  }
>() {}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

const REFRESH_MS = 200;

/**
 * Non-TTY fallback: emit plain text status lines, exiting when
 * `stoppedReason` becomes `Some`.
 */
const nonTtyLoop = (
  ref: Ref.Ref<DashboardState>,
  terminal: Terminal.Terminal,
): Effect.Effect<void> =>
  Effect.gen(function* () {
    let lastLine = "";
    yield* Effect.iterate(false, {
      while: (done) => !done,
      body: () =>
        Effect.gen(function* () {
          const state = yield* Ref.get(ref);
          const taskLine = `done=${state.totals.tasksDone} failed=${state.totals.tasksFailed} pending=${state.totals.tasksPending}`;
          const line = `[tap run ${state.feature}] ${taskLine}`;
          if (line !== lastLine) {
            yield* terminal.display(line + "\n").pipe(Effect.orDie);
            lastLine = line;
          }
          if (Option.isSome(state.stoppedReason)) {
            yield* terminal
              .display(`[tap] finished: ${state.stoppedReason.value._tag}\n`)
              .pipe(Effect.orDie);
            return true;
          }
          yield* Effect.sleep(REFRESH_MS);
          return false;
        }),
    });
  });

/**
 * TTY mode: full ANSI dashboard with keyboard quit support.
 *
 * Hides the cursor on entry; restores it via finalizer on exit.
 * Races the render loop against a `q`-key watcher — whichever
 * completes first wins and interrupts the other.
 */
const ttyLoop = (
  ref: Ref.Ref<DashboardState>,
  terminal: Terminal.Terminal,
): Effect.Effect<void> =>
  Effect.scoped(
    Effect.gen(function* () {
      // Hide cursor; show it again when the scope closes.
      yield* terminal.display(HIDE_CURSOR).pipe(Effect.orDie);
      yield* Effect.addFinalizer(() =>
        terminal.display(SHOW_CURSOR).pipe(Effect.orDie),
      );

      // Render one frame from current state.
      const renderOnce: Effect.Effect<DashboardState> = Effect.gen(
        function* () {
          const state = yield* Ref.get(ref);
          const cols = yield* terminal.columns;
          const frame = renderFrame(state, Math.max(20, cols));
          yield* terminal.display(CURSOR_HOME + ERASE_DOWN + frame).pipe(Effect.orDie);
          return state;
        },
      );

      // Render loop — exits when `stoppedReason` becomes `Some`.
      const renderLoop: Effect.Effect<boolean> = Effect.iterate(false, {
        while: (done) => !done,
        body: () =>
          Effect.gen(function* () {
            const state = yield* renderOnce;
            if (Option.isSome(state.stoppedReason)) return true;
            yield* Effect.sleep(REFRESH_MS);
            return false;
          }),
      });

      // Quit loop — exits when the user presses `q`.
      // Wraps `terminal.readInput` in its own scope so the keypress listener
      // is cleaned up as soon as the quit loop exits (or is interrupted).
      const quitOnQ: Effect.Effect<void> = Effect.scoped(
        Effect.gen(function* () {
          const mailbox = yield* terminal.readInput;
          yield* Effect.iterate(false, {
            while: (done) => !done,
            body: () =>
              Effect.gen(function* () {
                const input = yield* mailbox.take;
                return input.key.name === "q";
              }),
          });
        }),
      ).pipe(
        // `mailbox.take` fails with `NoSuchElementException` when the
        // mailbox is closed (ctrl+c / ctrl+d) — treat that as quit too.
        Effect.catchTag("NoSuchElementException", () => Effect.void),
      );

      // Race: first to finish wins; loser is interrupted.
      yield* Effect.race(renderLoop, quitOnQ);

      // Render one final frame so the terminal shows the last state.
      const finalState = yield* Ref.get(ref);
      const cols = yield* terminal.columns;
      yield* terminal
        .display(
          CURSOR_HOME +
            ERASE_DOWN +
            renderFrame(finalState, Math.max(20, cols)) +
            "\n",
        )
        .pipe(Effect.orDie);
    }),
  );

// ---------------------------------------------------------------------------
// Live layer
// ---------------------------------------------------------------------------

/**
 * Live `Layer` for the Dashboard service.
 *
 * Requires `Terminal.Terminal` from `@effect/platform` — wire
 * `BunTerminal.layer` (or equivalent) in the application's main layer.
 */
export const DashboardLive: Layer.Layer<Dashboard, never, Terminal.Terminal> =
  Layer.effect(
    Dashboard,
    Effect.gen(function* () {
      const terminal = yield* Terminal.Terminal;
      const isTTY = yield* terminal.isTTY;

      return Dashboard.of({
        run: (ref) =>
          isTTY ? ttyLoop(ref, terminal) : nonTtyLoop(ref, terminal),
      });
    }),
  );
