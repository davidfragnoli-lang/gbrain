import { createHash } from 'node:crypto';
import type { BrainEngine } from '../core/engine.ts';
import { maintenanceTransaction } from '../core/persistence/attribution.ts';
import { opError } from '../core/ops/contract.ts';

interface DanglingAlias {
  table_name: 'slug_aliases' | 'page_aliases';
  alias_key: string;
  target_slug: string;
}

export interface AliasRepairResult {
  kind: 'dangling-aliases';
  mode: 'preview' | 'apply';
  source_id: string;
  affected: number;
  plan_hash: string;
  applied: number;
  remaining: number;
  apply_command?: string;
  sample: DanglingAlias[];
}

async function danglingAliases(engine: BrainEngine, sourceId: string): Promise<DanglingAlias[]> {
  return engine.executeRaw<DanglingAlias>(
    `SELECT 'slug_aliases'::text AS table_name, sa.alias_slug AS alias_key, sa.canonical_slug AS target_slug
       FROM slug_aliases sa
       LEFT JOIN pages p ON p.source_id=sa.source_id AND p.slug=sa.canonical_slug AND p.deleted_at IS NULL
      WHERE sa.source_id=$1 AND p.id IS NULL
     UNION ALL
     SELECT 'page_aliases'::text AS table_name, pa.alias_norm AS alias_key, pa.slug AS target_slug
       FROM page_aliases pa
       LEFT JOIN pages p ON p.source_id=pa.source_id AND p.slug=pa.slug AND p.deleted_at IS NULL
      WHERE pa.source_id=$1 AND p.id IS NULL
      ORDER BY table_name, alias_key, target_slug`, [sourceId]);
}

function planHash(sourceId: string, rows: readonly DanglingAlias[]): string {
  return createHash('sha256').update(JSON.stringify({ source_id: sourceId, rows })).digest('hex');
}

export async function runAliasRepair(
  engine: BrainEngine,
  opts: { source?: string; apply: boolean; expect?: string; json: boolean },
): Promise<void> {
  if (!opts.source) throw opError('invalid_params', 'Dangling-alias repair requires an explicit --source.',
    'Preview one source with: gbrain repair dangling-aliases --source <id> --json');
  const before = await danglingAliases(engine, opts.source);
  const hash = planHash(opts.source, before);
  if (opts.apply && opts.expect !== hash) throw opError('changed_since_preview',
    'The dangling-alias repair plan was not approved or changed after preview.',
    `Preview again with gbrain repair dangling-aliases --source ${opts.source} --json, then apply the returned plan_hash with --expect.`);

  let applied = 0;
  if (opts.apply && before.length) {
    applied = await maintenanceTransaction(engine, async tx => {
      const slugRows = await tx.executeRaw<{ alias_slug: string }>(
        `DELETE FROM slug_aliases sa WHERE sa.source_id=$1 AND NOT EXISTS
          (SELECT 1 FROM pages p WHERE p.source_id=sa.source_id AND p.slug=sa.canonical_slug AND p.deleted_at IS NULL)
          RETURNING sa.alias_slug`, [opts.source]);
      const pageRows = await tx.executeRaw<{ alias_norm: string }>(
        `DELETE FROM page_aliases pa WHERE pa.source_id=$1 AND NOT EXISTS
          (SELECT 1 FROM pages p WHERE p.source_id=pa.source_id AND p.slug=pa.slug AND p.deleted_at IS NULL)
          RETURNING pa.alias_norm`, [opts.source]);
      return slugRows.length + pageRows.length;
    });
  }
  const remaining = opts.apply ? (await danglingAliases(engine, opts.source)).length : before.length;
  const result: AliasRepairResult = {
    kind: 'dangling-aliases', mode: opts.apply ? 'apply' : 'preview', source_id: opts.source,
    affected: before.length, plan_hash: hash, applied, remaining, sample: before.slice(0, 20),
    ...(!opts.apply && before.length ? { apply_command: `gbrain repair dangling-aliases --source ${opts.source} --apply --expect ${hash} --json` } : {}),
  };
  if (opts.json) process.stdout.write(`${JSON.stringify(result)}\n`);
  else {
    console.log(`dangling-aliases: ${before.length} row(s) ${opts.apply ? 'selected' : 'to repair'} in source ${opts.source}`);
    if (opts.apply) console.log(`  applied ${applied}; remaining ${remaining}`);
    else if (result.apply_command) console.log(`  apply: ${result.apply_command}`);
  }
}
