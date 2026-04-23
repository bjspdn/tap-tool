type AgentRole = "Composer" | "Reviewer";

type ContentBlock =
  | { readonly type: "text"; readonly text: string }
  | {
      readonly type: "tool_use";
      readonly id: string;
      readonly name: string;
      readonly input: unknown;
    }
  | {
      readonly type: "tool_result";
      readonly tool_use_id: string;
      readonly content:
        | string
        | ReadonlyArray<{ readonly type: "text"; readonly text: string }>;
      readonly is_error?: boolean;
    };

type AgentEvent =
  | {
      readonly type: "system";
      readonly subtype?: string;
      readonly session_id?: string;
      readonly model?: string;
      readonly tools?: ReadonlyArray<string>;
      readonly [k: string]: unknown;
    }
  | {
      readonly type: "assistant";
      readonly message: {
        readonly id?: string;
        readonly role: "assistant";
        readonly content: ReadonlyArray<ContentBlock>;
        readonly model?: string;
      };
      readonly session_id?: string;
    }
  | {
      readonly type: "user";
      readonly message: {
        readonly role: "user";
        readonly content: ReadonlyArray<ContentBlock>;
      };
      readonly session_id?: string;
    }
  | {
      readonly type: "result";
      readonly subtype:
        | "success"
        | "error_max_turns"
        | "error_during_execution"
        | string;
      readonly is_error: boolean;
      readonly num_turns: number;
      readonly session_id?: string;
      readonly total_cost_usd?: number;
      readonly result?: string;
      readonly usage?: {
        readonly input_tokens?: number;
        readonly output_tokens?: number;
      };
    };

type AgentRunOptions = {
  readonly role: AgentRole;
  readonly stdin: string;
  readonly cwd: AbsolutePath;
  readonly attempt: number;
  readonly logPath: AbsolutePath;
  readonly stderrLogPath: AbsolutePath;
  readonly evalPath?: AbsolutePath;
};
