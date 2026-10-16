// One agent CLI run per turn, resumed per draft, so the build runs on the
// user's own subscription. The MCP server it talks to is the real one.
import { spawn as nodeSpawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';
import { LOCAL_DRAFTS_ENV } from '@selecta/core/drafts/store.js';
import type { AgentEvent, ProviderId, RunSnapshot } from '../shared/protocol.js';
import { PROVIDERS, type AgentProvider, type Turn } from './providers.js';
import { SUGGEST_INSTRUCTIONS, SUGGEST_TOOLS } from './suggest.js';

// Enough for several long requests, well under the argument size a spawn allows.
const HANDOFF_LIMIT = 16_000;

const SYSTEM_PROMPT = `You build playlist drafts in the Selecta desktop app, where the user watches the draft update live. Find tracks with the selecta tools and use only track IDs they return. The user's playlists show their taste, but they already have them: draw from across the library, and unless they ask to rework a playlist, keep no more than a third of the draft from any one of them (inspection.playlist_overlap shows this). Create the draft once with show_playlist_draft using the draft ID you are given; after that, read it with get_playlist_draft and revise it with edit_playlist_draft, preserving entry_ids. You cannot save or write to Music.app: the user saves from the app. Keep replies to a few sentences.`;

type Spawn = typeof nodeSpawn;

export type AgentOptions = {
  mcpEntry: string;
  emit: (draftId: string, event: AgentEvent, seq: number) => void;
  providers?: Record<ProviderId, AgentProvider>;
  /** Binary overrides by provider, from SELECTA_CLAUDE_PATH and friends. */
  paths?: Partial<Record<ProviderId, string>>;
  cwd?: string;
  spawn?: Spawn;
};

export class AgentSessions {
  // A session only resumes on the provider that started it; switching starts
  // fresh, and the draft itself carries what the new one needs.
  // `seen` counts the asks the session has been sent, so a resume hands over only newer ones.
  private sessions = new Map<string, { provider: ProviderId; id: string; seen: number }>();
  private chosen = new Map<string, ProviderId>();
  private running = new Map<string, () => void>();
  private suggesting = new Map<string, () => void>();
  // The host outlives any renderer, so it keeps the record a reload replays.
  private events = new Map<string, AgentEvent[]>();
  // What each agent was actually sent, selection included, for a handoff.
  private asks = new Map<string, string[]>();

  constructor(private options: AgentOptions) {}

  private get providers() {
    return this.options.providers ?? PROVIDERS;
  }

  provider(draftId: string): AgentProvider {
    return this.providers[this.chosen.get(draftId) ?? 'claude'];
  }

  start(draftId: string, brief: string, provider?: ProviderId): void {
    this.idle(draftId);

    if (provider) this.chosen.set(draftId, provider);

    this.record(draftId, {
      kind: 'asked',
      text: brief,
      brief: true,
      by: this.provider(draftId).id,
    });
    this.asked(draftId, brief);
    this.run(draftId, `Draft ID: ${draftId}\n\nBrief:\n${brief}`);
  }

  // The user may have reordered since the agent last looked, so every feedback
  // turn re-reads the draft. A draft with no session (the app restarted) just
  // starts a new one.
  send(draftId: string, message: string, text = message, provider?: ProviderId): void {
    this.idle(draftId);

    if (provider) this.chosen.set(draftId, provider);

    const by = this.provider(draftId).id;
    const earlier = this.handoff(draftId, by);

    this.record(draftId, { kind: 'asked', text, by });
    this.asked(draftId, message);
    this.run(
      draftId,
      `Draft ID: ${draftId}\n\nRead the current draft with get_playlist_draft before changing it; the user may have edited it.${earlier}\n\nFeedback:\n${message}`,
    );
  }

  // A swapped-in agent starts with no conversation, so it gets the user's own
  // earlier requests it never saw; the draft already holds what came of them.
  private handoff(draftId: string, by: ProviderId): string {
    const session = this.sessions.get(draftId);
    const unseen = (this.asks.get(draftId) ?? []).slice(
      session?.provider === by ? session.seen : 0,
    );
    const kept: string[] = [];
    let room = HANDOFF_LIMIT;

    // Newest first, so a long history loses its oldest requests rather than overflowing argv.
    for (const message of [...unseen].reverse()) {
      if (room <= 0) break;

      // The typed instruction ends a feedback message, after any selected tracks.
      const cut = message.length > room ? `…${message.slice(-room)}` : message;

      kept.unshift(`- ${cut.replaceAll('\n', '\n  ')}`);
      room -= message.length;
    }

    const dropped = unseen.length - kept.length;

    return kept.length
      ? `\n\nEarlier requests on this draft, oldest first:\n${dropped ? `- (${dropped} older left out)\n` : ''}${kept.join('\n')}`
      : '';
  }

  private asked(draftId: string, message: string): void {
    this.asks.set(draftId, [...(this.asks.get(draftId) ?? []), message]);
  }

  /** A request refused before Claude started, kept in the draft's log like any other outcome. */
  refuse(draftId: string, text: string, message: string, brief?: true): void {
    this.record(draftId, { kind: 'asked', text, ...(brief && { brief }) });
    this.record(draftId, { kind: 'error', message });
  }

  history(): Record<string, RunSnapshot> {
    return Object.fromEntries(
      [...this.events].map(([id, events]) => [id, { events, working: this.running.has(id) }]),
    );
  }

  private idle(draftId: string): void {
    if (this.running.has(draftId))
      throw new Error(`${this.provider(draftId).label} is already working on this draft.`);
  }

  private record(draftId: string, event: AgentEvent): void {
    const events = this.events.get(draftId) ?? [];

    this.events.set(draftId, [...events, event]);
    this.options.emit(draftId, event, events.length);
  }

  cancel(draftId: string): void {
    this.running.get(draftId)?.();
  }

  cancelAll(): void {
    for (const stop of [...this.running.values(), ...this.suggesting.values()]) stop();
  }

  /** The draft's latest brief, as the user wrote it, for runs that start without its session. */
  brief(draftId: string): string | undefined {
    const asked = this.events
      .get(draftId)
      ?.filter((event) => event.kind === 'asked' && event.brief)
      .at(-1);

    return asked?.kind === 'asked' ? asked.text : undefined;
  }

  // A suggestion is its own read-only run beside the draft's conversation, so it
  // never resumes or extends it. One per draft: a new ask replaces the last.
  suggest(draftId: string, prompt: string, provider?: ProviderId): Promise<string> {
    this.idle(draftId);
    this.suggesting.get(draftId)?.();

    const agent = provider ? this.providers[provider] : this.provider(draftId);

    return new Promise((resolve, reject) => {
      const text: string[] = [];
      const stop = this.spawnTurn(
        agent,
        { prompt, instructions: SUGGEST_INSTRUCTIONS, tools: SUGGEST_TOOLS },
        (event) => {
          if (event.kind === 'text') text.push(event.text);
          else if (event.kind === 'done' || event.kind === 'error') {
            if (this.suggesting.get(draftId) === stop) this.suggesting.delete(draftId);

            if (event.kind === 'done') resolve(text.join('\n'));
            else reject(new Error(event.message));
          }
        },
      );

      this.suggesting.set(draftId, stop);
    });
  }

  stopSuggest(draftId: string): void {
    this.suggesting.get(draftId)?.();
  }

  private run(draftId: string, prompt: string): void {
    const provider = this.provider(draftId);
    const session = this.sessions.get(draftId);
    const seen = this.asks.get(draftId)?.length ?? 0;

    const stop = this.spawnTurn(
      provider,
      {
        prompt,
        instructions: SYSTEM_PROMPT,
        resume: session?.provider === provider.id ? session.id : undefined,
      },
      (event) => {
        if (event.kind === 'done' || event.kind === 'error') {
          if (event.kind === 'done' && event.session_id)
            this.sessions.set(draftId, { provider: provider.id, id: event.session_id, seen });

          this.running.delete(draftId);
        }

        this.record(draftId, event);
      },
    );

    this.running.set(draftId, stop);
  }

  /** Runs one turn, reporting every event and then exactly one `done` or `error`; returns its stop. */
  private spawnTurn(
    provider: AgentProvider,
    turn: Pick<Turn, 'prompt' | 'instructions' | 'resume' | 'tools'>,
    on: (event: AgentEvent) => void,
  ): () => void {
    const args = provider.args({
      ...turn,
      mcp: {
        command: process.execPath,
        args: [this.options.mcpEntry],
        // A draft linked to a preview mid-run stays untouched, not synced to Music.
        env: { [LOCAL_DRAFTS_ENV]: '1' },
      },
      newSessionId: randomUUID(),
    });
    const parse = provider.parser();
    const child = (this.options.spawn ?? nodeSpawn)(
      this.options.paths?.[provider.id] ?? provider.bin,
      args,
      { cwd: this.options.cwd, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let finished = false;
    let stopped = false;
    let stderr = '';

    const finish = (event: AgentEvent) => {
      if (finished) return;

      finished = true;
      on(event);
    };

    child.stderr?.on('data', (chunk: Buffer) => {
      stderr = (stderr + chunk.toString()).slice(-2000);
    });

    createInterface({ input: child.stdout }).on('line', (line) => {
      for (const event of parse(line)) {
        if (event.kind === 'done' || event.kind === 'error') finish(event);
        else if (!finished) on(event);
      }
    });

    child.on('error', (error: NodeJS.ErrnoException) =>
      finish({
        kind: 'error',
        message: error.code === 'ENOENT' ? provider.missing : error.message,
      }),
    );

    child.on('close', (code) =>
      finish({
        kind: 'error',
        message: stopped
          ? 'Stopped.'
          : stderr.trim() || `${provider.bin} exited with code ${code} before finishing.`,
      }),
    );

    return () => {
      stopped = true;
      child.kill('SIGTERM');
    };
  }
}
