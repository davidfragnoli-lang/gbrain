import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const realEmbed = await import('../src/commands/embed.ts');
mock.module('../src/commands/embed.ts', () => ({
  ...realEmbed,
  runEmbedCore: async () => ({
    embedded: 0, skipped: 0, would_embed: 0, total_chunks: 0,
    pages_processed: 0, failures: 0, failure_samples: [], dryRun: false,
    chunkless_pages_healed: 0,
  }),
}));

const { PGLiteEngine } = await import('../src/core/pglite-engine.ts');
const { MinionQueue } = await import('../src/core/minions/queue.ts');
const { makeRemediationStep } = await import('../src/core/remediation-step.ts');
const { runRemediation } = await import('../src/core/remediation/run.ts');
const { computePlanHash, saveRemediationCheckpoint } = await import('../src/core/remediation-checkpoint.ts');
const { getCurrentBudgetTracker } = await import('../src/core/ai/gateway.ts');

let engine: InstanceType<typeof PGLiteEngine>;
let home: string;
const previousHome = process.env.GBRAIN_HOME;

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), 'gbrain-remediation-embed-spend-'));
  process.env.GBRAIN_HOME = home;
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 120_000);

afterAll(async () => {
  await engine.disconnect();
  if (previousHome === undefined) delete process.env.GBRAIN_HOME;
  else process.env.GBRAIN_HOME = previousHome;
  rmSync(home, { recursive: true, force: true });
});

const catchUp = (suffix = 'direct') => makeRemediationStep({
  id: `test.embed-catch-up.${suffix}`, job: 'embed-catch-up', params: { sourceId: suffix },
  severity: 'medium', est_seconds: 5, est_usd_cost: 0,
  rationale: 'exercise the real remediation queue and registered handler', status: 'remediable',
});

function checkpoint(step: ReturnType<typeof catchUp>, spentUsd: number) {
  const planHash = computePlanHash([step.id]);
  saveRemediationCheckpoint({
    schema_version: 1, plan_hash: planHash, doctor_run_id: `fixture-${spentUsd}`,
    target_score: 0, started_at: new Date().toISOString(), completed: [],
    aborted_at: new Date().toISOString(), abort_reason: 'budget_exhausted',
    max_usd: 0.75, spent_usd: spentUsd, include_repairs: false,
    manifest: { job_ids: [step.id], repair_kinds: [] },
  });
  return planHash;
}

function meteredRepair() {
  const handler = {
    kind: 'timeline' as const, publication: 'projection' as const,
    async plan() {
      return { items: [{ cursor: { phase: 0, id: 1 }, source_id: 'default', slug: 'fixture/repair', chars: 0, action: 'meter fixture spend' }],
        residuals: {}, llm: { usd: 0.5, cap_remaining_usd: null } };
    },
    async apply() {
      const tracker = getCurrentBudgetTracker()!;
      const before = tracker.totalSpent;
      tracker.record({ modelId: 'anthropic:claude-sonnet-5', inputTokens: 250_000, outputTokens: 0 });
      return { applied: true, outcome: 'fixture repaired', llm_usd: tracker.totalSpent - before };
    },
  };
  return { kind: handler.kind, handler, summary: 'fixture paid repair', embeds: 'none' as const, checks: [], spends: 'llm' as const };
}

async function storedJob(result: Awaited<ReturnType<typeof runRemediation>>) {
  const jobId = result.submitted[0]?.job_id;
  expect(jobId).toBeNumber();
  return { jobId: jobId!, stored: await new MinionQueue(engine).getJob(jobId!) };
}

describe('remediation queued embedding spend', () => {
  test('approved cap survives real queue storage and registered embed-catch-up execution', async () => {
    const result = await runRemediation(engine, {
      targetScore: 0, inlineJobs: true, maxJobs: 1, maxUsd: 0.75,
      capSource: 'user', extraRemediations: [catchUp()],
    });
    const { jobId, stored } = await storedJob(result);
    expect(stored?.spend_authorization).toMatchObject({
      kind: 'authorized', command: 'doctor --remediate', cap_usd: 0.75,
      cap_source: 'user', via: 'max_usd', consented_effects: ['paid'],
    });
    expect(stored?.status).toBe('completed');
    expect(stored?.result).toMatchObject({
      usage: {
        job_id: jobId, spend_basis: {
          basis: 'authorized', authorization: stored?.spend_authorization,
        },
      },
    });
    expect(stored?.progress).toMatchObject({
      phase: 'embed.usage', usage: {
        job_id: jobId, spend_basis: {
          basis: 'authorized', authorization: stored?.spend_authorization,
        },
      },
    });
  }, 120_000);

  test('checkpoint spend reduces the durable worker authorization to the cumulative remainder', async () => {
    const step = catchUp('resume-remainder');
    const result = await runRemediation(engine, {
      targetScore: 0, inlineJobs: true, maxJobs: 1, resume: true,
      resumePlanHash: checkpoint(step, 0.5), extraRemediations: [step],
    });
    const { stored } = await storedJob(result);
    expect(stored?.spend_authorization).toMatchObject({ cap_usd: 0.25, command: 'doctor --remediate' });
    expect(stored?.result).toMatchObject({ usage: { spend_basis: { authorization: { cap_usd: 0.25 } } } });
    expect(stored?.progress).toMatchObject({ usage: { spend_basis: { authorization: { cap_usd: 0.25 } } } });
  }, 120_000);

  test('repair spend reduces the durable worker authorization before submission', async () => {
    const step = catchUp('repair-remainder');
    const result = await runRemediation(engine, {
      targetScore: 0, inlineJobs: true, maxJobs: 1, maxUsd: 0.75,
      extraRemediations: [step], repairs: { include: true, remote: false, registry: [meteredRepair()] },
    });
    expect(result.repairs).toMatchObject([{ status: 'completed', applied: 1 }]);
    const { stored } = await storedJob(result);
    expect(stored?.spend_authorization).toMatchObject({ cap_usd: 0.25, command: 'doctor --remediate' });
    expect(stored?.result).toMatchObject({ usage: { spend_basis: { authorization: { cap_usd: 0.25 } } } });
  }, 120_000);

  test('zero cumulative remainder refuses a paid zero-estimate job before queue insertion', async () => {
    const step = catchUp('zero-remainder');
    const before = await engine.executeRaw<{ count: string }>('SELECT count(*)::text AS count FROM minion_jobs');
    const result = await runRemediation(engine, {
      targetScore: 0, inlineJobs: true, maxJobs: 1, resume: true,
      resumePlanHash: checkpoint(step, 0.75), extraRemediations: [step],
    });
    const after = await engine.executeRaw<{ count: string }>('SELECT count(*)::text AS count FROM minion_jobs');
    expect(result.submitted).toEqual([]);
    expect(result.budget_exhausted).toMatchObject({ cap: 0.75, spent: 0.75, reason: 'max_usd' });
    expect(after[0]?.count).toBe(before[0]?.count);
  }, 120_000);
});
