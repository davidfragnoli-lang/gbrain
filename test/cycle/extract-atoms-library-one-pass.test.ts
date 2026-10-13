import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { collapseLibraryDocumentPages, runPhaseExtractAtoms } from '../../src/core/cycle/extract-atoms.ts';
import { importFromContent } from '../../src/core/import-file.ts';
import { resetPgliteState } from '../helpers/reset-pglite.ts';
import type { ChatOpts, ChatResult } from '../../src/core/ai/gateway.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 60_000);
afterAll(async () => { await engine.disconnect(); });
beforeEach(async () => { await resetPgliteState(engine); }, 60_000);

const fm = (fields: string, body: string) => `---\ntype: source\n${fields}\n---\n${body}`;

describe('extract_atoms library document one-pass concurrency', () => {
  test('extracts source text once, attributes to card/subject, and dedupes a concurrent rerun', async () => {
    const docs = ['doc-aaa111', 'doc-bbb222'];
    for (const [i, id] of docs.entries()) {
      const subject = `brain/projects/subject-${i}`;
      await importFromContent(engine, subject, fm(`title: Subject ${i}`, 'Canonical subject page.'), { sourceId: 'default', noEmbed: true });
      await importFromContent(engine, `library/${id}`, fm(
        `title: Card ${i}\ndocument_id: ${id}\ncontext_pages:\n  - ${subject}\nsubjects:\n  - ${subject}`,
        `Stable card ${i}. `.repeat(50)), { sourceId: 'default', noEmbed: true });
      await importFromContent(engine, `sources/files/${id}/hash-${i}`, fm(
        `title: Source ${i}\ndocument_id: ${id}`,
        `Verified source sentence ${i}. ` + `Extractable document evidence ${i}. `.repeat(40)),
      { sourceId: 'default', noEmbed: true });
    }
    await engine.setConfig('cycle.extract_atoms.concurrency', '2');

    let inFlight = 0;
    let maxInFlight = 0;
    const origins: string[] = [];
    const chat = async (o: ChatOpts): Promise<ChatResult> => {
      const source = String(o.messages[0]?.content).match(/^Source: ([^\n]+)/m)?.[1] ?? '';
      origins.push(source);
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise(resolve => setTimeout(resolve, 25));
      inFlight--;
      const i = source.includes('bbb222') ? 1 : 0;
      const text = JSON.stringify({ atoms: [{ title: `Library insight ${i}`, atom_type: 'insight',
        body: `Body ${i}.`, source_quote: `Verified source sentence ${i}.`, lesson: `Lesson ${i}.`,
        concepts: ['library'], virality_score: 10, emotional_register: 'practical' }] });
      return { text, blocks: [{ type: 'text', text }], stopReason: 'end',
        usage: { input_tokens: 1, output_tokens: 1, cache_read_tokens: 0, cache_creation_tokens: 0 },
        model: o.model ?? 'grok-cli:grok-4.7-build-fast', providerId: 'grok-cli' };
    };

    const input = await collapseLibraryDocumentPages(engine, 'default', docs.map((id, i) => ({
      slug: `library/${id}`, content: `Stable card ${i}. `.repeat(50), contentHash: `${i + 1}`.repeat(64),
    })));
    expect(input.map(p => p.slug)).toEqual([
      'sources/files/doc-aaa111/hash-0', 'sources/files/doc-bbb222/hash-1',
    ]);
    await runPhaseExtractAtoms(engine, { _transcripts: [], _pages: input, _chat: chat });
    expect(maxInFlight).toBe(2);
    expect(origins.every(s => s.startsWith('sources/files/'))).toBe(true);

    const first = await engine.executeRaw<{ slug: string; frontmatter: Record<string, unknown> }>(
      `SELECT slug, frontmatter FROM pages WHERE type='atom' AND deleted_at IS NULL ORDER BY slug`);
    expect(first).toHaveLength(2);
    expect(first.map(r => r.frontmatter.source_slug).sort()).toEqual(docs.map(id => `library/${id}`));
    expect(first.every(r => typeof r.frontmatter.source_file_slug === 'string')).toBe(true);
    expect(first.every(r => Array.isArray(r.frontmatter.context_pages))).toBe(true);

    await runPhaseExtractAtoms(engine, { _transcripts: [], _pages: input, _chat: chat });
    const second = await engine.executeRaw<{ slug: string }>(
      `SELECT slug FROM pages WHERE type='atom' AND deleted_at IS NULL ORDER BY slug`);
    expect(second.map(r => r.slug)).toEqual(first.map(r => r.slug));
  }, 60_000);

  test('defers a batch with a distinct reason while sync is active', async () => {
    await engine.executeRaw(`INSERT INTO minion_jobs(name, status, submission_authority)
      VALUES('sync', 'active', '{"version":1,"kind":"application"}'::jsonb)`);
    let calls = 0;
    const result = await runPhaseExtractAtoms(engine, {
      _transcripts: [],
      _pages: [{ slug: 'notes/wait', content: 'wait '.repeat(200), contentHash: 'f'.repeat(64) }],
      _chat: async () => { calls++; throw new Error('must not be called'); },
    });
    expect(calls).toBe(0);
    expect(result.status).toBe('skipped');
    expect(result.details?.reason).toBe('library_sync_or_ingest_active');
    expect(result.details?.active_job).toBe('sync');
  });
});
