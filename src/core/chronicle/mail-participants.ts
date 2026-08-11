// FRA-1426 — resolve mail participants to person entity slugs.
//
// The mail → timeline lane (FRA-1316) writes an event whose `who` holds the raw
// Outlook participant strings straight from the from/to/cc headers, e.g.
//   "raphael.barreto@logiplus.de;David.Fragnoli@distico.ch;David.Costantino@swatch.com"
//   "ServiceDesk <SGS-ServiceDesk@swatchgroup.com>"
//   "Costantino, David"
// Those strings never match the 100+ `people/<slug>` entity pages, so the
// events are not linked to people and `doctor graph_coverage` timeline stays
// ~2%. This module turns those raw strings into canonical person slugs.
//
// Resolution is deterministic and DB-backed (no LLM — mail is high-volume and
// the mapping is mechanical). The primary signal is the email ADDRESS: person
// pages carry their address in the compiled body (`David.Costantino@swatch.com`),
// so we build an email → slug index once and look each address up. Display-name
// (`Costantino, David`) is the secondary signal via a normalized-title index.
// Anything unresolved is kept verbatim so no participant is silently dropped.
import type { BrainEngine } from '../engine.ts';
import { slugify } from '../entities/resolve.ts';

/** One parsed participant token: the raw text, plus the extracted address and display name. */
export interface ParsedParticipant {
  raw: string;
  address: string | null;   // lowercased email address, or null
  displayName: string | null; // human display name normalized to "First Last", or null
}

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;
const EMAIL_RE_G = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

/**
 * Split an address-list string on the given separators, respecting `"..."`
 * quoting and `<...>` angle brackets so a comma inside a quoted display name
 * ("Costantino, David") or inside an address never splits a participant.
 */
function splitTopLevel(s: string, seps: string[]): string[] {
  const out: string[] = [];
  let cur = '';
  let inQuote = false;
  let inAngle = false;
  for (const ch of s) {
    if (ch === '"') { inQuote = !inQuote; cur += ch; continue; }
    if (ch === '<') { inAngle = true; cur += ch; continue; }
    if (ch === '>') { inAngle = false; cur += ch; continue; }
    if (!inQuote && !inAngle && seps.includes(ch)) { out.push(cur); cur = ''; continue; }
    cur += ch;
  }
  out.push(cur);
  return out.map((t) => t.trim()).filter(Boolean);
}

/** Normalize a display name: swap "Last, First" → "First Last"; collapse whitespace. */
export function normalizeDisplayName(s: string): string {
  const t = s.replace(/\s+/g, ' ').trim();
  const parts = t.split(',');
  if (parts.length === 2) {
    const last = parts[0].trim();
    const first = parts[1].trim();
    // Only swap the classic two-field "Last, First" form. Multi-comma junk
    // ("Dufort, Michaël dans Teams") is left as-is — it won't match cleanly
    // and that's fine (it stays unresolved rather than mis-resolving).
    if (last && first && !first.includes(' ')) return `${first} ${last}`;
  }
  return t;
}

/** Parse a single participant token into {address, displayName}. */
function parseOneParticipant(token: string): ParsedParticipant | null {
  const raw = token.trim();
  if (!raw) return null;

  let address: string | null = null;
  const angle = raw.match(/<([^<>]+)>/);
  if (angle) {
    const m = angle[1].match(EMAIL_RE);
    if (m) address = m[0].toLowerCase();
  }
  if (!address) {
    const m = raw.match(EMAIL_RE);
    if (m) address = m[0].toLowerCase();
  }

  // Display name = the token with any <...> and quotes and email addresses
  // stripped. If what remains has no letters, there is no real display name.
  let disp = raw.replace(/<[^<>]*>/g, ' ').replace(/"/g, ' ').replace(EMAIL_RE_G, ' ');
  disp = disp.replace(/\s+/g, ' ').trim();
  const displayName = /[A-Za-zÀ-ÿ]/.test(disp) ? normalizeDisplayName(disp) : null;

  if (!address && !displayName) return null;
  return { raw, address, displayName };
}

/**
 * Parse one from/to/cc field value into individual participants.
 *
 * Fields arrive in several shapes across the mail sources: semicolon-separated
 * address lists (daily Power Automate export), comma-separated address lists
 * (some PST rows), single `Name <addr>` tokens, and bare `Last, First` display
 * names (PST with no address). Strategy: split on `;` first (an unambiguous
 * separator), then inside each chunk split on `,` ONLY when the chunk carries
 * two or more `@` — a lone `,` in a chunk with ≤1 address is part of a
 * "Last, First" display name, not a separator.
 */
export function parseParticipantField(field: unknown): ParsedParticipant[] {
  if (typeof field !== 'string' || !field.trim()) {
    // Arrays: parse each element and flatten.
    if (Array.isArray(field)) return field.flatMap((f) => parseParticipantField(f));
    return [];
  }
  const out: ParsedParticipant[] = [];
  for (const chunk of splitTopLevel(field, [';'])) {
    const atCount = (chunk.match(/@/g) || []).length;
    const tokens = atCount >= 2 ? splitTopLevel(chunk, [',']) : [chunk];
    for (const tok of tokens) {
      const p = parseOneParticipant(tok);
      if (p) out.push(p);
    }
  }
  return out;
}

const FROM_KEYS = ['from', 'sender', 'from_entity'];
const TO_KEYS = ['to', 'recipients', 'to_entity', 'cc'];

/**
 * Parse all participants from a mail page's frontmatter, sender first so the
 * counterparty is `who[0]` (what `last-seen <supplier>` reads).
 */
export function parseMailParticipants(fm: Record<string, unknown>): ParsedParticipant[] {
  const out: ParsedParticipant[] = [];
  for (const k of FROM_KEYS) out.push(...parseParticipantField(fm[k]));
  for (const k of TO_KEYS) out.push(...parseParticipantField(fm[k]));
  return out;
}

/**
 * The person/company entity index used to resolve participants. Built once per
 * projection run from the entity pages themselves:
 *   - byEmail: address → canonical entity slug (address is the primary signal)
 *   - byName:  slugify(title) → canonical entity slug (display-name fallback)
 *   - slugs:   the set of entity slugs (to gate fuzzy matches to real entities)
 */
export interface EntityIndex {
  // An address / normalized name can map to MORE THAN ONE entity page: the
  // brain carries duplicate person pages (a bare `david-costantino` slug and a
  // `brain/people/david-costantino` slug for the same person). We keep every
  // co-top-scoring page so a resolved participant covers all of its pages, with
  // the lexically-first slug used as the canonical `who` value.
  byEmail: Map<string, string[]>;
  byName: Map<string, string[]>;
  slugs: Set<string>;
  /** entity slug → the source_id its page lives under (for cross-source fan-out). */
  slugSource: Map<string, string>;
}

/** Tokenize an email local part or a slug/title into lowercase word tokens. */
function tokens(s: string): string[] {
  return s.toLowerCase().split(/[^a-z0-9]+/i).filter(Boolean);
}

/**
 * Overlap score between an email local part and an entity's slug + title —
 * used to attribute an address to the right owner when it appears on more than
 * one page (e.g. a colleague's address quoted in a "relationship context"
 * section). The owner's own address (`david.costantino` ↔ `david-costantino`)
 * scores highest.
 */
function localOwnerScore(local: string, slug: string, title: string): number {
  const lt = new Set(tokens(local));
  if (lt.size === 0) return 0;
  const et = new Set([...tokens(slug), ...tokens(title)]);
  let shared = 0;
  for (const t of lt) if (et.has(t)) shared++;
  return shared;
}

/**
 * Build the entity index from all person/company pages in the source. Emails
 * are harvested from the compiled body; each address is attributed to the
 * best-matching owner (by local-part↔name overlap), with a deterministic
 * slug-ascending tiebreak. Addresses that tie at zero overlap across multiple
 * pages are dropped as genuinely ambiguous.
 */
export async function buildEntityIndex(
  engine: BrainEngine,
  opts?: { sourceIds?: string[] } | string,
): Promise<EntityIndex> {
  // Back-compat: a bare string is treated as a single source filter.
  const sourceIds = typeof opts === 'string' ? [opts] : opts?.sourceIds;
  // Entity resolution is deliberately CROSS-SOURCE by default: the mail lane
  // events live under a mail source (e.g. `swatch-mail`) while the person/
  // company pages live under `default`. Passing no sourceIds indexes every
  // source so a mail in one source resolves to a person in another.
  const rows = sourceIds && sourceIds.length
    ? await engine.executeRaw<{ slug: string; title: string; compiled_truth: string | null; source_id: string }>(
        `SELECT slug, COALESCE(title,'') AS title, COALESCE(compiled_truth,'') AS compiled_truth, source_id
           FROM pages
          WHERE source_id = ANY($1::text[]) AND deleted_at IS NULL AND type IN ('person','company')`,
        [sourceIds],
      )
    : await engine.executeRaw<{ slug: string; title: string; compiled_truth: string | null; source_id: string }>(
        `SELECT slug, COALESCE(title,'') AS title, COALESCE(compiled_truth,'') AS compiled_truth, source_id
           FROM pages
          WHERE deleted_at IS NULL AND type IN ('person','company')`,
      );

  const nameCands = new Map<string, string[]>();
  const slugs = new Set<string>();
  const slugSource = new Map<string, string>();
  // email → candidate owners
  const emailCands = new Map<string, { slug: string; score: number }[]>();

  for (const r of rows) {
    slugs.add(r.slug);
    if (!slugSource.has(r.slug)) slugSource.set(r.slug, r.source_id);
    const nameKey = slugify(r.title || r.slug);
    if (nameKey) {
      const arr = nameCands.get(nameKey) ?? [];
      if (!arr.includes(r.slug)) arr.push(r.slug);
      nameCands.set(nameKey, arr);
    }
    const found = new Set<string>();
    for (const m of (r.compiled_truth || '').matchAll(EMAIL_RE_G)) found.add(m[0].toLowerCase());
    for (const email of found) {
      const local = email.split('@')[0];
      const arr = emailCands.get(email) ?? [];
      arr.push({ slug: r.slug, score: localOwnerScore(local, r.slug, r.title) });
      emailCands.set(email, arr);
    }
  }

  const byEmail = new Map<string, string[]>();
  for (const [email, cands] of emailCands) {
    cands.sort((a, b) => b.score - a.score || a.slug.localeCompare(b.slug));
    const top = cands[0];
    // Ambiguous only when several DISTINCT-owner pages tie at zero overlap —
    // then we cannot tell whose address it is, so we skip rather than guess.
    if (top.score === 0 && cands.length > 1) continue;
    // Keep every page that ties at the top score — these are the duplicate
    // pages of the SAME owner (identical local-part overlap), so all should be
    // covered. A single winner is the common case.
    const winners = cands.filter((c) => c.score === top.score).map((c) => c.slug);
    byEmail.set(email, [...new Set(winners)]);
  }

  // Sort name candidates deterministically (canonical = lexically first).
  const byName = new Map<string, string[]>();
  for (const [k, v] of nameCands) byName.set(k, [...new Set(v)].sort());

  return { byEmail, byName, slugs, slugSource };
}

/**
 * One resolved participant: the canonical `who` value plus every entity page it
 * maps to (duplicate pages of the same owner all get covered).
 */
export interface ResolvedParticipant {
  value: string;      // canonical slug when resolved; else the raw address/display verbatim
  resolved: boolean;
  slugs: string[];    // all entity pages this participant covers (empty when unresolved)
}

/** Resolve a single parsed participant against the entity index. */
export function resolveParticipant(p: ParsedParticipant, index: EntityIndex): ResolvedParticipant {
  // 1. Primary: exact address match.
  if (p.address) {
    const hit = index.byEmail.get(p.address);
    if (hit && hit.length) return { value: hit[0], resolved: true, slugs: hit };
  }
  // 2. Address local part as a name ("david.costantino" → "david costantino").
  if (p.address) {
    const local = p.address.split('@')[0];
    if (/[._-]/.test(local)) {
      const key = slugify(local.replace(/[._-]+/g, ' '));
      const hit = index.byName.get(key);
      if (hit && hit.length) return { value: hit[0], resolved: true, slugs: hit };
    }
  }
  // 3. Display name against the normalized-title index.
  if (p.displayName) {
    const key = slugify(p.displayName);
    const hit = index.byName.get(key);
    if (hit && hit.length) return { value: hit[0], resolved: true, slugs: hit };
  }
  // 4. Unresolved — keep the address (lowercased) or the raw token verbatim.
  return { value: p.address ?? p.raw, resolved: false, slugs: [] };
}

/**
 * Resolve a mail page's participants to a `who` array of canonical entity slugs
 * (unresolved participants kept verbatim), order-stable and deduped, sender
 * first. Also returns the distinct set of resolved entity slugs for timeline
 * fan-out.
 */
export function resolveMailWho(
  fm: Record<string, unknown>,
  index: EntityIndex,
): { who: string[]; entitySlugs: string[] } {
  const participants = parseMailParticipants(fm);
  const who: string[] = [];
  const whoSeen = new Set<string>();
  const entitySlugs: string[] = [];
  const entitySeen = new Set<string>();
  for (const p of participants) {
    const r = resolveParticipant(p, index);
    if (r.value && !whoSeen.has(r.value)) {
      whoSeen.add(r.value);
      who.push(r.value);
    }
    for (const slug of r.slugs) {
      if (!entitySeen.has(slug)) {
        entitySeen.add(slug);
        entitySlugs.push(slug);
      }
    }
  }
  return { who, entitySlugs };
}
