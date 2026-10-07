// Runs the bridge's real JXA scripts against a model of Music; docs/desktop-harness.md.
import { writeFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

export type SimTrack = {
  persistentId: string;
  name: string;
  artist: string;
  album?: string;
  genre?: string;
  year?: number;
  duration: number;
  dateAdded?: string;
  playedCount?: number;
  artwork?: Uint8Array;
};

type Entry = { track: SimTrack };
type Kind = 'library' | 'user' | 'smart';
type Playlist = { persistentId: string; name: string; kind: Kind; entries: Entry[] };
type PlayerState = 'stopped' | 'playing' | 'paused';

// AutoMix as measured on Jonas's Mac: the next record takes over about 4.5 s
// before the end, already about 7 s in.
export const AUTOMIX = { lead: 4.5, into: 7 };

// Past this, previousTrack restarts the record instead of stepping back.
const RESTART_AFTER = 3;

const cantGet = () => new Error("Can't get object. (-1728)");
const notRunning = () => new Error("Application isn't running. (-600)");

export class MusicSim {
  running = true;
  shuffle = false;
  settingsOpen = false;
  latency = 0.15;
  doubleAdds = false;
  automix?: { lead: number; into: number };
  readonly calls: string[] = [];

  private speed = 1;
  private base = 0;
  private realBase = performance.now();
  private pending: { at: number; apply: (at: number) => void }[] = [];
  private ids = 0;
  private readonly library: Playlist;
  private readonly playlists: Playlist[];
  private player: {
    state: PlayerState;
    playlist?: Playlist;
    entry?: Entry;
    pos: number;
    at: number;
  } = { state: 'stopped', pos: 0, at: 0 };

  constructor(tracks: SimTrack[]) {
    this.library = this.playlist('Library', 'library', tracks);
    this.playlists = [this.library];
  }

  now(): number {
    return this.base + ((performance.now() - this.realBase) / 1000) * this.speed;
  }

  setSpeed(speed: number): void {
    this.base = this.now();
    this.realBase = performance.now();
    this.speed = speed;
  }

  advance(seconds: number): void {
    this.base += seconds;
    this.settle();
  }

  addPlaylist(name: string, trackIds: string[], kind: Kind = 'user'): string {
    const pl = this.playlist(
      name,
      kind,
      trackIds.map((id) => this.track(id)),
    );

    this.playlists.push(pl);

    return pl.persistentId;
  }

  rekey(name: string): string {
    const pl = this.named(name);

    pl.persistentId = this.newId();

    return pl.persistentId;
  }

  pick(index: number): void {
    this.settle();
    const pl = this.player.playlist;

    if (!pl?.entries[index - 1]) throw new Error(`No entry ${index} to pick.`);

    Object.assign(this.player, {
      state: 'playing',
      entry: pl.entries[index - 1],
      pos: 0,
      at: this.now(),
    });
  }

  snapshot() {
    this.settle();
    const { state, playlist, entry } = this.player;

    return {
      playlists: this.playlists
        .filter((pl) => pl.kind !== 'library')
        .map((pl) => ({
          id: pl.persistentId,
          name: pl.name,
          tracks: pl.entries.map((e) => e.track.persistentId),
        })),
      player: {
        state,
        playlist: playlist?.name,
        index: entry && playlist ? playlist.entries.indexOf(entry) + 1 : undefined,
        track: entry?.track.persistentId,
        position: Math.round(this.position(this.now()) * 10) / 10,
      },
    };
  }

  run(script: string): string {
    try {
      const out: unknown = runInNewContext(script, this.globals(), { timeout: 10_000 });

      return out === undefined ? '' : String(out);
    } catch (error) {
      throw new Error(`execution error: ${error instanceof Error ? error.message : error}`, {
        cause: error,
      });
    }
  }

  private position(at: number): number {
    const { state, pos, at: since } = this.player;

    return state === 'playing' ? pos + (at - since) : pos;
  }

  private freeze(at: number): void {
    this.player.pos = this.position(at);
    this.player.at = at;
  }

  private handover(): number {
    const { state, entry } = this.player;

    if (state !== 'playing' || !entry) return Infinity;

    const end = entry.track.duration - (this.automix && this.next() ? this.automix.lead : 0);

    return this.player.at + Math.max(0, end - this.player.pos);
  }

  private next(): Entry | undefined {
    const { playlist, entry } = this.player;

    if (!playlist || !entry) return undefined;

    const index = playlist.entries.indexOf(entry);

    return index === -1 ? undefined : playlist.entries[index + 1];
  }

  private settle(): void {
    for (;;) {
      const now = this.now();
      const end = this.handover();
      const command = this.pending[0]?.at ?? Infinity;

      if (Math.min(end, command) > now) return;

      if (end <= command) {
        const next = this.next();

        this.freeze(end);

        // Music stops after the last record, or after one that left the playlist.
        if (next) Object.assign(this.player, { entry: next, pos: this.automix?.into ?? 0 });
        else this.player = { state: 'stopped', pos: 0, at: end };
      } else {
        const { at, apply } = this.pending.shift()!;

        this.freeze(at);
        apply(at);
      }
    }
  }

  private command(label: string, apply: (at: number) => void): void {
    this.calls.push(label);
    this.pending.push({ at: this.now() + this.latency, apply });
  }

  private newId(): string {
    return (0xa000000000000000n + BigInt(++this.ids)).toString(16).toUpperCase();
  }

  private playlist(name: string, kind: Kind, tracks: SimTrack[]): Playlist {
    return { persistentId: this.newId(), name, kind, entries: tracks.map((track) => ({ track })) };
  }

  private track(id: string): SimTrack {
    const entry = this.library.entries.find((e) => e.track.persistentId === id);

    if (!entry) throw new Error(`No library track ${id}.`);

    return entry.track;
  }

  private named(name: string): Playlist {
    const found = this.playlists.filter((pl) => pl.name === name);

    if (found.length !== 1) throw new Error(`Expected one playlist named ${name}.`);

    return found[0]!;
  }

  private globals() {
    const music = this.application();

    return {
      Application: (name: string) => {
        if (name !== 'Music') throw new Error(`The simulator only plays Music, not ${name}.`);

        return music;
      },
      delay: (seconds: number) => {
        this.base += seconds;
      },
      ...this.objc(),
    };
  }

  private application() {
    const live = () => {
      if (!this.running) throw notRunning();

      this.settle();
    };
    const playlistsOf = (filter: (pl: Playlist) => boolean) =>
      this.collection(
        () => this.playlists.filter(filter),
        (pl) => this.playlistSpec(pl),
      );
    const playingPlaylist = () => {
      live();

      if (this.player.state === 'stopped' || !this.player.playlist) throw cantGet();

      return this.player.playlist;
    };
    const methods = {
      running: () => this.running,
      playerState: () => (live(), this.player.state),
      shuffleEnabled: () => (live(), this.shuffle),
      play: (target?: unknown) => {
        live();
        const pl = target === undefined ? undefined : this.unwrapPlaylist(target);

        this.command(pl ? `play ${pl.name}` : 'play', () => {
          if (this.settingsOpen) return;

          if (pl) {
            const pick = this.shuffle ? Math.floor(Math.random() * pl.entries.length) : 0;

            if (pl.entries[pick])
              Object.assign(this.player, {
                state: 'playing',
                playlist: pl,
                entry: pl.entries[pick],
                pos: 0,
              });
          } else if (this.player.state === 'paused') this.player.state = 'playing';
        });
      },
      pause: () => {
        live();
        this.command('pause', () => {
          if (this.player.state === 'playing') this.player.state = 'paused';
        });
      },
      nextTrack: () => {
        live();
        this.command('next', () => {
          const next = this.next();

          if (next) Object.assign(this.player, { entry: next, pos: 0 });
          else if (this.player.entry)
            this.player = { state: 'stopped', pos: 0, at: this.player.at };
        });
      },
      previousTrack: () => {
        live();
        this.command('previous', () => {
          const { playlist, entry, pos } = this.player;
          const index = playlist && entry ? playlist.entries.indexOf(entry) : -1;

          if (pos < RESTART_AFTER && index > 0) this.player.entry = playlist!.entries[index - 1];

          this.player.pos = 0;
        });
      },
      make: ({ new: kind, withProperties }: { new: string; withProperties: { name: string } }) => {
        live();

        if (kind !== 'playlist') throw new Error(`Cannot make a ${kind}.`);

        const pl = this.playlist(withProperties.name, 'user', []);

        this.playlists.push(pl);
        this.calls.push(`make ${pl.name}`);

        return this.playlistSpec(pl);
      },
      delete: (spec: unknown) => {
        live();
        const { entry, playlist } = this.unwrapTrack(spec);

        playlist.entries.splice(playlist.entries.indexOf(entry), 1);
      },
      move: (spec: unknown, { to }: { to: unknown }) => {
        live();
        const { entry, playlist } = this.unwrapTrack(spec);
        const target = this.unwrapPlaylist(to);

        playlist.entries.splice(playlist.entries.indexOf(entry), 1);
        target.entries.push(entry);
      },
      reveal: (target: unknown) => {
        live();
        this.calls.push(`reveal ${this.unwrapPlaylist(target).name}`);
      },
      activate: () => this.calls.push('activate'),
    };

    return Object.defineProperties(methods, {
      playerPosition: {
        get: () => () => (live(), this.position(this.now())),
        set: (seconds: number) => {
          live();
          this.command(`seek ${seconds}`, () => {
            const entry = this.player.entry;

            // Music ignores a position past the end.
            if (entry && seconds <= entry.track.duration) this.player.pos = seconds;
          });
        },
      },
      currentTrack: {
        get: () =>
          this.trackSpec(() => {
            live();

            if (this.player.state === 'stopped' || !this.player.entry) throw cantGet();

            return { entry: this.player.entry, playlist: this.player.playlist };
          }),
      },
      currentPlaylist: {
        get: () =>
          Object.defineProperty(
            {
              persistentID: () => playingPlaylist().persistentId,
              name: () => playingPlaylist().name,
            },
            'tracks',
            { get: () => this.tracksOf(playingPlaylist()) },
          ),
      },
      playlists: { get: () => playlistsOf(() => true) },
      userPlaylists: { get: () => playlistsOf((pl) => pl.kind !== 'library') },
      libraryPlaylists: { get: () => [this.playlistSpec(this.library)] },
    });
  }

  private readonly specs = new WeakMap<object, () => { entry: Entry; playlist: Playlist }>();
  private readonly playlistSpecs = new WeakMap<object, Playlist>();

  private unwrapTrack(spec: unknown) {
    const resolve = this.specs.get(spec as object);

    if (!resolve) throw new Error('Not a track.');

    return resolve();
  }

  private unwrapPlaylist(spec: unknown): Playlist {
    const pl = this.playlistSpecs.get(spec as object);

    if (!pl) throw new Error('Not a playlist.');

    return pl;
  }

  // Bulk getters fail on an empty collection, as Music's do.
  private collection<T>(items: () => T[], spec: (item: T, index: number) => object): any {
    return new Proxy(
      {},
      {
        get: (_target, prop) => {
          if (prop === 'length') return items().length;

          if (typeof prop === 'symbol') return undefined;

          if (/^\d+$/.test(prop)) return spec(items()[Number(prop)]!, Number(prop));

          if (prop === 'whose')
            return (where: Record<string, unknown>) => () =>
              items()
                .map((item, i) => [item, spec(item, i)] as const)
                .filter(([, s]) =>
                  Object.entries(where).every(([key, value]) => (s as any)[key]() === value),
                )
                .map(([, s]) => s);

          return () => {
            const all = items();

            if (all.length === 0) throw cantGet();

            return all.map((item, i) => (spec(item, i) as any)[prop]());
          };
        },
      },
    );
  }

  private tracksOf(pl: Playlist) {
    return this.collection(
      () => pl.entries,
      (_entry, index) =>
        // By index, resolved when used, as a JXA element specifier is.
        this.trackSpec(() => {
          const entry = pl.entries[index];

          if (!entry) throw cantGet();

          return { entry, playlist: pl };
        }),
    );
  }

  private playlistSpec(pl: Playlist) {
    const spec = Object.defineProperties(
      {
        name: () => pl.name,
        persistentID: () => pl.persistentId,
        class: () => (pl.kind === 'library' ? 'libraryPlaylist' : 'userPlaylist'),
        smart: () => pl.kind === 'smart',
        specialKind: () => (pl.kind === 'library' ? 'Music' : 'none'),
        parent: () => {
          throw cantGet();
        },
      },
      {
        tracks: { get: () => this.tracksOf(pl) },
        description: { set: () => {} },
      },
    );

    this.playlistSpecs.set(spec, pl);

    return spec;
  }

  private trackSpec(resolve: () => { entry: Entry; playlist?: Playlist }) {
    const track = () => resolve().entry.track;
    const spec = {
      persistentID: () => track().persistentId,
      name: () => track().name,
      artist: () => track().artist,
      albumArtist: () => '',
      album: () => track().album ?? '',
      genre: () => track().genre ?? '',
      year: () => track().year ?? 0,
      duration: () => track().duration,
      bpm: () => 0,
      trackNumber: () => 0,
      discNumber: () => 0,
      dateAdded: () => (track().dateAdded ? new Date(track().dateAdded!) : null),
      playedDate: () => null,
      playedCount: () => track().playedCount ?? 0,
      skippedCount: () => 0,
      rating: () => 0,
      ratingKind: () => 'computed',
      favorited: () => false,
      disliked: () => false,
      comment: () => '',
      class: () => 'sharedTrack',
      index: () => {
        const { entry, playlist } = resolve();
        const index = playlist ? playlist.entries.indexOf(entry) : -1;

        if (index === -1) throw cantGet();

        return index + 1;
      },
      duplicate: ({ to }: { to: unknown }) => {
        const pl = this.unwrapPlaylist(to);
        const { entry } = resolve();

        pl.entries.push({ track: entry.track });

        if (this.doubleAdds) pl.entries.push({ track: entry.track });
      },
    };

    this.specs.set(spec, () => {
      const { entry, playlist } = resolve();

      if (!playlist) throw cantGet();

      return { entry, playlist };
    });

    return spec;
  }

  private objc() {
    const $ = Object.assign(() => ({ value: undefined as unknown }), {
      NSMakeRange: (location: number, length: number) => ({ location, length }),
      NSAppleScript: {
        alloc: {
          initWithSource: (source: string) => ({
            executeAndReturnError: (error: { value: unknown }) => {
              const id = /persistent ID is "([0-9A-F]+)"/.exec(source)?.[1];
              const art = this.library.entries.find((e) => e.track.persistentId === id)?.track
                .artwork;

              if (!art) {
                error.value = { NSAppleScriptErrorNumber: -1728 };

                return { isNil: (): boolean => true };
              }

              return { isNil: (): boolean => false, data: this.bytes(art) };
            },
          }),
        },
      },
    });

    return { $, ObjC: { import: () => {}, deepUnwrap: (ref: { value: unknown }) => ref.value } };
  }

  private bytes(data: Uint8Array) {
    return {
      length: data.length,
      subdataWithRange: ({ location, length }: { location: number; length: number }) => ({
        base64EncodedStringWithOptions: () => ({
          js: Buffer.from(data.subarray(location, location + length)).toString('base64'),
        }),
      }),
      writeToFileAtomically: (path: string) => {
        writeFileSync(path, data);

        return true;
      },
    };
  }
}
