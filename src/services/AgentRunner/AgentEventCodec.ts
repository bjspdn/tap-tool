import { Effect, ParseResult, Schema } from "effect";

// ---------------------------------------------------------------------------
// ContentBlock schemas
// ---------------------------------------------------------------------------

const ContentBlockTextSchema = Schema.Struct({
  type: Schema.Literal("text"),
  text: Schema.String,
});

const ContentBlockThinkingSchema = Schema.Struct({
  type: Schema.Literal("thinking"),
  thinking: Schema.String,
  signature: Schema.optional(Schema.String),
});

const ContentBlockRedactedThinkingSchema = Schema.Struct({
  type: Schema.Literal("redacted_thinking"),
  data: Schema.String,
});

const ContentBlockToolUseSchema = Schema.Struct({
  type: Schema.Literal("tool_use"),
  id: Schema.String,
  name: Schema.String,
  input: Schema.Unknown,
});

const ContentBlockToolResultSchema = Schema.Struct({
  type: Schema.Literal("tool_result"),
  tool_use_id: Schema.String,
  content: Schema.Union(
    Schema.String,
    Schema.Array(
      Schema.Struct({ type: Schema.Literal("text"), text: Schema.String }),
    ),
  ),
  is_error: Schema.optional(Schema.Boolean),
});

const ContentBlockSchema = Schema.Union(
  ContentBlockTextSchema,
  ContentBlockThinkingSchema,
  ContentBlockRedactedThinkingSchema,
  ContentBlockToolUseSchema,
  ContentBlockToolResultSchema,
);

// ---------------------------------------------------------------------------
// AgentEvent variant schemas
// ---------------------------------------------------------------------------

// system — extra unknown fields preserved via the TypeLiteral index-signature overload
const AgentEventSystemSchema = Schema.Struct(
  {
    type: Schema.Literal("system"),
    subtype: Schema.optional(Schema.String),
    session_id: Schema.optional(Schema.String),
    model: Schema.optional(Schema.String),
    tools: Schema.optional(Schema.Array(Schema.String)),
  },
  Schema.Record({ key: Schema.String, value: Schema.Unknown }),
);

const AgentEventAssistantSchema = Schema.Struct({
  type: Schema.Literal("assistant"),
  session_id: Schema.optional(Schema.String),
  message: Schema.Struct({
    id: Schema.optional(Schema.String),
    role: Schema.Literal("assistant"),
    content: Schema.Array(ContentBlockSchema),
    model: Schema.optional(Schema.String),
  }),
});

const AgentEventUserSchema = Schema.Struct({
  type: Schema.Literal("user"),
  session_id: Schema.optional(Schema.String),
  message: Schema.Struct({
    role: Schema.Literal("user"),
    content: Schema.Array(ContentBlockSchema),
  }),
});

const AgentEventResultSchema = Schema.Struct({
  type: Schema.Literal("result"),
  subtype: Schema.String,
  is_error: Schema.Boolean,
  num_turns: Schema.Number,
  session_id: Schema.optional(Schema.String),
  total_cost_usd: Schema.optional(Schema.Number),
  result: Schema.optional(Schema.String),
  usage: Schema.optional(
    Schema.Struct({
      input_tokens: Schema.optional(Schema.Number),
      output_tokens: Schema.optional(Schema.Number),
    }),
  ),
});

// ---------------------------------------------------------------------------
// AgentEventSchema (exported — used by the roundtrip test)
// ---------------------------------------------------------------------------

/**
 * Schema for the AgentEvent discriminated union.
 * Extra fields on the `system` variant are preserved via an index signature.
 * The cast is sound: the four variant schemas structurally satisfy AgentEvent.
 */
export const AgentEventSchema: Schema.Schema<AgentEvent, unknown> =
  Schema.Union(
    AgentEventSystemSchema,
    AgentEventAssistantSchema,
    AgentEventUserSchema,
    AgentEventResultSchema,
  ) as Schema.Schema<AgentEvent, unknown>;

// ---------------------------------------------------------------------------
// decodeAgentEventLine
// ---------------------------------------------------------------------------

/**
 * Decodes a single NDJSON line into an AgentEvent.
 * Trims whitespace first; dies (invariant violation) on empty input.
 * Fails with `ParseResult.ParseError` on JSON parse failure or schema mismatch.
 */
export const decodeAgentEventLine = (
  line: string,
): Effect.Effect<AgentEvent, ParseResult.ParseError> => {
  const trimmed = line.trim();
  if (trimmed === "") {
    return Effect.die(new Error("decodeAgentEventLine: received empty line"));
  }
  return Effect.gen(function* () {
    const parsed: unknown = yield* Effect.try({
      try: () => JSON.parse(trimmed) as unknown,
      catch: (err) =>
        ParseResult.parseError(
          new ParseResult.Type(Schema.String.ast, trimmed, String(err)),
        ),
    });
    return yield* Schema.decodeUnknown(AgentEventSchema)(parsed);
  });
};
