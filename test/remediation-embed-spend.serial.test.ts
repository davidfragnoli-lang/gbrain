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

const catchUp = () => makeRemediationStep({
  id: 'test.embed-catch-up', job: 'embed-catch-up', params: { sourceId: 'default' },
  severity: 'medium', est_seconds: 5, est_usd_cost: 0,
  rationale: 'exercise the real remediation queue and registered handler', status: 'remediable',
});

describe('remediation queued embedding spend', () => {
  test('approved cap survives real queue storage and registered embed-catch-up execution', async () => {
    const result = await runRemediation(engine, {
      targetScore: 0, inlineJobs: true, maxJobs: 1, maxUsd: 0.75,
      capSource: 'user', extraRemediations: [catchUp()],
    });
    const jobId = result.submitted[0]?.job_id;
    expect(jobId).toBeNumber();

    const stored = await new MinionQueue(engine).getJob(jobId!);
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
});
