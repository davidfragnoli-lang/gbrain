#!/usr/bin/env bun
// FRA-1426 — backfill: resolve mail participants to entity slugs and fan out
// contact timeline rows so `doctor graph_coverage` timeline coverage clears.
//
// Idempotent. Reads the brain engine from ~/.gbrain config (Postgres) or falls
// back to nothing (this pass only makes sense against the live brain).
//   bun scripts/fra-1426-project-participants.ts [--source default] [--dry]
import { PostgresEngine } from '../src/core/postgres-engine.ts';
import { loadConfig } from '../src/core/config.ts';
import { runMailParticipantProjection } from '../src/core/chronicle/project-participants.ts';
import { buildEntityIndex } from '../src/core/chronicle/mail-participants.ts';
import type { BrainEngine } from '../src/core/engine.ts';

async function main() {
  const args = process.argv.slice(2);
  // --source = the source holding the mail EVENT pages (default: swatch-mail).
  const sIdx = args.indexOf('--source');
  const sourceId = sIdx >= 0 && args[sIdx + 1] && !args[sIdx + 1].startsWith('--') ? args[sIdx + 1] : 'swatch-mail';

  const cfg = loadConfig();
  if (!cfg?.database_url) {
    process.stderr.write('[fra-1426] no database_url in ~/.gbrain config — this pass runs against the live brain only\n');
    process.exit(1);
  }
  const engine: BrainEngine = new PostgresEngine();
  await engine.connect({ database_url: cfg.database_url });

  // Cross-source entity index (persons in `default`; mail events in --source).
  const index = await buildEntityIndex(engine);
  process.stdout.write(`[fra-1426] entity index: ${index.byEmail.size} emails, ${index.byName.size} names, ${index.slugs.size} entity pages\n`);
  process.stdout.write(`[fra-1426] mail event source: ${sourceId}\n`);

  const res = await runMailParticipantProjection(engine, {
    sourceId,
    index,
    onProgress: (done, total) => process.stdout.write(`[fra-1426] ${done}/${total} events\n`),
  });
  process.stdout.write(`[fra-1426] DONE ${JSON.stringify(res, null, 2)}\n`);
  await engine.close?.();
}

main().catch((e) => { process.stderr.write(String(e?.stack || e) + '\n'); process.exit(1); });
