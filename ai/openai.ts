/**
 * OpenAI adapter.
 *
 * Everything goes through here so there is one place that enforces the token
 * ceiling, one place that pins the response schema, and one place to change if
 * the model or vendor changes.
 *
 * Two rules the rest of the system depends on:
 *
 *  - **Structured output, always.** The schema is a hard guarantee where a prompt
 *    instruction is a request. Role enums, date formats and the sentence-array
 *    shape are all enforced here rather than asked for in prose.
 *  - **Text in, never documents.** Callers extract text before calling. Sending a
 *    PDF natively renders every page to both text and an image, which costs
 *    roughly 9–21× the tokens for the same content.
 */

import type { Config } from "../config.ts";

export class LlmError extends Error {
  constructor(message: string, readonly retriable = false) {
    super(message);
    this.name = "LlmError";
  }
}

export interface CompletionRequest {
  /** Which tier to use. Tabular mapping does not need the frontier model. */
  tier: "frontier" | "cheap";
  system: string;
  user: string;
  /** JSON Schema the response must satisfy. */
  schema: Record<string, unknown>;
  schemaName: string;
  /** Higher effort for long-horizon synthesis over a full transcript. */
  reasoningEffort?: "low" | "medium" | "high";
}

export interface CompletionResult<T> {
  data: T;
  model: string;
  inputTokens: number;
  outputTokens: number;
}

/**
 * Token estimate.
 *
 * Deliberately a cheap heuristic rather than a real tokenizer: it exists to
 * refuse an obviously mis-wired input before it is billed, and to show the
 * auditor a number before they press generate. ~4 characters per token is close
 * enough for both, and it errs high on prose.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export class OpenAiClient {
  constructor(private readonly cfg: Config) {}

  private modelFor(tier: CompletionRequest["tier"]): string {
    return tier === "frontier" ? this.cfg.openai.frontierModel : this.cfg.openai.cheapModel;
  }

  /**
   * Run a completion and return validated structured output.
   *
   * Refuses rather than truncates when the input is too large. Truncating a
   * transcript silently drops the part of the meeting the findings should have
   * come from, which is worse than an error the auditor can act on.
   */
  async complete<T>(request: CompletionRequest): Promise<CompletionResult<T>> {
    const estimated = estimateTokens(request.system + request.user);
    if (estimated > this.cfg.openai.maxInputTokens) {
      throw new LlmError(
        `This input is about ${estimated.toLocaleString()} tokens, over the ` +
          `${this.cfg.openai.maxInputTokens.toLocaleString()} limit. Reduce the selected ` +
          `documents rather than proceeding — truncating would silently drop content.`,
      );
    }

    const model = this.modelFor(request.tier);

    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.cfg.openai.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: request.system },
          { role: "user", content: request.user },
        ],
        response_format: {
          type: "json_schema",
          json_schema: {
            name: request.schemaName,
            strict: true,
            schema: request.schema,
          },
        },
        ...(request.reasoningEffort ? { reasoning_effort: request.reasoningEffort } : {}),
      }),
    });

    if (!response.ok) {
      const body = await response.text();
      // 429 and 5xx are worth retrying; a 400 means the request itself is wrong
      // and retrying it would just spend money to fail again.
      const retriable = response.status === 429 || response.status >= 500;
      throw new LlmError(
        `OpenAI returned ${response.status}: ${body.slice(0, 300)}`,
        retriable,
      );
    }

    const payload = await response.json();
    const content = payload?.choices?.[0]?.message?.content;
    if (typeof content !== "string") {
      throw new LlmError("OpenAI returned no message content", true);
    }

    let data: T;
    try {
      data = JSON.parse(content) as T;
    } catch {
      // Should be impossible with strict structured output, which is exactly
      // why it is worth flagging loudly rather than swallowing.
      throw new LlmError("OpenAI returned content that is not valid JSON", true);
    }

    return {
      data,
      model,
      inputTokens: payload?.usage?.prompt_tokens ?? estimated,
      outputTokens: payload?.usage?.completion_tokens ?? 0,
    };
  }
}
