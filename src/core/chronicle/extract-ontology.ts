// v0.42.x — Life Chronicle (#2390) ontology extractor (FRA-1317).
//
// Sibling of extract-events. Where extract-events segments a page into discrete
// timeline EVENTS, this lane extracts durable per-entity ONTOLOGY dimensions
// (supplier/project status, phase, role, …) and merges them bi-temporally via
// engine.mergeOntologyFact. That is the piece that was missing when `gbrain
// orient` returned `"ontologies": {}` — events were extracted, dimensions never
// were.
//
// Pipeline (mirrors extract-events):
//   deterministic entities/date  →  judge (LLM, injectable)  →  PARSE BARRIER
//   →  mergeOntologyFact per observation (idempotent, sourced, validity-scoped)
//
// The judge is injectable so the deterministic merge path is testable without a
// real gateway. The default judge calls the chat gateway; with no gateway it
// returns zero observations (auto-emit is a no-op, never an error).
//
// Provenance discipline: each observation is sourced with the PAGE SLUG, so two
// pages that disagree on the same (entity, dimension) surface as a genuine
// two-source conflict via findOntologyConflicts — not a silent overwrite.
// Novel dimensions still quarantine (mergeOntologyFact → isNovelDimension); only
// the seed lexicon (role/status/phase/…) resolves as current.
import type { BrainEngine } from '../engine.ts';

export interface OntologyObservationProposal {
  entity: string;              // entity slug / name (e.g. suppliers/acme, people/sarah-chen)
  dimension: string;           // status | phase | role | … (open vocab; normalized + quarantined at merge)
  value: string;               // the resolved value (e.g. active, onboarding, vendor)
  confidence?: number;         // 0..1; default 0.7
  valid_from?: string | null;  // ISO date the value became true (default: page date)
}
export interface OntologyJudgeInput {
  slug: string;
  type: string;
  title: string;
  body: string;
  effectiveDate: string | null;   // depth page effective_date (deterministic when)
  attendees: string[];            // deterministic entities-in-play from frontmatter
}
export interface OntologyJudgeResult { observations: OntologyObservationProposal[] }
export type OntologyJudge = (input: OntologyJudgeInput) => Promise<OntologyJudgeResult>;

export interface OntologyExtractResult {
  slug: string;
  status: 'extracted' | 'no_observations' | 'skipped';
  observations_written: number;   // inserted | corroborated | superseded (i.e. non-noop merges)
  reason?: string;
}

/** PARSE BARRIER: an observation must fully validate before ANY merge. */
export function isValidObservation(o: unknown): o is OntologyObservationProposal {
  if (!o || typeof o !== 'object') return false;
  const x = o as Record<string, unknown>;
  if (typeof x.entity !== 'string' || x.entity.trim().length === 0) return false;
  if (typeof x.dimension !== 'string' || x.dimension.trim().length === 0) return false;
  if (typeof x.value !== 'string' || x.value.trim().length === 0) return false;
  if (x.confidence != null && (typeof x.confidence !== 'number' || Number.isNaN(x.confidence))) return false;
  // valid_from, when present, must be a real parseable date (else the ::timestamptz
  // cast in mergeOntologyFact throws mid-write — the same trap extract-events guards).
  if (x.valid_from != null) {
    if (typeof x.valid_from !== 'string') return false;
    if (Number.isNaN(new Date(x.valid_from).getTime())) return false;
  }
  return true;
}

function collectAttendees(fm: Record<string, unknown>): string[] {
  const out = new Set<string>();
  for (const key of ['attendees', 'people', 'who', 'entities', 'suppliers', 'projects']) {
    const v = fm[key];
    if (Array.isArray(v)) for (const x of v) if (typeof x === 'string' && x.trim()) out.add(x.trim());
  }
  return [...out];
}

/**
 * Run the ontology extractor for one depth page. Idempotent: mergeOntologyFact
 * dedups on (entity, dimension, value, source) with a value-hash, so a re-run of
 * the same page produces no new observations (all 'noop'). A crash between merges
 * re-runs to the same state.
 */
export async function runOntologyExtract(
  engine: BrainEngine,
  opts: { slug: string; sourceId?: string; judge?: OntologyJudge; signal?: AbortSignal },
): Promise<OntologyExtractResult> {
  const sourceId = opts.sourceId ?? 'default';
  const page = await engine.getPage(opts.slug, { sourceId });
  if (!page) return { slug: opts.slug, status: 'skipped', observations_written: 0, reason: 'page_not_found' };

  const fm = (page.frontmatter ?? {}) as Record<string, unknown>;
  // getPage does not project effective_date, so resolve the bi-temporal anchor
  // in priority: frontmatter.date → the pages.effective_date column (authoritative
  // for ingested meeting/mail) → null (mergeOntologyFact then defaults to now()).
  // Anchoring valid_from to the page date is what makes `ontology --asof` travel
  // correctly instead of stamping every observation at ingest time.
  let effectiveDate: string | null = typeof fm.date === 'string' && fm.date ? fm.date : null;
  if (!effectiveDate) {
    try {
      const r = await engine.executeRaw<{ effective_date: string | Date | null }>(
        `SELECT effective_date FROM pages WHERE slug = $1 AND source_id = $2 LIMIT 1`,
        [opts.slug, sourceId],
      );
      const ed = r[0]?.effective_date;
      effectiveDate = ed instanceof Date ? ed.toISOString() : (typeof ed === 'string' && ed ? ed : null);
    } catch {
      // effective_date column may be absent on a pre-recency brain; leave null.
    }
  }
  const attendees = collectAttendees(fm);

  const judge = opts.judge ?? defaultJudge(engine);
  let result: OntologyJudgeResult;
  try {
    result = await judge({
      slug: opts.slug, type: page.type, title: page.title,
      body: page.compiled_truth ?? '', effectiveDate, attendees,
    });
  } catch (e) {
    if ((e as Error)?.name === 'AbortError') throw e;
    return { slug: opts.slug, status: 'skipped', observations_written: 0, reason: 'judge_error' };
  }

  const proposals = Array.isArray(result?.observations) ? result.observations : [];
  if (proposals.length === 0) return { slug: opts.slug, status: 'no_observations', observations_written: 0 };
  // PARSE BARRIER — reject the WHOLE batch on any malformed observation; no partial merges.
  if (!proposals.every(isValidObservation)) {
    return { slug: opts.slug, status: 'skipped', observations_written: 0, reason: 'malformed_observation' };
  }

  let written = 0;
  for (const obs of proposals) {
    if (opts.signal?.aborted) { const e = new Error('aborted'); e.name = 'AbortError'; throw e; }
    // Source = the page slug: this is the provenance that makes a two-source
    // disagreement a real conflict rather than a silent overwrite.
    const merge = await engine.mergeOntologyFact({
      entitySlug: obs.entity.trim(),
      dimension: obs.dimension,
      value: obs.value.trim(),
      confidence: typeof obs.confidence === 'number' ? obs.confidence : undefined,
      source: opts.slug,
      validFrom: obs.valid_from ?? effectiveDate ?? undefined,
      sourceId,
    });
    if (merge.action !== 'noop') written++;
  }
  return {
    slug: opts.slug,
    status: written > 0 ? 'extracted' : 'no_observations',
    observations_written: written,
  };
}

const JUDGE_SYSTEM = `You extract DURABLE per-entity ontology dimensions from a meeting/mail/note page.
An ontology dimension is a stable property that holds over time — NOT a one-off event.
Focus on suppliers, projects, companies, and people mentioned in the page.
Return ONLY a JSON array. Each element: {"entity": slug or name, "dimension": one of status|phase|role (prefer these) or another short snake_case noun, "value": short lowercase value, "confidence": 0..1 optional, "valid_from": ISO date optional}.
Guidance:
- status = current lifecycle state, e.g. prospect|active|paused|at_risk|churned|onboarding.
- phase = where an engagement/project sits, e.g. evaluation|pilot|onboarding|live|renewal|wind_down.
- role = what the entity is to us, e.g. vendor|partner|advisor|customer|contractor.
Only emit an observation when the text asserts the property as currently true. Omit speculation.
If the page states nothing durable, return []. No prose, no markdown — just the JSON array.`;

function defaultJudge(engine: BrainEngine): OntologyJudge {
  return async (input) => {
    const { isAvailable, chat } = await import('../ai/gateway.ts');
    if (!isAvailable('chat')) return { observations: [] };
    const body = (input.body || '').slice(0, 12_000);
    let text: string;
    try {
      const res = await chat({
        system: JUDGE_SYSTEM,
        messages: [{
          role: 'user',
          content:
            `<page slug="${input.slug}" type="${input.type}" date="${input.effectiveDate ?? ''}">\n` +
            `${input.title}\n\n${body}\n</page>\n\n` +
            `Known entities: ${input.attendees.slice(0, 20).join(', ') || '(none)'}.\nExtract the ontology dimensions.`,
        }],
        maxTokens: 1200,
      });
      if (res.stopReason === 'refusal' || res.stopReason === 'content_filter') return { observations: [] };
      text = res.text;
    } catch (err) {
      if ((err as Error)?.name === 'AbortError') throw err;
      return { observations: [] };
    }
    return { observations: parseOntologyJudgeJson(text) };
  };
}

/** Tolerant JSON-array extraction from a model response (mirrors extract-events). */
export function parseOntologyJudgeJson(text: string): OntologyObservationProposal[] {
  if (!text) return [];
  let s = text.trim();
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) s = fence[1].trim();
  const start = s.indexOf('[');
  const end = s.lastIndexOf(']');
  if (start === -1 || end === -1 || end < start) return [];
  try {
    const arr = JSON.parse(s.slice(start, end + 1));
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}
