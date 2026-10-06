// The coding-agent CLIs the app can drive. Each runs on the user's own login to
// that service and reaches selecta only through the MCP server, so the tool
// allowlist below is the whole of what any of them can touch.
import { PROVIDER_LABELS, type AgentEvent, type ProviderId } from '../shared/protocol.js';
import { parseCodexLine } from './codex_stream.js';
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

/** The selecta MCP server a run talks to. */
export type McpServer = { command: string; args: string[]; env: Record<string, string> };

export type Turn = {
  prompt: string;
  instructions: string;
  mcp: McpServer;
  /** The session to continue, from this provider's previous `done`. */
  resume?: string;
  newSessionId: string;
};

export type AgentProvider = {
  id: ProviderId;
  label: string;
  bin: string;
  /** Overrides `bin` when set, like SELECTA_CLAUDE_PATH. */
  binEnv: string;
  missing: string;
  args: (turn: Turn) => string[];
  /** A run's line parser; it may keep state across one run's lines. */
  parser: () => (line: string) => AgentEvent[];
  /** Exits 0 when the CLI is signed in. */
  loginCheck?: string[];
};

export const claude: AgentProvider = {
  id: 'claude',
  label: PROVIDER_LABELS.claude,
  bin: 'claude',
  binEnv: 'SELECTA_CLAUDE_PATH',
  missing: 'Could not find the claude CLI. Install Claude Code, or set SELECTA_CLAUDE_PATH.',
  args: (turn) => [
    '-p',
    turn.prompt,
    '--output-format',
    'stream-json',
    '--verbose',
    // No built-in tools: no shell, no file access, only selecta.
    '--tools',
    '',
    '--strict-mcp-config',
    '--mcp-config',
    JSON.stringify({ mcpServers: { selecta: turn.mcp } }),
    '--permission-mode',
    'dontAsk',
    '--allowedTools',
    ...ALLOWED_TOOLS.map((name) => `mcp__selecta__${name}`),
    '--disallowedTools',
    ...DENIED_TOOLS.map((name) => `mcp__selecta__${name}`),
    '--append-system-prompt',
    turn.instructions,
    ...(turn.resume ? ['--resume', turn.resume] : ['--session-id', turn.newSessionId]),
  ],
  parser: () => parseStreamLine,
};

// Codex has no "no built-in tools" switch, so each tool feature is turned off
// by name. `-c features.x=false` is ignored by a Codex that lacks x, where
// `--disable x` would refuse to start.
const CODEX_TOOL_FEATURES = [
  'shell_tool',
  'unified_exec',
  'view_image',
  'multi_agent',
  'goals',
  'apps',
  'plugins',
  'browser_use',
  'computer_use',
  'in_app_browser',
  'image_generation',
  'tool_suggest',
  'skill_search',
  'sleep_tool',
  'realtime_conversation',
];

const toml = (value: unknown) => JSON.stringify(value);

function codexServer({ command, args, env }: McpServer): string {
  const vars = Object.entries(env).map(([key, value]) => `${key}=${toml(value)}`);

  return [
    `command=${toml(command)}`,
    `args=${toml(args)}`,
    `env={${vars.join(',')}}`,
    `enabled_tools=${toml(ALLOWED_TOOLS)}`,
    `disabled_tools=${toml(DENIED_TOOLS)}`,
    // exec never prompts, so an MCP call needing approval just fails.
    `default_tools_approval_mode="approve"`,
  ].join(',');
}

export const codex: AgentProvider = {
  id: 'codex',
  label: PROVIDER_LABELS.codex,
  bin: 'codex',
  binEnv: 'SELECTA_CODEX_PATH',
  missing: 'Could not find the codex CLI. Install Codex, or set SELECTA_CODEX_PATH.',
  args: (turn) => [
    'exec',
    '--json',
    '--skip-git-repo-check',
    // The user's own MCP servers, rules and profiles stay out; the login still applies.
    '--ignore-user-config',
    '--ignore-rules',
    '--sandbox',
    'read-only',
    ...CODEX_TOOL_FEATURES.flatMap((name) => ['-c', `features.${name}=false`]),
    '-c',
    'web_search="disabled"',
    '-c',
    `mcp_servers.selecta={${codexServer(turn.mcp)}}`,
    '-c',
    `developer_instructions=${toml(turn.instructions)}`,
    ...(turn.resume ? ['resume', turn.resume] : []),
    turn.prompt,
  ],
  parser: parseCodexLine,
  loginCheck: ['login', 'status'],
};

export const PROVIDERS: Record<ProviderId, AgentProvider> = { claude, codex };
