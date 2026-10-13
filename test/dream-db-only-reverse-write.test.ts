import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { __testing as synthTesting } from '../src/core/cycle/synthesize.ts';
import { __testing as patternsTesting } from '../src/core/cycle/patterns.ts';

const roots: string[] = [];

afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'gbrain-dream-db-only-'));
  roots.push(root);
  writeFileSync(join(root, 'gbrain.yml'), [
    'storage:',
    '  db_tracked:',
    '    - brain/',
    '  db_only:',
    '    - dream-candidates/',
    '',
  ].join('\n'));
  const pages = new Map([
    ['dream-candidates/originals/candidate', {
      type: 'note', title: 'Candidate', compiled_truth: 'candidate body', timeline: '',
      frontmatter: { dream_generated: true },
    }],
    ['brain/ideas/reviewed', {
      type: 'note', title: 'Reviewed', compiled_truth: 'reviewed body', timeline: '',
      frontmatter: { dream_generated: true },
    }],
  ]);
  const engine = {
    getPage: async (slug: string) => pages.get(slug) ?? null,
    getTags: async () => [],
  } as unknown as BrainEngine;
  return { root, engine, pages };
}

for (const [lane, reverseWrite] of [
  ['synthesize', synthTesting.reverseWriteRefs],
  ['patterns', patternsTesting.reverseWriteRefs],
] as const) {
  describe(`${lane} reverse-write storage tier`, () => {
    test('keeps db_only dream candidates in the database without creating a directory', async () => {
      const { root, engine, pages } = fixture();
      const count = await reverseWrite(engine, root, [
        { slug: 'dream-candidates/originals/candidate', source_id: 'default' },
      ]);
      expect(count).toBe(0);
      expect(existsSync(join(root, 'dream-candidates'))).toBe(false);
      expect(await engine.getPage('dream-candidates/originals/candidate', { sourceId: 'default' })).toEqual(
        pages.get('dream-candidates/originals/candidate'),
      );
    });

    test('still writes a non-db_only control page', async () => {
      const { root, engine } = fixture();
      const count = await reverseWrite(engine, root, [
        { slug: 'brain/ideas/reviewed', source_id: 'default' },
      ]);
      expect(count).toBe(1);
      expect(existsSync(join(root, 'brain/ideas/reviewed.md'))).toBe(true);
    });
  });
}
