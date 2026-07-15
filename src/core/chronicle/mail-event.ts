// v0.42.x — Life Chronicle (#2390) mail → event lane (FRA-1316).
//
// Deterministic sibling of the LLM event judge (extract-events.ts). An ingested
// email page maps to EXACTLY ONE timeline event:
//   when = received date, who = from/to entities, what = subject.
// No LLM: mail is high-volume (daily feed + 2025 PST backfill) and the mapping
// is header-mechanical, so a judge call per mail would be wasteful and
// non-deterministic. The full write path (content-addressed event page +
// timeline projection + idempotency) still lives in runChronicleExtract — this
// module only builds the single proposal from frontmatter.
//
// CONTRACT with the mail ingestion lane (FRA-1228): a mail page SHOULD carry
// frontmatter for sender, recipients, subject, and received date. This reader is
// tolerant of the common field names (and of `ingestion_metadata`) so the lane
// and this extractor can land independently — whichever ships first, the other
// slots in without a re-write.
import type { ChronicleEventProposal } from './extract-events.ts';

export interface MailPageForEvent {
  slug: string;
  title?: string;
  frontmatter?: Record<string, unknown>;
  effectiveDate?: string | null; // depth page effective_date, a `when` fallback
}

function firstString(fm: Record<string, unknown>, keys: string[]): string | null {
  for (const k of keys) {
    const v = fm[k];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return null;
}

/**
 * Collect who-entities from sender/recipient frontmatter, order-stable + deduped.
 * Sender first so `who[0]` is the counterparty — that is what `last-seen
 * <supplier>` reads. Accepts scalars or arrays under each field name.
 */
function collectParticipants(fm: Record<string, unknown>): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const add = (v: unknown): void => {
    if (typeof v === 'string') {
      const t = v.trim();
      if (t && !seen.has(t)) {
        seen.add(t);
        out.push(t);
      }
    } else if (Array.isArray(v)) {
      for (const x of v) add(x);
    }
  };
  for (const k of ['from', 'sender', 'from_entity']) add(fm[k]);
  for (const k of ['to', 'recipients', 'to_entity', 'cc']) add(fm[k]);
  return out;
}

/**
 * Resolve the received date from frontmatter (or the depth effective_date, or
 * ingestion_metadata), returning a REAL parseable date string or null. Mirrors
 * the PARSE BARRIER in extract-events.isValidProposal so a mail with no usable
 * date emits zero events rather than a garbage write.
 */
function resolveWhen(fm: Record<string, unknown>, effectiveDate: string | null | undefined): string | null {
  let raw = firstString(fm, ['received_at', 'received', 'date', 'sent_at', 'sent']);
  if (!raw && typeof effectiveDate === 'string' && effectiveDate.trim()) raw = effectiveDate.trim();
  if (!raw) {
    const meta = fm.ingestion_metadata;
    if (meta && typeof meta === 'object') {
      raw = firstString(meta as Record<string, unknown>, ['received_at', 'date', 'sent_at']);
    }
  }
  if (!raw) return null;
  if (Number.isNaN(new Date(raw).getTime())) return null;
  return raw;
}

/**
 * Build the single event proposal for a mail page, or null when the page lacks
 * the minimum (a parseable received date AND a subject/title). Returning null →
 * the caller emits zero events — a no-op, never a partial/garbage write. `who`
 * may be empty (mail with no resolved entities still lands on the timeline).
 */
export function buildMailEventProposal(page: MailPageForEvent): ChronicleEventProposal | null {
  const fm = page.frontmatter ?? {};
  const when = resolveWhen(fm, page.effectiveDate);
  if (!when) return null;
  const what = firstString(fm, ['subject', 'title']) ?? (page.title?.trim() || null);
  if (!what) return null;
  return {
    when,
    who: collectParticipants(fm),
    what,
    where: null,
    kind: 'email',
  };
}
