/**
 * v0.42.x — Life Chronicle (#2390) ontology extractor (FRA-1317).
 * PGLite in-memory. Covers the parse barrier, the injectable-judge merge path,
 * seed-lexicon supplier/project dims (status/phase/role → active), novel-dim
 * quarantine, idempotent re-run, provenance-as-page-slug, --asof time travel,
 * and the two-source conflict surfaced by findOntologyConflicts.
 * The LLM judge is stubbed so the deterministic merge path runs without a gateway.
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import {
  runOntologyExtract,
  isValidObservation,
  parseOntologyJudgeJson,
  type OntologyJudge,
} from '../src/core/chronicle/extract-ontology.ts';

let engine: PGLiteEngine;
const ACME = 'suppliers/acme';
const LONG_BODY = 'Quarterly review with Acme. '.repeat(6);

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({ database_url: '' });
  await engine.initSchema();
});
afterAll(async () => { await engine.disconnect(); });

async function putReview(slug: string, date: string): Promise<void> {
  await engine.putPage(slug, {
    type: 'meeting', title: 'Acme quarterly review',
    compiled_truth: LONG_BODY,
    frontmatter: { attendees: [ACME] },
    effective_date: new Date(date),
  });
}

describe('isValidObservation (parse barrier)', () => {
  test('accepts a well-formed observation', () => {
    expect(isValidObservation({ entity: ACME, dimension: 'status', value: 'active' })).toBe(true);
  });
  test('rejects missing/empty fields', () => {
    expect(isValidObservation({ entity: '', dimension: 'status', value: 'active' })).toBe(false);
    expect(isValidObservation({ entity: ACME, dimension: 'status', value: '  ' })).toBe(false);
    expect(isValidObservation({ entity: ACME, value: 'active' })).toBe(false);
  });
  test('rejects an unparseable valid_from (would throw on the ::timestamptz cast)', () => {
    expect(isValidObservation({ entity: ACME, dimension: 'status', value: 'active', valid_from: 'someday' })).toBe(false);
  });
  test('rejects a non-numeric confidence', () => {
    expect(isValidObservation({ entity: ACME, dimension: 'status', value: 'active', confidence: 'high' })).toBe(false);
  });
});

describe('parseOntologyJudgeJson', () => {
  test('extracts a fenced JSON array', () => {
    const out = parseOntologyJudgeJson('```json\n[{"entity":"suppliers/acme","dimension":"phase","value":"live"}]\n```');
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ dimension: 'phase', value: 'live' });
  });
  test('returns [] on junk', () => {
    expect(parseOntologyJudgeJson('no json here')).toEqual([]);
  });
});

describe('runOntologyExtract', () => {
  beforeEach(async () => {
    await engine.executeRaw('DELETE FROM facts');
    await engine.executeRaw(`DELETE FROM pages WHERE slug LIKE 'meetings/%acme%' OR slug LIKE 'mail/%acme%'`);
  });

  const supplierJudge: OntologyJudge = async () => ({
    observations: [
      { entity: ACME, dimension: 'status', value: 'active', confidence: 0.8 },
      { entity: ACME, dimension: 'phase', value: 'onboarding' },
      { entity: ACME, dimension: 'role', value: 'vendor' },
    ],
  });

  test('populates supplier status/phase/role as active current values', async () => {
    await putReview('meetings/2026-06-01-acme', '2026-06-01T10:00:00Z');
    const r = await runOntologyExtract(engine, { slug: 'meetings/2026-06-01-acme', judge: supplierJudge });
    expect(r.status).toBe('extracted');
    expect(r.observations_written).toBe(3);

    const o = await engine.getOntology(ACME);
    const byDim = Object.fromEntries(o.map((v) => [v.dimension, v]));
    expect(byDim.status).toMatchObject({ value: 'active', status: 'active' });
    expect(byDim.phase).toMatchObject({ value: 'onboarding', status: 'active' });
    expect(byDim.role).toMatchObject({ value: 'vendor', status: 'active' });
    // Provenance is the page slug — the key that makes cross-source conflicts real.
    expect(byDim.status.source).toBe('meetings/2026-06-01-acme');
  });

  test('idempotent: re-running the same page writes nothing new', async () => {
    await putReview('meetings/2026-06-01-acme', '2026-06-01T10:00:00Z');
    await runOntologyExtract(engine, { slug: 'meetings/2026-06-01-acme', judge: supplierJudge });
    const again = await runOntologyExtract(engine, { slug: 'meetings/2026-06-01-acme', judge: supplierJudge });
    expect(again.observations_written).toBe(0);
    expect(await engine.getOntology(ACME)).toHaveLength(3);
  });

  test('novel LLM-proposed dimension quarantines (excluded from current resolution)', async () => {
    await putReview('meetings/2026-06-01-acme', '2026-06-01T10:00:00Z');
    const novelJudge: OntologyJudge = async () => ({
      observations: [{ entity: ACME, dimension: 'vibe', value: 'chaotic' }],
    });
    await runOntologyExtract(engine, { slug: 'meetings/2026-06-01-acme', judge: novelJudge });
    expect(await engine.getOntology(ACME)).toHaveLength(0);                 // quarantined → hidden
    const withQ = await engine.getOntology(ACME, { includeQuarantined: true });
    expect(withQ.some((v) => v.dimension === 'vibe' && v.status === 'quarantined')).toBe(true);
  });

  test('parse barrier rejects the whole batch on one malformed observation', async () => {
    await putReview('meetings/2026-06-01-acme', '2026-06-01T10:00:00Z');
    const badJudge: OntologyJudge = async () => ({
      observations: [
        { entity: ACME, dimension: 'status', value: 'active' },
        { entity: ACME, dimension: 'phase', value: '' },   // malformed
      ] as never,
    });
    const r = await runOntologyExtract(engine, { slug: 'meetings/2026-06-01-acme', judge: badJudge });
    expect(r.status).toBe('skipped');
    expect(r.reason).toBe('malformed_observation');
    expect(await engine.getOntology(ACME)).toHaveLength(0);   // no partial merge
  });

  test('a second source that disagrees surfaces a two-source conflict', async () => {
    await putReview('meetings/2026-06-01-acme', '2026-06-01T10:00:00Z');
    await putReview('mail/2026-06-02-acme', '2026-06-02T10:00:00Z');
    await runOntologyExtract(engine, {
      slug: 'meetings/2026-06-01-acme',
      judge: async () => ({ observations: [{ entity: ACME, dimension: 'status', value: 'active' }] }),
    });
    await runOntologyExtract(engine, {
      slug: 'mail/2026-06-02-acme',
      judge: async () => ({ observations: [{ entity: ACME, dimension: 'status', value: 'at_risk', valid_from: '2026-06-02T10:00:00Z' }] }),
    });
    const conflicts = await engine.findOntologyConflicts();
    // Bi-temporal: the later observation supersedes forward, so it is NOT a
    // silent conflict (that is correct — supersession, not disagreement). Assert
    // the current value time-travels: 'active' inside the window, 'at_risk' now.
    // Active window [2026-06-01T10:00 (page date), 2026-06-02T10:00 (supersession)).
    const past = await engine.getOntology(ACME, { asof: '2026-06-01T18:00:00Z' });
    expect(past.find((v) => v.dimension === 'status')?.value).toBe('active');
    const now = await engine.getOntology(ACME);
    expect(now.find((v) => v.dimension === 'status')?.value).toBe('at_risk');
    // No false conflict from a clean forward supersession.
    expect(conflicts.find((c) => c.dimension === 'status')).toBeUndefined();
  });

  test('genuine backdated two-source disagreement IS flagged as a conflict', async () => {
    await putReview('meetings/2026-06-02-acme', '2026-06-02T10:00:00Z');
    await putReview('mail/2026-06-01-acme', '2026-06-01T10:00:00Z');
    // Second source is BACKDATED before the current value's valid_from, so it is
    // NOT a forward supersession — both stay current-open from two provenances →
    // genuine disagreement, which must surface rather than silently overwrite.
    await runOntologyExtract(engine, {
      slug: 'meetings/2026-06-02-acme',
      judge: async () => ({ observations: [{ entity: ACME, dimension: 'phase', value: 'live', valid_from: '2026-06-02T10:00:00Z' }] }),
    });
    await runOntologyExtract(engine, {
      slug: 'mail/2026-06-01-acme',
      judge: async () => ({ observations: [{ entity: ACME, dimension: 'phase', value: 'pilot', valid_from: '2026-06-01T10:00:00Z' }] }),
    });
    const conflicts = await engine.findOntologyConflicts();
    const phaseConflict = conflicts.find((c) => c.entity_slug === ACME && c.dimension === 'phase');
    expect(phaseConflict).toBeDefined();
    expect(new Set(phaseConflict!.values.map((v) => v.value))).toEqual(new Set(['live', 'pilot']));
  });

  test('missing page → skipped', async () => {
    const r = await runOntologyExtract(engine, { slug: 'meetings/does-not-exist', judge: supplierJudge });
    expect(r).toMatchObject({ status: 'skipped', reason: 'page_not_found' });
  });
});
