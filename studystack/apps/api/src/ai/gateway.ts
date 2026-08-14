// ── AI Gateway client (llm-handling.md §2.1 / §7.1) ────────────────────
// Every LLM call goes through the Vercel AI Gateway's OpenAI-compatible
// endpoint. Model identifiers are config values (env-overridable), never
// hardcoded at call sites — a provider swap is an env change, not a code
// change. Transient failures (rate limits, 5xx) get bounded exponential
// backoff via the client's built-in retry (§5) — distinct from any
// graph-level cost bounding.

import { ChatOpenAI, OpenAIEmbeddings } from "@langchain/openai";

/** Model tiering (§2.1) — env overrides per deployment. */
export const AI_MODELS = {
  /** Frontier generation: F4 structuring, tutorials, quizzes… */
  frontier: process.env.AI_MODEL_FRONTIER ?? "google/gemini-2.5-pro",
  /** Embeddings: source_chunks.embedding, concepts.embedding (768-dim). */
  embedding:
    process.env.AI_MODEL_EMBEDDING ?? "google/gemini-embedding-001",
} as const;

/** Bounded infra-retry for transient provider failures (§5). */
export const GATEWAY_MAX_RETRIES = 2;

function gatewayConnection() {
  const apiKey = process.env.AI_GATEWAY_API_KEY;
  if (!apiKey) {
    throw new Error(
      "AI_GATEWAY_API_KEY is not set — AI features require a Gateway key",
    );
  }
  return {
    apiKey,
    baseURL:
      process.env.AI_GATEWAY_BASE_URL ?? "https://ai-gateway.vercel.sh/v1",
  };
}

/** Frontier-tier chat model for generation / structured output. */
export function buildFrontierModel(options?: {
  maxTokens?: number;
  temperature?: number;
  timeout?: number;
}): ChatOpenAI {
  const { apiKey, baseURL } = gatewayConnection();
  return new ChatOpenAI({
    apiKey,
    configuration: { baseURL },
    model: AI_MODELS.frontier,
    maxTokens: options?.maxTokens ?? 4096,
    temperature: options?.temperature ?? 0.4,
    timeout: options?.timeout ?? 120_000,
    maxRetries: GATEWAY_MAX_RETRIES,
  });
}

/** Embedding client. Batches are kept small for Gateway compatibility. */
export function buildEmbeddings(): OpenAIEmbeddings {
  const { apiKey, baseURL } = gatewayConnection();
  return new OpenAIEmbeddings({
    apiKey,
    configuration: { baseURL },
    model: AI_MODELS.embedding,
    batchSize: 32,
    maxRetries: GATEWAY_MAX_RETRIES,
  });
}
