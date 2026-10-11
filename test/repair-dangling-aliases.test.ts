import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { runAliasRepair } from '../src/commands/repair-aliases.ts';

describe('source-scoped dangling alias repair', () => {
  let engine: PGLiteEngine;
  beforeEach(async () => { engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema(); });
  afterEach(async () => { await engine.disconnect(); });

  test('preview is source-scoped and apply is bound to the preview hash', async () => {
    await engine.executeRaw("INSERT INTO sources(id,name,config) VALUES ('other','other','{}'::jsonb) ON CONFLICT DO NOTHING");
    await engine.executeRaw("INSERT INTO slug_aliases(source_id,alias_slug,canonical_slug) VALUES ('default','old-default','missing-default'),('other','old-other','missing-other')");
    const writes: string[] = [];
    const saved = process.stdout.write;
    process.stdout.write = ((chunk: string | Uint8Array) => { writes.push(String(chunk)); return true; }) as typeof process.stdout.write;
    try { await runAliasRepair(engine, { source: 'default', apply: false, json: true }); } finally { process.stdout.write = saved; }
    const preview = JSON.parse(writes.join(''));
    expect(preview.affected).toBe(1);
    expect(preview.apply_command).toContain(`--expect ${preview.plan_hash}`);
    await expect(runAliasRepair(engine, { source: 'default', apply: true, expect: 'stale', json: true }))
      .rejects.toMatchObject({ code: 'changed_since_preview' });
    await runAliasRepair(engine, { source: 'default', apply: true, expect: preview.plan_hash, json: true });
    const rows = await engine.executeRaw<{ source_id: string }>('SELECT source_id FROM slug_aliases ORDER BY source_id');
    expect(rows).toEqual([{ source_id: 'other' }]);
  });
});
