// FRA-22884 — non-bold `- YYYY-MM-DD — summary` bullets under a `## Timeline`
// heading are real entries; the same shape in ordinary prose still is not.

import { test, expect } from 'bun:test';
import { parseTimelineEntries } from '../src/core/link-extraction.ts';

// UPSTREAM INVARIANT: plain ASCII date bullets in ordinary prose are NOT events.
test('plain ASCII date bullet outside a Timeline section is still ignored', () => {
  const md = `# Notes\n\n## Steps\n\n- 2020-01-02 - bought milk\n- 2020-01-03 — did a thing\n`;
  expect(parseTimelineEntries(md)).toEqual([]);
});

test('bold form still parses anywhere (unchanged)', () => {
  const md = `## Steps\n\n- **2020-01-02** | bought milk\n`;
  const r = parseTimelineEntries(md);
  expect(r.length).toBe(1);
  expect(r[0].date).toBe('2020-01-02');
});

// NEW: the real curated-page shape.
test('plain bullets under ## Timeline are parsed', () => {
  const md = `# Greta\n\n## Timeline / evidence\n\n- 2023-07-11 — Connected on LinkedIn\n- 2025-10-07 — Sent a job posting\n`;
  const r = parseTimelineEntries(md);
  expect(r.map(e => e.date)).toEqual(['2023-07-11', '2025-10-07']);
  expect(r[0].summary).toBe('Connected on LinkedIn');
  expect(r[0].detail).toBe('');
});

test('section closes at the next non-timeline heading', () => {
  const md = `## Timeline\n\n- 2023-07-11 — real event\n\n## Other\n\n- 2024-01-01 — prose bullet\n`;
  const r = parseTimelineEntries(md);
  expect(r.map(e => e.date)).toEqual(['2023-07-11']);
});

test('no duplicate when a Timeline bullet carries its own citation', () => {
  const md = `## Timeline\n\n- 2023-07-11 — Signed thing [Source: contract.pdf, 2023-07-11]\n`;
  const r = parseTimelineEntries(md);
  expect(r.length).toBe(1);
});

test('invalid calendar dates are still rejected', () => {
  const md = `## Timeline\n\n- 2026-02-30 — impossible\n`;
  expect(parseTimelineEntries(md)).toEqual([]);
});
