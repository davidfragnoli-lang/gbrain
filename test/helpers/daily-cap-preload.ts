/**
 * Pre-test setup: disable the cross-process DAILY spend ceiling for the suite.
 *
 * Why this exists (FRA-22903): `BudgetTracker` resolves its day ceiling from
 * `GBRAIN_MAX_DAILY_COST_USD`, falling back to `DEFAULT_MAX_DAILY_COST_USD`
 * ($100). That is an *operator environment* knob, and letting it reach the test
 * suite made 21 tests in `test/extract-conversation-facts.test.ts` fail on a
 * machine that had legitimately tuned it down:
 *
 *   GBRAIN_MAX_DAILY_COST_USD=10  -> 39 pass / 21 fail
 *   GBRAIN_MAX_DAILY_COST_USD=off -> 60 pass /  0 fail
 *
 * The mechanism: the ceiling is enforced against the *accumulated* budget
 * ledger, and `audit-dir-preload.ts` gives the process its own scratch ledger.
 * Every fixture extraction in a file appends priced rows to that one ledger, so
 * spend accrues monotonically across the file until it crosses the operator's
 * cap — after which `reserve()` denies, extraction silently does no work, and
 * assertions on downstream effects (`pages_skipped_completed`, terminal audit
 * rows) fail. The failures therefore depend on *test order and count*, not on
 * the code under test, and a machine with the $100 default merely trips later
 * rather than never.
 *
 * `off` rather than a large number: any finite ceiling is still a function of
 * how much fixture spend the suite happens to accrue, so raising it only moves
 * the cliff. Tests that exist to exercise the ceiling are unaffected — they
 * either pass `maxDailyCostUsd` explicitly to `BudgetTracker` (an explicit
 * option outranks the env, see `resolveDailyCapUsd`) or wrap the env with
 * `withEnv`, which saves and restores around whatever this preload set.
 *
 * Unconditional on purpose, unlike `audit-dir-preload.ts`'s "only if unset".
 * Honoring a pre-existing value is what produced the bug: the suite must not
 * pass or fail based on the operator's billing configuration.
 *
 * Imported by `bunfig.toml` via
 * `preload = [..., "./test/helpers/daily-cap-preload.ts"]`.
 */

process.env.GBRAIN_MAX_DAILY_COST_USD = 'off';

if (process.env.GBRAIN_DEBUG_PRELOAD === '1') {
  console.error('[daily-cap-preload] GBRAIN_MAX_DAILY_COST_USD=off');
}
