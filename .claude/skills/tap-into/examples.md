# Interview Examples

Worked examples of the tap-into core loop. Narrative, not rules.

## Rich-seed example

User: "I want to add a rate limiter to the API. Something to protect us from clients that get stuck in a loop or start hammering endpoints. Not totally sure on the shape yet — per-user maybe, maybe per-IP."

Seed is rich enough to research. Launch parallel research in a single message:

- `Explore`: "Find how the API is wired — entry points, middleware chain, handler locations. Medium thoroughness."
- `Explore`: "Any existing rate-limiting, throttling, or per-user counting code? Search: limit, throttle, quota, bucket."
- `Explore`: "Repo uses `hono` (package.json). Read `node_modules/hono/` middleware module. Report exported surface and any built-in rate-limit primitive."
- `general-purpose`: "Short report (<300 words): standard HTTP rate limiting approaches (token bucket, fixed window, sliding window), tradeoffs, expected headers (`X-RateLimit-*`, `Retry-After`)."

All four concurrent. Once returned, synthesize:

> "Middleware chain lives in `src/server/middleware.ts`, `withAuth` runs before handlers — limiter can key off `userId`. Hono has no built-in limiter. Cheap standard approach: fixed-window counter in memory, upgrade to token bucket only if smoother pacing needed."

Interview resumes, informed:

- "In-memory per-process, or shared store like Redis?"
- "Per-IP, per-user, per-API-key?"
- "On limit hit: 429 + `Retry-After` + `X-RateLimit-*`, silent drop, queue?"
- "Failure mode — abuse, runaway client, accidental loop?"

...many more turns, possibly more research rounds...

Converge → emit → iterate until sign-off.

## Thin-seed example

User: "I want to add some kind of caching."

Seed fails research-readiness — no file, module, or concept named. Ask one narrow question:

> "What's the thing you'd be caching? Even a rough pointer — 'the results of the `X` endpoint', 'database reads in `Z` module' — gets us to something researchable."

Don't launch subagents on bare "caching" — they'd return generic surveys, burning context without narrowing. One clarification from the user is worth more than four Explores here.

Once user names target (e.g. "results of `getUserFeed`"), normal parallel-research kicks in.

## Deflection example

User keeps redirecting: "Just make it work, I'll figure out the why later."

Don't force intent. Record what user stated, infer from codebase, continue on shape/boundaries/failure-modes. Intent gaps become `<spec:open_questions>` at emit: "User deferred explicit intent; inferred from context as `X`." Interview is conversation, not interrogation.
