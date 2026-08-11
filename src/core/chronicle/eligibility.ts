// v0.42.x — Life Chronicle (#2390) chronicle-extract eligibility.
// Mirrors src/core/facts/eligibility.ts. A page is chronicle-eligible (auto-
// emits timeline events) when it is conversation-shape, NOT dream-generated,
// and NOT a diary/event page. Diary interiority is NEVER mined into events
// (privacy/consent — plan D5.4); event pages are already the output (anti-loop).
import type { PageType } from '../types.ts';

export type ChronicleEligibility = { ok: true } | { ok: false; reason: string };

// email (FRA-1316): an ingested mail maps to exactly ONE header-derived event
// (when=received, who=from/to, what=subject via mail-event.ts), so it is an
// event source alongside transcript-shaped pages — and unlike them, its body
// length is irrelevant (see the mail body-gate exemption below).
const ELIGIBLE_TYPES: PageType[] = ['meeting', 'conversation', 'calendar-event', 'email'];
// Directory rescue: a meetings/… page that frontmatter-typed itself 'note' is
// still conversation-shape. life/diary excluded explicitly below.
const RESCUE_SLUG_PREFIXES = ['meetings/', 'conversations/', 'cal/', 'calendar/', 'emails/', 'email/'] as const;
const MIN_BODY_CHARS = 80;

/** A mail page: header-derived event, so the body-length gate does not apply. */
function isMailShape(type: PageType, slug: string): boolean {
  return type === 'email' || slug.startsWith('emails/') || slug.startsWith('email/');
}

export function isChronicleEligible(input: {
  type: PageType;
  slug: string;
  body?: string;
  dreamGenerated?: boolean;
}): ChronicleEligibility {
  const { type, slug } = input;
  if (input.dreamGenerated === true) return { ok: false, reason: 'dream_generated' };
  // Diary: never extract events from private interiority. Event: anti-loop.
  if (type === 'diary' || slug.startsWith('life/diary/')) return { ok: false, reason: 'diary_excluded' };
  if (type === 'event' || slug.startsWith('life/events/')) return { ok: false, reason: 'event_self' };
  if (slug.startsWith('wiki/agents/')) return { ok: false, reason: 'subagent_scratch' };
  // Mail events are header-derived; a one-line mail must still emit its event.
  // The body-length gate applies only to transcript-shaped pages.
  const bodyOk = isMailShape(type, slug) || (input.body?.length ?? MIN_BODY_CHARS) >= MIN_BODY_CHARS;
  if (!bodyOk) return { ok: false, reason: 'too_short' };
  const typeOk = ELIGIBLE_TYPES.includes(type);
  const slugOk = RESCUE_SLUG_PREFIXES.some((p) => slug.startsWith(p));
  if (!typeOk && !slugOk) return { ok: false, reason: `kind:${type}` };
  return { ok: true };
}
