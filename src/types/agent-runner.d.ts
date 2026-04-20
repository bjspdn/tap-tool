interface AgentResult {
  readonly exitCode: number
  readonly output: string
  readonly stderr: string
  readonly durationMs: number
}