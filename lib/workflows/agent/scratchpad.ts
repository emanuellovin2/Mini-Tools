/**
 * Agent scratchpad — bounded message history persisted in run_steps.output.
 *
 * The scratchpad is the agent's working memory: system context, prior turns,
 * tool calls, and observations. It lives as the `output` field of the most
 * recent completed iteration's run_step row (keyed `<step_key>:iter:<N>`).
 *
 * Size invariants:
 *   - MAX_MESSAGES: hard cap on message count (oldest non-system turns dropped)
 *   - MAX_CONTENT_CHARS: individual message content truncation
 */

export const MAX_MESSAGES = 40;
const MAX_CONTENT_CHARS = 8_000;

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  /** Present when role=assistant and the model requested a tool call */
  tool_call?: { id?: string; name: string; args: unknown };
  /** Present when role=tool (the observation returned after execution) */
  tool_result?: { tool_call_id?: string; name: string; result: unknown };
}

export interface AgentState {
  messages: ChatMessage[];
  /** 0-based; incremented after each LLM call */
  iteration: number;
  /** Cumulative cost charged so far for this step (cents) */
  spent_cents: number;
  /** History of (tool, argsHash) pairs for no-progress detection */
  tool_call_history: Array<{ tool: string; argsHash: string }>;
}

export function emptyState(): AgentState {
  return { messages: [], iteration: 0, spent_cents: 0, tool_call_history: [] };
}

/**
 * Truncate the scratchpad when it exceeds MAX_MESSAGES.
 * Preserves the first system message and the most recent turns.
 * Long message content is truncated to MAX_CONTENT_CHARS.
 */
export function truncateScratchpad(state: AgentState): AgentState {
  let { messages } = state;

  // Truncate long content in individual messages
  messages = messages.map((m) => ({
    ...m,
    content:
      m.content.length > MAX_CONTENT_CHARS
        ? m.content.slice(0, MAX_CONTENT_CHARS) + " …[truncated]"
        : m.content,
  }));

  if (messages.length <= MAX_MESSAGES) {
    return { ...state, messages };
  }

  // Keep first system message + most recent turns
  const systemMsgs = messages[0]?.role === "system" ? [messages[0]] : [];
  const recentCount = MAX_MESSAGES - systemMsgs.length;
  const recent = messages.slice(-recentCount);

  return { ...state, messages: [...systemMsgs, ...recent] };
}
