/**
 * FRA-1459 — Brain-score orphan_ratio must exclude raw chronicle/source pages.
 *
 * Regression: a nightly life-chronicle ingest materialized thousands of raw
 * `email` + `event` pages. The gazetteer holds only ~dozens of entity buckets,
 * so those raw pages stay unlinked BY DESIGN. The old brain-score counted them
 * in both the orphan numerator AND the total-pages denominator, collapsing
 * health to ~0/100 and firing a false "unhealthy" recap despite the canonical
 * graph (person/company/concept/wiki) being fine.
 *
 * Fix: the orphan component of brain_score, and the `orphans` / `orphan_ratio`
 * data path, both exclude CHRONICLE_SOURCE_PAGE_TYPES from the linkable
 * universe. This test pins:
 *   1. getHealth() surfaces linkable_page_count / linkable_orphan_pages that
 *      EXCLUDE chronicle types, while orphan_pages (raw) still includes them.
 *   2. no_orphans_score / brain_score reflect the canonical graph, not raw
 *      ingest volume (the whole point of the bug).
 *   3. getOrphansData() (the shared `gbrain orphans` + doctor orphan_ratio fn)
 *      drops chronicle types from both total_orphans and total_linkable.
 *   4. shouldExclude() excludes by type regardless of slug.
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { shouldExclude, getOrphansData } from '../src/commands/orphans.ts';
import { CHRONICLE_SOURCE_PAGE_TYPES, isChronicleSourceType } from '../src/core/types.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  for (const t of ['links', 'content_chunks', 'timeline_entries', 'raw_data', 'tags', 'page_versions', 'ingest_log', 'pages']) {
    await (engine as any).db.exec(`DELETE FROM ${t}`);
  }
});

async function pageId(slug: string): Promise<number> {
  return (await (engine as any).db.query(`SELECT id FROM pages WHERE slug=$1`, [slug])).rows[0].id;
}

async function link(fromSlug: string, toSlug: string): Promise<void> {
  await (engine as any).db.query(
    `INSERT INTO links (from_page_id, to_page_id, link_type) VALUES ($1, $2, 'mentions')`,
    [await pageId(fromSlug), await pageId(toSlug)],
  );
}

describe('FRA-1459 — chronicle/source type classification', () => {
  test('CHRONICLE_SOURCE_PAGE_TYPES covers the reported culprits + analogous raw types', () => {
    // The observed collapse was 99.7% email + event pages.
    expect(CHRONICLE_SOURCE_PAGE_TYPES.has('email')).toBe(true);
    expect(CHRONICLE_SOURCE_PAGE_TYPES.has('event')).toBe(true);
    // Analogous raw ingest/transcript types.
    for (const t of ['slack', 'calendar-event', 'meeting', 'conversation', 'source', 'diary', 'extract_receipt']) {
      expect(CHRONICLE_SOURCE_PAGE_TYPES.has(t)).toBe(true);
    }
    // Canonical graph members must NOT be excluded.
    for (const t of ['person', 'company', 'concept', 'note', 'wiki', 'project', 'atom', 'media']) {
      expect(CHRONICLE_SOURCE_PAGE_TYPES.has(t)).toBe(false);
    }
  });

  test('isChronicleSourceType handles null/undefined', () => {
    expect(isChronicleSourceType('email')).toBe(true);
    expect(isChronicleSourceType('person')).toBe(false);
    expect(isChronicleSourceType(null)).toBe(false);
    expect(isChronicleSourceType(undefined)).toBe(false);
  });

  test('shouldExclude drops chronicle types regardless of slug; keeps canonical', () => {
    // An email page under a non-excluded slug is still excluded, by type.
    expect(shouldExclude('emails/2026/07/some-subject', 'email')).toBe(true);
    expect(shouldExclude('life/events/2026-07-16-standup', 'event')).toBe(true);
    // A canonical page keeps prior behavior (not excluded).
    expect(shouldExclude('people/alice', 'person')).toBe(false);
    // Slug-only call (no type) keeps the legacy behavior.
    expect(shouldExclude('people/alice')).toBe(false);
  });
});

describe('FRA-1459 — getHealth orphan component excludes chronicle pages', () => {
  test('raw ingest batch does NOT collapse no_orphans_score / brain_score', async () => {
    // Canonical graph: two linked entity pages (healthy — neither islanded).
    await engine.putPage('people/alice', { type: 'person', title: 'Alice', compiled_truth: 'a', frontmatter: {} });
    await engine.putPage('people/bob', { type: 'person', title: 'Bob', compiled_truth: 'b', frontmatter: {} });
    await link('people/alice', 'people/bob');

    // Raw chronicle ingest batch: many unlinked email + event pages.
    for (let i = 0; i < 8; i++) {
      await engine.putPage(`emails/2026/07/mail-${i}`, { type: 'email', title: `Mail ${i}`, compiled_truth: 'm', frontmatter: {} });
    }
    for (let i = 0; i < 8; i++) {
      await engine.putPage(`life/events/ev-${i}`, { type: 'event', title: `Event ${i}`, compiled_truth: 'e', frontmatter: {} });
    }

    const h = await engine.getHealth();

    // Raw orphan_pages still counts the 16 unlinked chronicle pages (nothing hidden).
    expect(h.orphan_pages).toBe(16);
    // Linkable universe = the 2 canonical pages only.
    expect(h.linkable_page_count).toBe(2);
    // Neither canonical page is islanded → zero linkable orphans.
    expect(h.linkable_orphan_pages).toBe(0);
    // The orphan component is therefore FULL, not collapsed.
    expect(h.no_orphans_score).toBe(15);

    // Sanity: had we used the raw ratio (16/18), the component would have been
    // ~1-2/15. Assert we are far above that pre-fix value.
    expect(h.no_orphans_score).toBeGreaterThan(10);

    // Breakdown still sums to brain_score by construction.
    const sum =
      h.embed_coverage_score + h.link_density_score + h.timeline_coverage_score +
      h.no_orphans_score + h.no_dead_links_score;
    expect(sum).toBe(h.brain_score);
  });

  test('a genuine canonical orphan IS still penalized', async () => {
    // One linked pair + one islanded canonical note.
    await engine.putPage('people/alice', { type: 'person', title: 'Alice', compiled_truth: 'a', frontmatter: {} });
    await engine.putPage('people/bob', { type: 'person', title: 'Bob', compiled_truth: 'b', frontmatter: {} });
    await link('people/alice', 'people/bob');
    await engine.putPage('wiki/lonely-concept', { type: 'note', title: 'Lonely', compiled_truth: 'x', frontmatter: {} });
    // Plus chronicle noise that must be ignored.
    await engine.putPage('emails/2026/07/noise', { type: 'email', title: 'Noise', compiled_truth: 'n', frontmatter: {} });

    const h = await engine.getHealth();
    expect(h.linkable_page_count).toBe(3);        // 2 people + 1 note (email excluded)
    expect(h.linkable_orphan_pages).toBe(1);      // the islanded note
    // noOrphans = 1 - 1/3 = 0.667 → round(0.667*15) = 10.
    expect(h.no_orphans_score).toBe(10);
  });

  test('brain of only chronicle pages scores full orphan marks (no canonical graph to orphan)', async () => {
    for (let i = 0; i < 5; i++) {
      await engine.putPage(`emails/2026/07/only-${i}`, { type: 'email', title: `Only ${i}`, compiled_truth: 'o', frontmatter: {} });
    }
    const h = await engine.getHealth();
    expect(h.page_count).toBe(5);
    expect(h.linkable_page_count).toBe(0);
    expect(h.linkable_orphan_pages).toBe(0);
    expect(h.no_orphans_score).toBe(15);
  });
});

describe('FRA-1459 — getOrphansData excludes chronicle pages', () => {
  test('email/event pages drop from BOTH total_orphans and total_linkable', async () => {
    await engine.putPage('people/alice', { type: 'person', title: 'Alice', compiled_truth: 'a', frontmatter: {} });
    await engine.putPage('people/bob', { type: 'person', title: 'Bob', compiled_truth: 'b', frontmatter: {} });
    await link('people/alice', 'people/bob'); // bob has inbound → not an orphan
    // alice has no inbound → a genuine canonical orphan under the no-inbound defn.
    await engine.putPage('wiki/canonical-orphan', { type: 'note', title: 'Canon', compiled_truth: 'c', frontmatter: {} });

    for (let i = 0; i < 10; i++) {
      await engine.putPage(`emails/2026/07/m-${i}`, { type: 'email', title: `M ${i}`, compiled_truth: 'm', frontmatter: {} });
      await engine.putPage(`life/events/e-${i}`, { type: 'event', title: `E ${i}`, compiled_truth: 'e', frontmatter: {} });
    }

    const data = await getOrphansData(engine);
    // total_pages counts everything (23), but linkable strips the 20 chronicle pages.
    expect(data.total_pages).toBe(23);
    expect(data.total_linkable).toBe(3); // alice, bob, canonical-orphan
    // Orphans (no inbound) among linkable: alice + canonical-orphan = 2. bob has inbound.
    expect(data.total_orphans).toBe(2);
    // No chronicle page leaks into the reported orphan list.
    for (const o of data.orphans) {
      expect(o.slug.startsWith('emails/')).toBe(false);
      expect(o.slug.startsWith('life/events/')).toBe(false);
    }
  });
});
