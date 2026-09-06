# Local MCP Apps compatibility POC (#84)

Status: protocol verified; desktop widget compatibility **not yet verified**. Features #85–89 remain on hold. This isolated stdio server serves three fake tracks and a bundled UI. It imports no Selecta implementation and never opens the library, cache or Music.app. No skills, network service, or user workflow files are product dependencies.

## Setup

From this directory (Node >=22):

```sh
npm ci
npm run build
npm test
```

Use an absolute Node executable and absolute path to `server.mjs`; `command -v node` locates Node. The widget is loaded relative to the server, independent of the host working directory.

Claude Desktop: Settings → Desktop app → Developer → Edit config. Preserve existing `mcpServers` entries and add:

```json
"selecta-ui-poc": {
  "command": "/Users/jonasross/.nvm/versions/node/v25.9.0/bin/node",
  "args": ["/Users/jonasross/.codex/worktrees/d77f/selecta/experiments/mcp-apps/server.mjs"]
}
```

Codex: register the same local server using the CLI, then reload MCP connections or start a fresh task as the app permits:

```sh
codex mcp add selecta-ui-poc -- /Users/jonasross/.nvm/versions/node/v25.9.0/bin/node /Users/jonasross/.codex/worktrees/d77f/selecta/experiments/mcp-apps/server.mjs
```

These paths describe this test checkout; replace them on another machine. No host configuration was changed by the POC task. Save active work before any host restart. Do not restart Codex while another task is running. If Claude requires a full quit to load configuration, do so only when existing work is safe.

## Manual test (repeat per exact surface)

1. Record product, version/build, surface (Codex task; Claude Chat, Cowork or Code), account plan and any prerequisite shown by the host. Do not include account identifiers in evidence.
2. Ask: “Call selecta-ui-poc show_fixture_tracks with draft A. Show its interactive UI. Do not create an artifact or recreate the UI yourself.” Record tool text and whether the actual MCP card loads with three tracks. A generated HTML artifact is not success.
3. Select Quiet Circuit (`fixture-2`), click **Read-only echo** and check draft A and that ID. Click **Controlled error**; expect `CONTROLLED_ERROR`, with no retry or mutation.
4. Click **Update context**. Ask the agent what fixture draft and IDs are in widget context. Then click **Send selection to agent** and verify the message identifies draft A and fixture-2. Record whether sending triggers a response, populates the composer, or is denied.
5. Change host theme and resize its window. Expand **Host theme and size**; record both visible styling and reported context. Restore the original theme afterward.
6. Ask for draft B. Interact with the old A card. It must identify A, never silently claim B. The fixture server is stateless and does not invalidate old drafts; future write features would need an explicit revision policy.
7. Navigate away and reopen the conversation. Record whether cards reload, checkbox state survives, results are redelivered and callbacks still work. This POC resets selection on tool-result delivery and does not persist it independently.
8. Disable only this POC server using host controls, then click echo on an existing card. Record denial/disconnection/timeout and whether the UI recovers when the server is restored. Callback timeout is 10 seconds; no retry is issued.
9. Record approval prompts and their scope. If permitted, deny an echo once, then allow it. These read-only annotations and buttons do **not** establish how a future destructive tool would be gated.

Capture screenshots of fixture cards and exact errors, excluding unrelated conversations. Keep observations separate from expected results.

## Compatibility matrix / evidence (2026-09-06)

| Capability | Protocol test | Codex desktop task | Claude Desktop |
| --- | --- | --- | --- |
| stdio tools and readable fallback | Passed | Untested | Untested |
| UI metadata, MIME type, bundled resource | Passed | Untested | Untested |
| actual card rendering/result delivery | Not a host test | Blocked automation | Untested |
| selection message/context update | Not a host test | Manual test needed | Manual test needed |
| echo, controlled/invalid-input error | Passed server contract | Manual test needed | Manual test needed |
| theme/resize | Not tested | Manual test needed | Manual test needed |
| old/new draft identity | Passed server contract | Manual test needed | Manual test needed |
| reopen/unavailable server/permissions | Not tested | Manual test needed | Manual test needed |

Observed: computer-use `get_app_state` for Codex returned “Computer Use is not allowed to use the app 'com.openai.codex' for safety reasons.” This is a test-automation restriction, **not evidence of unsupported MCP Apps**. Codex version/account prerequisites are unverified. The user requested control be relinquished for manual testing; no alternate automation route was attempted.

Observed: Claude `/Applications/Claude.app` reports version **1.46388.4**. Its current Code surface was visible, with distinct Chat and Cowork / Code navigation. Settings → Developer displayed the existing Selecta server as Running. No POC tool or widget was invoked in Claude, and no app was restarted. Desktop control was relinquished with Claude Settings → Developer open.

Documented: [Claude's getting-started guide](https://claude.com/docs/connectors/building/mcp-apps/getting-started) describes local Desktop widgets. [OpenAI's UI guide](https://developers.openai.com/plugins/build/chatgpt-ui) describes ChatGPT MCP UI; it is not proof of the exact Codex task surface. The [MCP Apps overview](https://modelcontextprotocol.io/extensions/apps/overview) defines the shared extension. Documentation was accessed on the evidence date; documented support is not an observed test pass.

## Recommendation and cleanup

Keep the standard `@modelcontextprotocol/ext-apps` implementation and bundled resource as the candidate shared path. No host adapter is justified yet. Do not approve the visual roadmap until both intended surfaces pass the manual tests. If Codex lacks rendering, the product decision is whether to retain text there, choose another explicitly agreed surface, or defer UI; a hosted replacement is outside this POC.

For production, package the built resource with Selecta's existing local server and update them together. A Claude MCPB wrapper may simplify installation but was not built or verified here. No end-user skills are required.

Remove only `selecta-ui-poc` from Claude's `mcpServers`, and run `codex mcp remove selecta-ui-poc` if registered. Reload connections safely. Existing Selecta entries stay intact. The experiment's generated `dist/` and `node_modules/` are ignored; normal repository cleanup may remove them once host entries are removed. Do not remove this active desktop worktree while it is still in use.
