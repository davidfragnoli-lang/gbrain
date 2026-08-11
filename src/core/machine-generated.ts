/**
 * Machine-generated derivative-register marker (FRA-23172).
 *
 * Some ingest lanes compile a *register* page: a machine-authored roll-up of
 * OCR strings, vision captions and ASR transcripts, one page per zone/date,
 * emitted from a manifest. `brain/media/warehouse-photos/*` (vision-mining)
 * and `brain/media/warehouse-walkthroughs/*` (walkthrough ASR) are the
 * canonical examples. They look like prose to every layer below them.
 *
 * Why this marker has to exist at all
 * -----------------------------------
 * The obvious place to encode "this text is machine-generated" is
 * `content_chunks.chunk_source`. It does not work: these lanes write their
 * output into ordinary markdown page bodies, so the chunker labels every one
 * of them `compiled_truth` — byte-identical in provenance to a hand-written
 * paragraph. Measured on the Fragno brain at the time of writing: 10,985
 * `compiled_truth` / 10 `timeline` / 6 `fenced_code` / **0 `image_asset`**.
 * There is no chunk-grain signal to key off. The provenance is only known at
 * the moment the register is compiled, so that is where it must be stamped.
 *
 * Why it matters for ranking
 * --------------------------
 * A register page is a lexical decoy. It is long, dense with domain
 * vocabulary, and it frequently holds the ONLY literal occurrence of a term
 * in the whole corpus — so it wins an exact-match race against the authored
 * narrative page a human would call correct. Observed: the query
 * "AutoStore feasibility Swatch warehouse" returned a photo register at rank
 * 1 on the strength of `- OCR: F, AUTOSTORE` (a yellow zone sign), with 6 of
 * 10 top slots taken by the same lane. A zone label on a sign is not a
 * topical statement about AutoStore feasibility.
 *
 * `DEFAULT_SOURCE_BOOSTS` already encodes this exact prior for other bulk
 * lanes (`openclaw/chat/` 0.5 — "chat transcripts … swamp keyword queries").
 * But it is keyed by SLUG PREFIX, so it only fires for brains that happen to
 * file their content under the upstream namespaces; a brain that roots every
 * slug under `brain/` gets no authority prior at all, and refiling a page
 * silently changes its ranking authority. This marker is provenance-derived
 * instead: it travels with the page, independent of where it is filed.
 *
 * DEMOTE, never hide
 * ------------------
 * Same call as `archive/` (issue #1777): register pages are genuinely the
 * right answer for "show me the photos of zone F", so they stay fully
 * searchable and the cross-encoder reranker can still promote a strongly
 * matching one. They just cannot outrank authored narrative on a bare
 * keyword collision.
 *
 * Sibling of `src/core/quarantine.ts` and `src/core/extraction-review.ts` —
 * same marker-as-frontmatter-key pattern, same JSONB predicate that behaves
 * identically on Postgres and PGLite. No schema migration.
 */

/**
 * Frontmatter key stamped by a lane that compiles a machine-generated
 * derivative register. Stable contract — ingest writers and the search
 * ranking layer both import it from here so they cannot drift.
 */
export const MACHINE_GENERATED_KEY = 'machine_generated';

/**
 * Ranking factor applied to a page carrying the marker.
 *
 * 0.25 is a DEMOTE, not an exclusion — deliberately between `archive/` (0.5,
 * "high-signal history, just not first") and `extracts/` (0.3, "surface when
 * relevant, never dominate"). A register page is closer to the latter.
 *
 * Chosen empirically on the Fragno brain: swept 0.5 / 0.3 / 0.1 against the
 * 7-query correctness gate. All three cut derivative-register crowding
 * without moving any query's relevant-set membership, so the value is pinned
 * at the conservative end of the range that showed the effect.
 */
export const DEFAULT_MACHINE_GENERATED_FACTOR = 0.25;

/**
 * Resolve the effective factor, honouring `GBRAIN_MACHINE_GENERATED_BOOST`.
 *
 * Mirrors `parseSourceBoostEnv`'s validation exactly (finite, >= 0), so the
 * value is safe to inline as a bare SQL literal. A malformed or negative
 * value falls back to the default rather than throwing — a bad env var must
 * never take search down.
 *
 * A value of 1.0 disables the demote without needing a code change.
 */
export function resolveMachineGeneratedFactor(
  envValue: string | undefined = process.env.GBRAIN_MACHINE_GENERATED_BOOST,
): number {
  if (envValue === undefined) return DEFAULT_MACHINE_GENERATED_FACTOR;
  const parsed = Number.parseFloat(envValue.trim());
  if (!Number.isFinite(parsed) || parsed < 0) return DEFAULT_MACHINE_GENERATED_FACTOR;
  return parsed;
}

/**
 * SQL predicate: is this page a machine-generated derivative register?
 *
 * JSONB `->>` then compare to the string `'true'` rather than a `?` existence
 * check, so `machine_generated: false` reads as NOT machine-generated. The
 * marker round-trips through YAML frontmatter → `matter.stringify` → JSONB,
 * which renders a YAML boolean as a JSON boolean, whose `->>` text form is
 * exactly `'true'`. A lane that writes the string `"true"` also matches.
 *
 * @param pageAlias — page table alias (e.g. `'p'`). Engine-supplied, never
 *                    user input.
 */
export function machineGeneratedFragment(pageAlias: string): string {
  return `(COALESCE(${pageAlias}.frontmatter, '{}'::jsonb) ->> '${MACHINE_GENERATED_KEY}') = 'true'`;
}
