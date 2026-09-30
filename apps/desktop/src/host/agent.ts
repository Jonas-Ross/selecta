// One `claude -p` run per turn, resumed per draft, so the build runs on the
// user's Claude subscription. The MCP server it talks to is the real one.
import { spawn as nodeSpawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';
import type { AgentEvent } from '../shared/protocol.js';
import { parseStreamLine } from './stream.js';

const READ_TOOLS = [
  'search',
  'library_overview',
  'get_track_context',
  'list_playlists',
  'inspect_tracklist',
];
const DRAFT_TOOLS = ['show_playlist_draft', 'get_playlist_draft', 'edit_playlist_draft'];

// Denied as well as left off the allowlist: a deny rule beats any allow rule in
// the user's own Claude settings.
export const DENIED_TOOLS = [
  'save_playlist_draft',
  'preview_playlist_draft',
  'create_playlist',
  'preview_playlist',
  'open_preview',
  'add_tracks',
  'remove_tracks',
  'reorder_tracks',
  'delete_playlist',
  'set_loved',
  'set_rating',
  'set_note',
  'refresh_library',
  'enrich_features',
  'show_library_explorer',
  'playlist_draft_appearance',
];
export const ALLOWED_TOOLS = [...READ_TOOLS, ...DRAFT_TOOLS];

const SYSTEM_PROMPT = `You build playlist drafts in the Selecta desktop app, where the user watches the draft update live. Find tracks with the selecta tools and use only track IDs they return. Create the draft once with show_playlist_draft using the draft ID you are given; after that, read it with get_playlist_draft and revise it with edit_playlist_draft, preserving entry_ids. You cannot save or write to Music.app: the user saves from the app. Keep replies to a few sentences.`;

type Spawn = typeof nodeSpawn;

export type AgentOptions = {
  mcpEntry: string;
  emit: (draftId: string, event: AgentEvent) => void;
  claudePath?: string;
  cwd?: string;
  spawn?: Spawn;
};

export class AgentSessions {
  private sessions = new Map<string, string>();
  private running = new Map<string, () => void>();

  constructor(private options: AgentOptions) {}

  start(draftId: string, brief: string): void {
    this.run(draftId, `Draft ID: ${draftId}\n\nBrief:\n${brief}`);
  }

  // The user may have reordered since Claude last looked, so every feedback
  // turn re-reads the draft. A draft with no session (the app restarted) just
  // starts a new one.
  send(draftId: string, message: string): void {
    this.run(
      draftId,
      `Draft ID: ${draftId}\n\nRead the current draft with get_playlist_draft before changing it; the user may have edited it.\n\nFeedback:\n${message}`,
    );
  }

  cancel(draftId: string): void {
    this.running.get(draftId)?.();
  }

  cancelAll(): void {
    for (const stop of this.running.values()) stop();
  }

  private run(draftId: string, prompt: string): void {
    const { emit } = this.options;

    if (this.running.has(draftId)) {
      emit(draftId, { kind: 'error', message: 'Claude is already working on this draft.' });

      return;
    }

    const resume = this.sessions.get(draftId);
    const args = [
      '-p',
      prompt,
      '--output-format',
      'stream-json',
      '--verbose',
      // No built-in tools: no shell, no file access, only selecta.
      '--tools',
      '',
      '--strict-mcp-config',
      '--mcp-config',
      JSON.stringify({
        mcpServers: { selecta: { command: process.execPath, args: [this.options.mcpEntry] } },
      }),
      '--permission-mode',
      'dontAsk',
      '--allowedTools',
      ...ALLOWED_TOOLS.map((name) => `mcp__selecta__${name}`),
      '--disallowedTools',
      ...DENIED_TOOLS.map((name) => `mcp__selecta__${name}`),
      '--append-system-prompt',
      SYSTEM_PROMPT,
      ...(resume ? ['--resume', resume] : ['--session-id', randomUUID()]),
    ];
    const child = (this.options.spawn ?? nodeSpawn)(this.options.claudePath ?? 'claude', args, {
      cwd: this.options.cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let finished = false;
    let stopped = false;
    let stderr = '';

    const finish = (event: AgentEvent) => {
      if (finished) return;

      finished = true;
      this.running.delete(draftId);
      emit(draftId, event);
    };

    this.running.set(draftId, () => {
      stopped = true;
      child.kill('SIGTERM');
    });

    child.stderr?.on('data', (chunk: Buffer) => {
      stderr = (stderr + chunk.toString()).slice(-2000);
    });

    createInterface({ input: child.stdout! }).on('line', (line) => {
      for (const event of parseStreamLine(line)) {
        if (event.kind === 'done') {
          if (event.session_id) this.sessions.set(draftId, event.session_id);

          finish(event);
        } else if (event.kind === 'error') finish(event);
        else emit(draftId, event);
      }
    });

    child.on('error', (error: NodeJS.ErrnoException) =>
      finish({
        kind: 'error',
        message:
          error.code === 'ENOENT'
            ? 'Could not find the claude CLI. Install Claude Code, or set SELECTA_CLAUDE_PATH.'
            : error.message,
      }),
    );

    child.on('close', (code) =>
      finish({
        kind: 'error',
        message: stopped
          ? 'Stopped.'
          : stderr.trim() || `claude exited with code ${code} before finishing.`,
      }),
    );
  }
}
