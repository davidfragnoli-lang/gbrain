import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, describe, expect, test } from 'bun:test';

import { makeScratchConformanceHome } from '../src/commands/protocol.ts';

const cleanup: Array<() => void> = [];

afterEach(() => {
  while (cleanup.length > 0) {
    try { cleanup.pop()?.(); } catch { /* best-effort */ }
  }
});

describe('makeScratchConformanceHome', () => {
  test('creates a hermetic pglite GBRAIN_HOME for self-conformance and cleans it up', () => {
    const scratch = makeScratchConformanceHome();
    cleanup.push(scratch.cleanup);

    const configPath = join(scratch.home, '.gbrain', 'config.json');
    expect(existsSync(configPath)).toBe(true);

    const config = JSON.parse(readFileSync(configPath, 'utf-8')) as {
      engine: string;
      database_path: string;
      mcp_surface: string;
    };
    expect(config.engine).toBe('pglite');
    expect(config.mcp_surface).toBe('full');
    expect(config.database_path).toContain('.gbrain/conformance.pglite');

    scratch.cleanup();
    cleanup.pop();
    expect(existsSync(scratch.home)).toBe(false);
  });
});
