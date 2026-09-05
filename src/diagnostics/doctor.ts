import { diagnostic } from '../bridge/schemas.js';
import { parsePayload } from '../types/validation.js';
import { runJxa } from '../bridge/jxa.js';
import { buildMusicAppDiagnosticScript } from '../bridge/scripts/diagnostics.js';
import { BridgeError, defaultHints } from '../types/errors.js';
import { readStatus, type StatusReport } from './status.js';

export type MusicAppStatus = {
  status: 'ok' | 'music_app_not_running' | 'automation_permission_denied' | 'jxa_error';
  running: boolean | null;
  automation_authorized: boolean | null;
  message?: string;
  hint?: string;
};

export type DoctorReport = StatusReport & { music_app: MusicAppStatus };

export async function checkMusicApp(): Promise<void> {
  const result = await runJxa(buildMusicAppDiagnosticScript());
  parsePayload(diagnostic, result, 'Music.app diagnostic', 'jxa_error');
}

function failureStatus(err: unknown): MusicAppStatus {
  const error = err instanceof BridgeError ? err : new BridgeError('jxa_error', String(err));
  const code = error.errorCode;
  if (
    code !== 'music_app_not_running' &&
    code !== 'automation_permission_denied' &&
    code !== 'jxa_error'
  ) {
    return {
      status: 'jxa_error',
      running: null,
      automation_authorized: null,
      message: error.message,
      hint: defaultHints.jxa_error,
    };
  }
  return {
    status: code,
    running:
      code === 'music_app_not_running'
        ? false
        : code === 'automation_permission_denied'
          ? true
          : null,
    automation_authorized: code === 'automation_permission_denied' ? false : null,
    message: error.message,
    hint: error.hint ?? defaultHints[code],
  };
}

export async function runDoctor(
  dbPath: string,
  musicCheck: () => Promise<void> = checkMusicApp,
  now = new Date(),
): Promise<DoctorReport> {
  const status = readStatus(dbPath, now);
  let musicApp: MusicAppStatus;
  try {
    await musicCheck();
    musicApp = { status: 'ok', running: true, automation_authorized: true };
  } catch (err) {
    musicApp = failureStatus(err);
  }
  return { ...status, ok: status.ok && musicApp.status === 'ok', music_app: musicApp };
}
