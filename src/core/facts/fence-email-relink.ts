import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import type { BrainEngine } from '../engine.ts';
import type { GBrainConfig } from '../config.ts';
import { normalizeAlias } from '../search/alias-normalize.ts';
import { relinkFactHash,submitRelinkGroup } from './relink-publish.ts';
import { readFacts } from '../persistence/prepared-maintenance.ts';

export interface FenceEmailOptions { sourceId:string; indexPath:string; dryRun?:boolean; limit?:number; factSource?:string; config?:GBrainConfig }
export interface FenceEmailReport { schema_version:1;run_id:string;dry_run:boolean;source_id:string;scanned:number;eligible:number;linked:number;already_linked:number;ambiguous:number;no_match:number;revision_conflict:number;examples:Array<{id:number;email:string;target:string}> }
type Proposal={email:string;slug:string};

export async function runFenceEmailRelink(engine:BrainEngine,opts:FenceEmailOptions):Promise<FenceEmailReport>{
 const runId=randomUUID(); const report:FenceEmailReport={schema_version:1,run_id:runId,dry_run:!!opts.dryRun,source_id:opts.sourceId,scanned:0,eligible:0,linked:0,already_linked:0,ambiguous:0,no_match:0,revision_conflict:0,examples:[]};
 const parsed=JSON.parse(await readFile(opts.indexPath,'utf8')); const bySlug=new Map<string,Proposal[]>();
 for(const m of parsed.message_index??[])bySlug.set(String(m.page_slug),Array.isArray(m.resolved_email_targets)?m.resolved_email_targets:[]);
 const people=await engine.executeRaw<{slug:string;compiled_truth:string;frontmatter:string}>(`SELECT slug,compiled_truth,frontmatter::text AS frontmatter FROM pages WHERE source_id<>$1 AND deleted_at IS NULL AND (slug LIKE 'people/%' OR slug LIKE 'brain/people/%')`,[opts.sourceId]);
 const exactEmail=new Map<string,string|null>(); const emailRe=/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
 for(const p of people){const slug=p.slug.replace(/^brain\//,'');for(const email of new Set((`${p.frontmatter??''}\n${p.compiled_truth??''}`.match(emailRe)??[]).map(x=>x.toLowerCase()))){if(!exactEmail.has(email))exactEmail.set(email,slug);else if(exactEmail.get(email)!==slug)exactEmail.set(email,null)}}
 const rows=await engine.executeRaw<{id:number|string;source_markdown_slug:string;source:string|null;entity_slug:string|null}>(`SELECT id,source_markdown_slug,source,entity_slug FROM facts WHERE source_id=$1 AND entity_slug IS NULL AND expired_at IS NULL AND source_markdown_slug LIKE 'emails/%' AND row_num IS NOT NULL AND (valid_until IS NULL OR valid_until>now()) AND source=$2 ORDER BY id LIMIT $3`,[opts.sourceId,opts.factSource??'cli:extract-conversation-facts',opts.limit??1000]); report.scanned=rows.length;
 for(const row of rows){const candidates=bySlug.get(row.source_markdown_slug)??[];if(!candidates.length){report.no_match++;continue}if(candidates.length!==1){report.ambiguous++;continue}const proposed=candidates[0]!,norm=normalizeAlias(proposed.email);
  if(exactEmail.get(norm)!==proposed.slug){report.ambiguous++;continue}report.eligible++;if(row.entity_slug===proposed.slug){report.already_linked++;continue}if(row.entity_slug!==null){report.ambiguous++;continue}if(report.examples.length<5)report.examples.push({id:Number(row.id),email:proposed.email,target:proposed.slug});if(opts.dryRun){report.linked++;continue}
  const [snap]=await readFacts(engine,opts.sourceId,[Number(row.id)]);if(!snap){report.revision_conflict++;continue}
  const result=await submitRelinkGroup(engine,opts.config??({engine:engine.kind} as GBrainConfig),opts.sourceId,row.source_markdown_slug,{kind:'relink_facts',run_id:runId,queue_conflict:false,preserve_source_fence:true,facts:[{id:Number(row.id),hash:relinkFactHash(snap),tier:'exact_email',model:null,note:`entity linked by exact email ${proposed.email}`,target_slug:proposed.slug}]});if(result.ok&&result.outcome.linked.length===1)report.linked++;else report.revision_conflict++;
 }return report;
}
