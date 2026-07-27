/**
 * FRA-22807 — email adapter tests.
 *
 * Covers the projection of `email`-type pages (Word HTML / entity-encoded
 * plain text) into a single conversation message, plus the orchestrator
 * routing that makes `parseConversation` email-aware so BOTH the extractor
 * and doctor's `conversation_format_coverage` sample stop scoring emails as
 * `_no_match`.
 *
 * Pure-function tests; no PGLite, no LLM.
 */

import { describe, expect, test } from 'bun:test';
import {
  htmlToText,
  decodeHtmlEntities,
  looksLikeEmailPage,
  parseEmailToMessages,
} from '../../src/core/conversation-parser/email.ts';
import { parseConversation } from '../../src/core/conversation-parser/parse.ts';
import type { Page } from '../../src/core/types.ts';

function emailPage(overrides: Partial<Page> = {}): Page {
  return {
    slug: 'emails/2026-07-23-x',
    title: 'Contact Retail',
    type: 'email',
    compiled_truth: '',
    timeline: '',
    frontmatter: {
      from: 'Amaury.Bernardeau@distico.ch',
      to: 'DIS-Dist-DIBI-Logistic@swatchgroup.net',
      cc: 'DIS-Dist-DIBI-Management@swatchgroup.net',
      subject: 'Contact Retail',
      received: '2026-07-23T04:34:59+00:00',
    },
    effective_date: null,
    content_hash: 'h',
    ...overrides,
  } as unknown as Page;
}

describe('decodeHtmlEntities', () => {
  test('numeric decimal + hex + named', () => {
    expect(decodeHtmlEntities('CHF 14&#8217;000 &#x2013; done &amp; &nbsp;end')).toBe(
      'CHF 14’000 – done &  end',
    );
  });

  test('leaves unknown named entities untouched', () => {
    expect(decodeHtmlEntities('a &notareal; b')).toBe('a &notareal; b');
  });
});

describe('htmlToText', () => {
  test('strips Word HTML, style block, and decodes entities', () => {
    const html =
      '<html><head><style><!--\n@font-face {font-family:Calibri}\n--></style></head>' +
      '<body><p class="MsoNormal"><span>Bonjour,</span></p>' +
      '<p>Contact <a href="mailto:x@y.net">x@y.net</a></p></body></html>';
    const text = htmlToText(html);
    expect(text).not.toContain('<');
    expect(text).not.toContain('font-face');
    expect(text).toContain('Bonjour,');
    expect(text).toContain('x@y.net');
  });

  test('drops a trailing tag truncated mid-attribute (storage 4KB cap artifact)', () => {
    const text = htmlToText('Switzerland<span lang="DE-CH" style="font-size:10.0pt; f');
    expect(text).toBe('Switzerland');
  });

  test('removes entity-encoded markup that decodes into a real tag', () => {
    expect(htmlToText('sig &lt;span style=&quot;x&quot;&gt;')).toBe('sig');
  });

  test('plain text with entities keeps newline structure', () => {
    const text = htmlToText('Dear Daniel,\n\n1. Scanners &#8211; 30 units\nCost: CHF 2&#8217;950');
    expect(text).toContain('Scanners – 30 units');
    expect(text).toContain('CHF 2’950');
    expect(text.split('\n').length).toBeGreaterThan(1);
  });
});

describe('looksLikeEmailPage', () => {
  test('true only for email type', () => {
    expect(looksLikeEmailPage({ type: 'email' } as Page)).toBe(true);
    expect(looksLikeEmailPage({ type: 'meeting' } as Page)).toBe(false);
    expect(looksLikeEmailPage({ type: 'conversation' } as Page)).toBe(false);
  });
});

describe('parseEmailToMessages', () => {
  test('projects an HTML email into one sender message with envelope + body', () => {
    const page = emailPage({
      compiled_truth:
        '# Contact Retail\n\n<html><body><p><span>Bonjour, merci de contacter ' +
        '<a href="mailto:DIS-Dist-DIBI-Retail@swatchgroup.net">DIS-Dist-DIBI-Retail@swatchgroup.net</a></span></p>' +
        '<p>Amaury Bernardeau</p><p>Logistics Manager</p></body></html>',
    });
    const msgs = parseEmailToMessages(page, page.compiled_truth ?? '');
    expect(msgs).toHaveLength(1);
    expect(msgs[0].speaker).toBe('amaury.bernardeau@distico.ch');
    expect(msgs[0].timestamp).toBe('2026-07-23T04:34:59.000Z');
    // Envelope header present.
    expect(msgs[0].text).toContain('Subject: Contact Retail');
    expect(msgs[0].text).toContain('To: DIS-Dist-DIBI-Logistic@swatchgroup.net');
    // Body cleaned of HTML.
    expect(msgs[0].text).not.toContain('<');
    expect(msgs[0].text).toContain('Amaury Bernardeau');
    expect(msgs[0].text).toContain('Logistics Manager');
  });

  test('uses display name when frontmatter.from carries one', () => {
    const page = emailPage({
      frontmatter: {
        from: '"Manzano, Sylvain - Distico" <sylvain.manzano@distico.ch>',
        subject: 'EWM',
        received: '2025-09-25T13:40:04+00:00',
      },
      compiled_truth: 'Dear Daniel, budget is CHF 17&#8217;000',
    });
    const msgs = parseEmailToMessages(page, page.compiled_truth ?? '');
    expect(msgs[0].speaker).toContain('Sylvain');
    expect(msgs[0].text).toContain('CHF 17’000');
  });

  test('falls back to page date chain when received is unparseable', () => {
    const page = emailPage({
      frontmatter: { from: 'a@b.com', subject: 'x', received: 'not-a-date' },
      effective_date: new Date('2025-01-02T00:00:00Z'),
      compiled_truth: 'hello world body',
    });
    const msgs = parseEmailToMessages(page, page.compiled_truth ?? '');
    expect(msgs[0].timestamp).toBe('2025-01-02T00:00:00.000Z');
  });

  test('empty body yields no messages', () => {
    const page = emailPage({ frontmatter: {}, compiled_truth: '   ' });
    expect(parseEmailToMessages(page, '   ')).toHaveLength(0);
  });
});

describe('parseConversation email routing', () => {
  test('email page returns phase=email with one message (bypasses regex scoring)', () => {
    const page = emailPage({ compiled_truth: '# Subj\n\n<p>real body text here</p>' });
    const result = parseConversation(page.compiled_truth ?? '', { page });
    expect(result.phase).toBe('email');
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0].text).toContain('real body text here');
  });

  test('email page with empty body → no_match (stays honest for coverage)', () => {
    const page = emailPage({ frontmatter: {}, compiled_truth: '' });
    // Empty body short-circuits before routing; still no_match.
    expect(parseConversation('', { page }).phase).toBe('no_match');
  });

  test('non-email pages are unaffected by the email branch', () => {
    const body = 'Alice (2024-03-15T09:00:00Z): hi\nBob (2024-03-15T09:01:00Z): yo';
    const result = parseConversation(body, {
      page: { type: 'conversation' } as Page,
    });
    expect(result.phase).not.toBe('email');
  });
});
