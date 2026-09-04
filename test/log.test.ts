import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createLogger } from '../src/log.js';

describe('debug file logging', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('does not create or append a file unless SELECTA_DEBUG is enabled', () => {
    const directory = mkdtempSync(join(tmpdir(), 'selecta-log-off-'));
    const logPath = join(directory, 'nested', 'selecta.log');
    const stderr: string[] = [];
    const logger = createLogger({
      debugEnabled: () => false,
      logPath,
      writeStderr: (line) => stderr.push(line),
    });

    logger.info('ready');
    logger.debug('hidden');
    logger.error('broken');

    expect(stderr).toEqual(['ready\n', 'broken\n']);
    expect(() => readFileSync(logPath)).toThrow();
  });

  it('appends info, debug, and error lines while preserving stderr', () => {
    const directory = mkdtempSync(join(tmpdir(), 'selecta-log-on-'));
    const logPath = join(directory, 'nested', 'selecta.log');
    const stderr: string[] = [];
    const logger = createLogger({
      debugEnabled: () => true,
      logPath,
      now: () => new Date('2026-09-04T12:00:00.000Z'),
      writeStderr: (line) => stderr.push(line),
    });

    logger.info('ready');
    logger.debug('payload', { count: 2 });
    logger.error('broken');

    expect(stderr).toEqual(['ready\n', 'payload {"count":2}\n', 'broken\n']);
    expect(readFileSync(logPath, 'utf8')).toBe(
      '2026-09-04T12:00:00.000Z INFO ready\n' +
        '2026-09-04T12:00:00.000Z DEBUG payload {"count":2}\n' +
        '2026-09-04T12:00:00.000Z ERROR broken\n',
    );
  });

  it('uses SELECTA_DEBUG=1 as the default file-sink switch', () => {
    vi.stubEnv('SELECTA_DEBUG', '1');
    const directory = mkdtempSync(join(tmpdir(), 'selecta-log-env-'));
    const logPath = join(directory, 'selecta.log');
    const logger = createLogger({ logPath, writeStderr: () => undefined });

    logger.debug('enabled by environment');

    expect(readFileSync(logPath, 'utf8')).toContain('DEBUG enabled by environment');
  });

  it('surfaces a file failure once and keeps logging without throwing', () => {
    const directory = mkdtempSync(join(tmpdir(), 'selecta-log-failure-'));
    const blockedParent = join(directory, 'not-a-directory');
    writeFileSync(blockedParent, 'occupied');
    const stderr: string[] = [];
    const logger = createLogger({
      debugEnabled: () => true,
      logPath: join(blockedParent, 'selecta.log'),
      writeStderr: (line) => stderr.push(line),
    });

    expect(() => {
      logger.info('first');
      logger.error('second');
    }).not.toThrow();
    expect(stderr[0]).toBe('first\n');
    expect(stderr[1]).toContain('[debug-log] Could not append');
    expect(stderr[2]).toBe('second\n');
    expect(stderr.filter((line) => line.includes('[debug-log]'))).toHaveLength(1);
  });
});
