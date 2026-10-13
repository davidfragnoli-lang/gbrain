/**
 * Native OpenAI structured-output request regression.
 *
 * Atom extraction supplies a response schema to chat(). This suite proves the
 * native OpenAI transport receives it and that the caller's conservative parse
 * lane still rejects malformed and structurally stopped replies.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import {
  chat,
  configureGateway,
  recipeSupportsStructuredOutputs,
  resetGateway,
  __setGenerateTextTransportForTests,
} from '../../src/core/ai/gateway.ts';
import { parseAtomsOutcome } from '../../src/core/cycle/extract-atoms-parse.ts';
import { getRecipe } from '../../src/core/ai/recipes/index.ts';

const RESPONSE_SCHEMA = {
  name: 'atoms_response',
  schema: {
    type: 'object',
    properties: { atoms: { type: 'array', items: { type: 'object' } } },
    required: ['atoms'],
    additionalProperties: false,
  },
};

afterEach(() => {
  __setGenerateTextTransportForTests(null);
  resetGateway();
});

describe('native OpenAI structured output', () => {
  test('the native recipe explicitly declares the capability', () => {
    expect(recipeSupportsStructuredOutputs(getRecipe('openai')!)).toBe(true);
  });

  test('passes the caller schema to generateText as json_schema output', async () => {
    let captured: any;
    __setGenerateTextTransportForTests(async (args: any) => {
      captured = args;
      return {
        content: [{ type: 'text', text: '{"atoms":[]}' }],
        finishReason: 'stop',
        usage: { inputTokens: 4, outputTokens: 3 },
      } as any;
    });
    configureGateway({
      chat_model: 'openai:gpt-5.6-luna',
      env: { OPENAI_API_KEY: 'test-only' },
    });

    const result = await chat({
      model: 'openai:gpt-5.6-luna',
      messages: [{ role: 'user', content: 'Extract atoms.' }],
      responseSchema: RESPONSE_SCHEMA,
    });

    expect(result.text).toBe('{"atoms":[]}');
    expect(captured.output?.name).toBe('json_schema');
    await expect(captured.output.responseFormat).resolves.toEqual({
      type: 'json',
      schema: RESPONSE_SCHEMA.schema,
      name: RESPONSE_SCHEMA.name,
    });
  });

  test('malformed text remains a failure instead of being repaired', () => {
    expect(parseAtomsOutcome('{"atoms":[')).toEqual({
      ok: false,
      reason: 'unterminated JSON array',
    });
  });

  test.each(['length', 'refusal', 'content_filter'] as const)(
    '%s stays fail-closed even when the prefix is valid',
    (stopReason) => {
      expect(parseAtomsOutcome('{"atoms":[]}', stopReason)).toEqual({
        ok: false,
        stopped: true,
        reason: `output stopped before the end (stopReason=${stopReason})`,
      });
    },
  );
});
