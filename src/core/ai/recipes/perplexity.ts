import type { Recipe } from '../types.ts';

/**
 * Perplexity's hosted embeddings API (#1046). OpenAI-shaped at
 * `POST {base}/embeddings` but diverges on the wire:
 *   - `encoding_format` only accepts 'base64_int8' (default) or
 *     'base64_binary' — the AI SDK's 'float' default is rejected.
 *   - The response `embedding` is a base64 string encoding SIGNED INT8
 *     components (natively quantized output), not a float array.
 * Both divergences are handled by perplexityCompatFetch in gateway.ts
 * (force 'base64_int8' outbound; decode Int8Array → number[] inbound).
 * Cosine similarity is scale-invariant, so the raw int8 components store
 * and rank correctly as floats.
 *
 * Models (per docs.perplexity.ai/api-reference/embeddings-post, 2026-07):
 *   - pplx-embed-v1-0.6b: dims 128..1024 (default 1024)
 *   - pplx-embed-v1-4b:   dims 128..2560 (default 2560)
 * The flexible-dim range validation lives in src/core/ai/dims.ts
 * (PERPLEXITY_EMBEDDING_MAX_DIMS). default_dims is pinned at 1024 so both
 * models work out of the box on a plain vector(N) column; users who want
 * the 4b model's full 2560 width set `embedding_dimensions: 2560` and the
 * existing halfvec path (dims > 2000) covers storage + ANN.
 *
 * Auth is PERPLEXITY_API_KEY only — deliberately NO OPENAI_API_KEY
 * fallback (a Perplexity brain must never silently bill/route through
 * OpenAI). If your key lives in PPLX_API_KEY, re-export it.
 */
export const perplexity: Recipe = {
  id: 'perplexity',
  name: 'Perplexity',
  tier: 'openai-compat',
  implementation: 'openai-compatible',
  base_url_default: 'https://api.perplexity.ai/v1',
  auth_env: {
    required: ['PERPLEXITY_API_KEY'],
    setup_url: 'https://www.perplexity.ai/settings/api',
  },
  touchpoints: {
    chat: {
      models: ['sonar', 'sonar-pro', 'sonar-reasoning-pro', 'sonar-deep-research'],
      supports_tools: false,
      supports_subagent_loop: false,
      supports_prompt_cache: false,
      max_context_tokens: 127000,
      cost_per_1m_input_usd: 1,
      cost_per_1m_output_usd: 1,
      price_last_verified: '2026-09-09',
    },
    expansion: {
      models: ['sonar'],
      price_last_verified: '2026-09-09',
    },
    embedding: {
      models: ['pplx-embed-v1-0.6b', 'pplx-embed-v1-4b'],
      default_dims: 1024,
      cost_per_1m_tokens_usd: 0.03, // pplx-embed-v1-4b; 0.6b is $0.004/M
      price_last_verified: '2026-07-21',
      // Perplexity enforces 120K combined tokens (and 512 texts) per
      // request. Same pre-split posture as Voyage: assume a dense
      // tokenizer (1 char ≈ 1 token) at 0.5 utilization; the gateway's
      // recursive halving is the runtime safety net.
      max_batch_tokens: 120_000,
      chars_per_token: 1,
      safety_factor: 0.5,
    },
  },
  setup_hint: 'Get an API key at https://www.perplexity.ai/settings/api, then `export PERPLEXITY_API_KEY=...` (re-export PPLX_API_KEY if that is where your key lives).',
  // Chat Completions are OpenAI-shaped at /chat/completions (no /v1).
  // Embeddings stay on /v1 via perplexityCompatFetch in gateway.ts.
  compat: {
    fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
      const raw = typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.href
          : (input as Request).url;
      if (typeof raw === 'string' && raw.includes('/v1/chat/completions')) {
        return fetch(raw.replace('/v1/chat/completions', '/chat/completions'), init);
      }
      return fetch(input as any, init);
    }) as typeof fetch,
  },
};
