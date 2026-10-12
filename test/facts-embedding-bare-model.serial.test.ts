/**
 * #6113 (fix wave 12, W1.6, refusal half): a legacy brain whose DB
 * `embedding_model` row has no provider prefix stops managed fact extraction.
 * The refusal names the one supported rewrite, previewed read-only, with the
 * provider the gateway resolves for that model; it never reads the per-host
 * file plane as the brain's identity.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { configureGateway, resetGateway } from '../src/core/ai/gateway.ts';
import { resolveManagedFactsEmbedding, resolveStoredFactsEmbeddingModel } from '../src/core/persistence/facts-maintenance.ts';
import type { GBrainConfig } from '../src/core/config.ts';

let engine: PGLiteEngine;
beforeAll(async () => {
  engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema();
  await engine.setConfig('embedding_model', 'text-embedding-3-small');
  await engine.setConfig('embedding_dimensions', '1536');
}, 60_000);
afterAll(async () => { resetGateway(); await engine.disconnect(); });

async function setStoredEmbedding(model: string | null, dimensions: string | null): Promise<void> {
  await engine.executeRaw("DELETE FROM config WHERE key IN ('embedding_model','embedding_dimensions','embedding_disabled')");
  if (model !== null) await engine.setConfig('embedding_model', model);
  if (dimensions !== null) await engine.setConfig('embedding_dimensions', dimensions);
}

async function expectEmbeddingConfiguration(config: GBrainConfig): Promise<Error & { code: string; suggestion: string }> {
  const error = await resolveManagedFactsEmbedding(engine, config).then(() => null, e => e);
  expect(error).toMatchObject({ code: 'embedding_configuration' });
  return error;
}

test('a bare DB model refuses with the migrate preview for the gateway provider', async () => {
  configureGateway({ embedding_model: 'openai:text-embedding-3-small', embedding_dimensions: 1536, env: { OPENAI_API_KEY: 'sk-test-fake' } });
  const error = await resolveManagedFactsEmbedding(engine, { engine: 'pglite' } as GBrainConfig).then(() => null, e => e);
  expect(error).toMatchObject({ code: 'embedding_configuration' });
  expect(error.suggestion).toContain('"text-embedding-3-small" with no provider prefix');
  expect(error.suggestion).toContain('gbrain migrate embeddings --to openai:text-embedding-3-small --dry-run');
  expect(error.fix).toMatchObject({ argv: ['gbrain', 'migrate', 'embeddings', '--to', 'openai:text-embedding-3-small', '--dry-run'], actor: 'agent' });
});

test('a bare DB model resolves only through the selected brain exact provider-qualified model', async () => {
  expect(resolveStoredFactsEmbeddingModel('text-embedding-3-small', 'openai:text-embedding-3-small'))
    .toBe('openai:text-embedding-3-small');
  expect(resolveStoredFactsEmbeddingModel('text-embedding-3-small', 'openai:text-embedding-3-large')).toBeNull();
  expect(resolveStoredFactsEmbeddingModel('text-embedding-3-small', undefined)).toBeNull();
  await expect(resolveManagedFactsEmbedding(engine, {
    engine: 'pglite', embedding_model: 'openai:text-embedding-3-small', embedding_dimensions: 1536,
  } as GBrainConfig)).resolves.toEqual({ model: 'openai:text-embedding-3-small', dimensions: 1536 });
});

test('a gateway on another model names no provider and falls back to the read-only readiness report', async () => {
  await setStoredEmbedding('text-embedding-3-small', '1536');
  configureGateway({ embedding_model: 'voyage:voyage-4', embedding_dimensions: 1024, env: { VOYAGE_API_KEY: 'test-fake' } });
  const error = await resolveManagedFactsEmbedding(engine, { engine: 'pglite' } as GBrainConfig).then(() => null, e => e);
  expect(error.suggestion).toContain('--to <provider>:text-embedding-3-small --dry-run');
  expect(error.fix.argv).toEqual(['gbrain', 'doctor', '--only', 'embeddings', '--json']);
});

test('only an absent stored model or explicit disable resolves to no managed embedding', async () => {
  await setStoredEmbedding(null, null);
  await expect(resolveManagedFactsEmbedding(engine, { engine: 'pglite' } as GBrainConfig)).resolves.toBeNull();

  await setStoredEmbedding('openai:text-embedding-3-small', '1536');
  await engine.setConfig('embedding_disabled', 'true');
  await expect(resolveManagedFactsEmbedding(engine, { engine: 'pglite' } as GBrainConfig)).resolves.toBeNull();
});

test.each([
  ['whitespace', '   '],
  ['slash-only', '///'],
])('a stored %s model identity refuses instead of disabling embeddings', async (_label, model) => {
  await setStoredEmbedding(model, '1536');
  const error = await expectEmbeddingConfiguration({ engine: 'pglite' } as GBrainConfig);
  expect(error.suggestion).toContain(JSON.stringify(model));
});

test.each([
  ['missing', null],
  ['invalid', 'not-a-number'],
  ['unsafe', '9007199254740992'],
])('an unresolved bare model with %s dimensions refuses without migration guidance', async (_label, dimensions) => {
  await setStoredEmbedding('text-embedding-3-small', dimensions);
  const error = await expectEmbeddingConfiguration({ engine: 'pglite' } as GBrainConfig);
  expect(error.suggestion).toContain('positive safe integer');
  expect(error.suggestion).not.toContain('gbrain migrate embeddings');
});

test('a bare model mismatched with the selected brain refuses migration rather than resolving by model name alone', async () => {
  await setStoredEmbedding('text-embedding-3-small', '1536');
  const error = await expectEmbeddingConfiguration({
    engine: 'pglite', embedding_model: 'openai:text-embedding-3-large', embedding_dimensions: 1536,
  } as GBrainConfig);
  expect(error.suggestion).toContain('gbrain migrate embeddings --to <provider>:text-embedding-3-small --dry-run');
});

test('a provider-qualified model refuses when its configured dimensions differ from the facts vector column', async () => {
  await setStoredEmbedding('openai:text-embedding-3-small', '1024');
  const error = await expectEmbeddingConfiguration({ engine: 'pglite' } as GBrainConfig);
  expect(error.suggestion).toContain('configured for 1024');
  expect(error.suggestion).toContain('1536-dimension vectors');
});
