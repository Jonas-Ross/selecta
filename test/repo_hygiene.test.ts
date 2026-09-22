import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const guard = join(import.meta.dirname, '..', 'scripts', 'check-no-binaries.sh');

function repoWith(files: Record<string, Buffer | string>): string {
  const directory = mkdtempSync(join(tmpdir(), 'selecta-hygiene-'));

  execFileSync('git', ['init', '-q'], { cwd: directory });

  for (const [name, body] of Object.entries(files)) writeFileSync(join(directory, name), body);

  execFileSync('git', ['add', '-A'], { cwd: directory });

  return directory;
}

function run(directory: string): { code: number; stderr: string } {
  try {
    execFileSync(guard, { cwd: directory, encoding: 'utf8', stdio: 'pipe' });

    return { code: 0, stderr: '' };
  } catch (error) {
    const failure = error as { status: number; stderr: string };

    return { code: failure.status, stderr: failure.stderr };
  }
}

// The database that reached main was named `x`, so every case here is about
// what the file contains rather than what it is called.
describe('check-no-binaries', () => {
  it('passes a repository of ordinary source files', () => {
    expect(run(repoWith({ 'index.ts': 'export const a = 1;\n' }))).toMatchObject({ code: 0 });
  });

  it('rejects a SQLite database whose name gives nothing away', () => {
    const database = Buffer.concat([Buffer.from('SQLite format 3\0'), Buffer.alloc(64)]);
    const { code, stderr } = run(repoWith({ x: database }));

    expect(code).toBe(1);
    expect(stderr).toContain('x is a SQLite database');
  });

  it('rejects a large binary that is not a database', () => {
    const { code, stderr } = run(repoWith({ blob: Buffer.alloc(70_000) }));

    expect(code).toBe(1);
    expect(stderr).toContain('bytes of binary data');
  });

  it('allows a small binary fixture', () => {
    expect(run(repoWith({ 'icon.png': Buffer.alloc(512) }))).toMatchObject({ code: 0 });
  });

  it('finds nothing to reject in this repository', () => {
    expect(run(join(import.meta.dirname, '..'))).toMatchObject({ code: 0 });
  });
});
