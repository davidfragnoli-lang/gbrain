/**
 * Email → conversation-message adapter (FRA-22807).
 *
 * Problem this closes
 * -------------------
 * `email`-type pages (e.g. the 7,878 `swatch-mail` pages) store their body as
 * RAW Microsoft-Word-generated HTML in `pages.compiled_truth`
 * (`<html><head><style>@font-face…</style></head><body>…`), OR as
 * entity-encoded plain text (`&#8211;`, `&#8217;`). Neither shape is a
 * line-oriented chat transcript, so the built-in conversation parser
 * (`parse.ts`) scores every pattern at ~0 and returns `no_match` → the
 * time-windowed segmenter produces 0 segments → `extract-conversation-facts`
 * yields 0 facts even though the mail carries real graph structure
 * (people / roles / companies / addresses / dates).
 *
 * Approach
 * --------
 * An email is not a many-turn chat; it is one authored message (the sender
 * addressing recipients) that may quote earlier replies inline. We therefore
 * project each email page into a SINGLE conversation message:
 *
 *   - speaker   = the sender's display name (or address) from frontmatter.from
 *   - timestamp = frontmatter.received (falls back to the page date chain)
 *   - text      = an envelope header (Subject / To / Cc) + the HTML-stripped,
 *                 entity-decoded body (quoted history preserved as plain text).
 *
 * The caller segments this with a min-1-message relaxation so a lone email
 * still yields one segment. Keeping it single-segment bounds LLM cost across
 * thousands of pages (the renderer's 6.5K-char cap keeps the newest, most
 * fact-rich top-of-thread content and the envelope header intact).
 *
 * Pure functions, no I/O — the body string is read by the caller via
 * `readConversationBodyForParsing`.
 */

import type { Page } from '../types.ts';
import type { MatchedMessage } from './types.ts';
import { parseParticipantField } from '../chronicle/mail-participants.ts';

/** Page types this adapter handles. Mirrors the mail ingestion type. */
export function looksLikeEmailPage(page: Pick<Page, 'type'>): boolean {
  return page.type === 'email';
}

// ---------------------------------------------------------------------------
// HTML → text.
// ---------------------------------------------------------------------------

const NAMED_ENTITIES: Record<string, string> = {
  nbsp: ' ',
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  mdash: '—',
  ndash: '–',
  rsquo: '’',
  lsquo: '‘',
  rdquo: '”',
  ldquo: '“',
  hellip: '…',
  eacute: 'é',
  egrave: 'è',
  agrave: 'à',
  ccedil: 'ç',
  uuml: 'ü',
  ouml: 'ö',
  auml: 'ä',
  szlig: 'ß',
  bull: '•',
  middot: '·',
  copy: '©',
  reg: '®',
  trade: '™',
  euro: '€',
  pound: '£',
};

/**
 * Decode numeric (`&#8211;`, `&#x2019;`) and a curated set of named HTML
 * entities. Numeric handling is generic so it covers the long tail of
 * Word-emitted punctuation without an exhaustive named table.
 */
export function decodeHtmlEntities(input: string): string {
  return input
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => safeFromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => safeFromCodePoint(parseInt(dec, 10)))
    .replace(/&([a-zA-Z][a-zA-Z0-9]+);/g, (m, name) => {
      const lower = String(name).toLowerCase();
      return Object.prototype.hasOwnProperty.call(NAMED_ENTITIES, lower)
        ? NAMED_ENTITIES[lower]
        : m;
    });
}

function safeFromCodePoint(cp: number): string {
  if (!Number.isFinite(cp) || cp < 0 || cp > 0x10ffff) return '';
  try {
    return String.fromCodePoint(cp);
  } catch {
    return '';
  }
}

/**
 * Strip HTML markup to readable plain text and decode entities. Robust for
 * both full Word HTML blobs and entity-encoded plain text (no tags → decode
 * + whitespace-normalize only, preserving existing line structure).
 */
export function htmlToText(input: string): string {
  let s = input;
  // Drop comments (Word wraps its CSS in `<!-- ... -->`).
  s = s.replace(/<!--[\s\S]*?-->/g, ' ');
  // Drop non-content element bodies entirely.
  s = s.replace(/<style[\s\S]*?<\/style>/gi, ' ');
  s = s.replace(/<script[\s\S]*?<\/script>/gi, ' ');
  s = s.replace(/<head[\s\S]*?<\/head>/gi, ' ');
  // Block / line-break boundaries → newlines so paragraph structure survives.
  s = s.replace(/<\s*br\s*\/?\s*>/gi, '\n');
  s = s.replace(/<\/\s*(p|div|tr|li|h[1-6]|blockquote|table)\s*>/gi, '\n');
  s = s.replace(/<\s*(p|div|tr|li|h[1-6]|blockquote)\b[^>]*>/gi, '\n');
  // Table cells → a space so columns don't glue together.
  s = s.replace(/<\/\s*td\s*>/gi, ' ');
  // Any remaining tag → gone. `</?[a-zA-Z!][^>]*>` targets tag-like spans so
  // prose math ("a < b") survives; angle-bracketed URLs are rare here.
  s = s.replace(/<\/?[a-zA-Z!][^>]*>/g, '');
  // Decode entities AFTER tag removal so a decoded `<`/`>` can't be re-stripped.
  s = decodeHtmlEntities(s);
  // Second strip pass: some emails entity-encode literal markup
  // (`&lt;span…&gt;`) which only becomes a real tag after decoding above.
  s = s.replace(/<\/?[a-zA-Z!][^>]*>/g, '');
  // Some `compiled_truth` blobs are stored truncated mid-tag (e.g. a 4KB cap
  // cutting `…<span lang="DE-CH" style="font-size:10.0pt; f`). Drop a dangling
  // unclosed tag at the very end so it doesn't leak into the extracted text.
  s = s.replace(/<\/?[a-zA-Z!][^>]*$/, '');
  return normalizeWhitespace(s);
}

/** Collapse runaway whitespace while preserving paragraph newlines. */
export function normalizeWhitespace(input: string): string {
  return input
    .replace(/\r\n?/g, '\n')
    .replace(/ /g, ' ')
    .split('\n')
    .map((line) => line.replace(/[ \t\f\v]+/g, ' ').trimEnd())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// ---------------------------------------------------------------------------
// Frontmatter helpers.
// ---------------------------------------------------------------------------

function fmString(fm: Record<string, unknown>, key: string): string | null {
  const v = fm[key];
  return typeof v === 'string' && v.trim().length > 0 ? v.trim() : null;
}

/**
 * Sender label: display name if the parser found one, else the address, else
 * a generic placeholder. Never empty (a segment speaker must be non-blank).
 */
function senderLabel(fm: Record<string, unknown>): string {
  const parsed = parseParticipantField(fm.from);
  const first = parsed[0];
  if (first?.displayName) return first.displayName;
  if (first?.address) return first.address;
  const raw = fmString(fm, 'from');
  return raw ?? 'sender';
}

/**
 * Normalize a `received` value into an ISO string. Accepts ISO already
 * (the common shape) or anything `Date.parse` understands. Returns null on
 * failure so the caller can fall back to the page date chain.
 */
function normalizeReceivedIso(fm: Record<string, unknown>): string | null {
  const raw = fmString(fm, 'received') ?? fmString(fm, 'sent') ?? fmString(fm, 'date');
  if (!raw) return null;
  const ms = Date.parse(raw);
  if (!Number.isFinite(ms)) return null;
  return new Date(ms).toISOString();
}

/** Page-level date fallback when frontmatter carries no usable timestamp. */
function pageDateFallbackIso(page: Page): string {
  const fmDate = page.frontmatter?.date;
  if (typeof fmDate === 'string') {
    const ms = Date.parse(fmDate);
    if (Number.isFinite(ms)) return new Date(ms).toISOString();
  }
  if (page.effective_date) {
    try {
      return new Date(page.effective_date).toISOString();
    } catch {
      /* fall through */
    }
  }
  return '1970-01-01T00:00:00Z';
}

/**
 * Build a compact envelope header so the extractor sees who emailed whom
 * about what — the graph edges that are otherwise invisible in the body.
 */
function buildEnvelope(fm: Record<string, unknown>): string {
  const lines: string[] = [];
  const subject = fmString(fm, 'subject');
  const to = fmString(fm, 'to');
  const cc = fmString(fm, 'cc');
  const from = fmString(fm, 'from');
  if (subject) lines.push(`Subject: ${subject}`);
  if (from) lines.push(`From: ${from}`);
  if (to) lines.push(`To: ${to}`);
  if (cc) lines.push(`Cc: ${cc}`);
  return lines.join('\n');
}

/** Drop a leading `# <subject>` markdown H1 the ingester prepends. */
function stripLeadingSubjectHeading(body: string): string {
  return body.replace(/^\s*#\s+.*(?:\n|$)/, '');
}

// ---------------------------------------------------------------------------
// Public entry point.
// ---------------------------------------------------------------------------

/**
 * Project an email page into conversation messages. Returns a single message
 * (sender + received + envelope + cleaned body) or `[]` when the email has no
 * extractable body text at all.
 */
export function parseEmailToMessages(page: Page, body: string): MatchedMessage[] {
  const fm: Record<string, unknown> = page.frontmatter ?? {};
  const speaker = senderLabel(fm);
  const timestamp = normalizeReceivedIso(fm) ?? pageDateFallbackIso(page);

  const cleanedBody = htmlToText(stripLeadingSubjectHeading(body ?? ''));
  const envelope = buildEnvelope(fm);

  const text = [envelope, cleanedBody].filter((s) => s.length > 0).join('\n\n').trim();
  if (!text) return [];

  return [{ speaker, timestamp, text }];
}
