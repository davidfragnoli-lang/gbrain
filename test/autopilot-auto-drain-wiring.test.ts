/**
 * #1685 GAP D — autopilot auto-drain wiring regression guards.
 *
 * The submission is inline in the autopilot tick body, so these are
 * source-shape assertions (the proven `autopilot-*-wiring.test.ts` pattern).
 * The load-bearing one is CODEX #2: the idempotency key MUST carry a time slot,
 * else queue.add returns the first completed job forever and the source never
 * drains again.
 */
import { describe, test, expect } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';

const SRC = readFileSync(join(import.meta.dir, '../src/commands/autopilot.ts'), 'utf8');

describe('autopilot auto-drain wiring', () => {
  test('CODEX #2: idempotency key includes a UTC-day time slot (not static)', () => {
    expect(SRC).toContain('autopilot-extract-atoms-drain:${src.id}:${utcDay}');
    // A static key would be the regression — guard against the bare form.
    expect(SRC).not.toContain('`autopilot-extract-atoms-drain:${src.id}`');
  });

  test('CODEX #1: submits with allowProtectedSubmit', () => {
    // FRA-23119: was `/extract-atoms-drain[\s\S]{0,800}allowProtectedSubmit/`.
    // That char-distance proximity match is brittle — FRA-23078 (fcb86402)
    // added the `queue: MAINTENANCE_QUEUE` block and pushed the gap to 849
    // chars, silently breaking this guard at HEAD. Anchor on the submit call
    // site instead, like the max_attempts guard below, so explanatory comments
    // can't turn a real regression guard into a red test.
    const callSite = SRC.lastIndexOf("'extract-atoms-drain'");
    expect(callSite).toBeGreaterThan(-1);
    expect(SRC.slice(callSite, callSite + 1200)).toContain('allowProtectedSubmit: true');
  });

  test('CODEX #3: enumerates sources and counts backlog per source', () => {
    expect(SRC).toContain('loadAllSources(engine)');
    expect(SRC).toContain('countExtractAtomsBacklog(engine, src.id)');
  });

  test('gates on pack NOT declaring extract_atoms (the silent-backlog condition)', () => {
    expect(SRC).toContain("packDeclaresPhase(engine, 'extract_atoms')");
  });

  test('gates on the enabled flag and a daily spend cap (DECISION 3C)', () => {
    expect(SRC).toContain('autopilot.auto_drain.enabled');
    expect(SRC).toContain('autopilot.auto_drain.max_usd_per_day');
    expect(SRC).toContain('maxJobsToday');
  });

  test('is Postgres-gated (PGLite has no worker surface)', () => {
    expect(SRC).toMatch(/engine\.kind === 'postgres'[\s\S]{0,400}auto_drain/);
  });

  // issue #3218 (codex P1): with the handler now throwing on an
  // all-provider-failed batch, max_attempts:1 made the queue's retry policy
  // "dead-letter on the first failure, no backoff attempt" — regression-guard
  // against silently reverting to 1.
  test('issue #3218: submits with max_attempts 3 (not 1) so a retry can backoff before dead-lettering', () => {
    // lastIndexOf: the queue.add(...) call site itself (the earlier occurrence
    // is the unrelated created_at count query above it in the same function).
    const callSite = SRC.lastIndexOf("'extract-atoms-drain'");
    const drainBlock = SRC.slice(callSite, callSite + 900);
    expect(drainBlock).toContain('max_attempts: 3');
    expect(drainBlock).not.toContain('max_attempts: 1');
  });

  test('CODEX impl #4: no maxWaiting (it coalesces by name+queue, not source)', () => {
    // maxWaiting would return source A's waiting job for source B's submit,
    // never queuing B and over-counting the cap. The per-source idempotency key
    // is the dedup; a pre-check on it avoids counting idempotency-hit re-submits.
    const drainBlock = SRC.slice(SRC.indexOf("'extract-atoms-drain'"));
    expect(drainBlock.slice(0, 900)).not.toContain('maxWaiting');
    expect(SRC).toContain('WHERE idempotency_key = $1 LIMIT 1');
  });

  // FRA-23119: the drain is LLM-bound — one batch is up to
  // PAGE_DISCOVERY_BUDGET (50) pages at a measured ~27s/page (~22min). The
  // short interval-derived timeout (600s on a 300s base interval) was always
  // hit mid-first-batch, and handleTimeouts dead-letters terminally, so the
  // job died `timeout exceeded` every night despite real forward progress.
  // Guard that the submission keeps the long (fullCycle) timeout.
  test('FRA-23119: submits with the long fullCycle timeout, not the short interval-derived one', () => {
    expect(SRC).toContain(
      'const drainTimeoutMs = resolveAutopilotDispatchTimeoutMs(baseInterval, true);',
    );
    const callSite = SRC.lastIndexOf("'extract-atoms-drain'");
    const submitBlock = SRC.slice(callSite, callSite + 900);
    expect(submitBlock).toContain('timeout_ms: drainTimeoutMs');
    // The bare `timeoutMs` local is the SHORT interval-derived one (600s on a
    // 300s base interval) — regression-guard against reverting to it here.
    expect(submitBlock).not.toMatch(/timeout_ms:\s*timeoutMs\b/);
  });
});
