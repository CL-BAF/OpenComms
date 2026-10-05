# Manual MCP host profiles

Reviewed against current official documentation on 2026-10-05. These are reusable configuration exports for an existing, user-owned host. They do not install a host, authenticate a model, discover conversations or create managed sessions. The shared OpenComms server implements initialize, tools/list and tools/call over stdio.

## Export and connect

```text
opencomms mcp-profile cursor --project <project-directory> --id <member-id> --server <standalone-MCP-bundle>
```

Supported profile names are `goose`, `cursor`, `cline`, `roo`, `continue`, `vscode-copilot` and `windsurf-cascade`. Output is a JSON fragment, except Goose which uses YAML. The command prints only configuration and changes no files. Review the output and merge its `opencomms` entry into the host configuration, preserving other entries. Do not replace an existing configuration file with redirected output.

`--server` selects the real standalone server. An npm installation ships it at `node_modules/opencomms/dist/mcp/main.js`; a source checkout builds it with `npm run build`. Installed linked integrations also place a standalone bundle at `<project>/.opencomms/opencomms-mcp.mjs`, which is the default when `--server` is omitted. A SEA executable embeds that bundle for its installers, but the executable itself is not a Node script. The profile refuses a missing server file. Hosts need Node on PATH, or `--node <absolute-node-executable>`.

Give each participating conversation a distinct member id. This id pins an **OpenComms member**; it is not evidence of the host's conversation id. Avoid sharing the same pin between active conversations. Prefer a project configuration because the exported arguments bind one explicit project/worktree. A global configuration still binds that project and does not follow the currently opened folder.

After starting the host and approving its MCP connection, use `opencomms_join` with the existing channel, role and role prompt, or `opencomms_create` to create an OpenComms channel. Then use `opencomms_send`, `opencomms_inbox` and `opencomms_pull`. A channel is a communication record, and creating it does not create a vendor conversation. Incoming peer content remains framed as untrusted data. Tool approval remains under the host's normal policy; exports do not add automatic approval, admin mode or spawn delivery.

## Current host setup paths

| Profile | Official configuration contract | OpenComms evaluation |
| --- | --- | --- |
| Goose | `extensions.opencomms`, with `type: stdio`, `cmd`, argv `args` and `envs`; YAML at `~/.config/goose/config.yaml` on macOS/Linux or `%APPDATA%\Block\goose\config\config.yaml` on Windows. [Official config reference](https://github.com/aaif-goose/goose/blob/main/documentation/docs/guides/config-files.md) | Export supplies a stdio extension fragment and leaves provider/model/permission settings to the user. No native Goose session discovery or lifecycle adapter ships here. |
| Cursor | Project `.cursor/mcp.json` or global `~/.cursor/mcp.json`, under `mcpServers`, with `type: stdio`, `command`, `args`, `env`. [Official MCP documentation](https://cursor.com/docs/mcp) | Export binds the `cursor` host label and a member pin. MCP tool availability does not establish conversation identity, idle observation or managed creation. |
| Cline | CLI `~/.cline/mcp.json`; IDE: MCP Servers → Configure → Configure MCP Servers. Local servers use `command`, `args`, `env` under `mcpServers`. [Official MCP documentation](https://docs.cline.bot/mcp/mcp-overview) | Export leaves `autoApprove` empty. No IDE storage path is guessed, and no Cline conversation lifecycle is controlled. |
| Roo Code | Project `.roo/mcp.json`, or Edit Global MCP in the MCP settings view, using `mcpServers`. [Official Roo configuration guide](https://roocodeinc.github.io/Roo-Code/features/mcp/using-mcp-in-roo/) | Export leaves `alwaysAllow` empty. It provides manual pull tools without a Roo session adapter. |
| Continue | Portable JSON is accepted directly in `.continue/mcpServers/opencomms.json`. MCP is available in agent mode. [Official Continue MCP guide](https://docs.continue.dev/customize/deep-dives/mcp) | Export uses the documented JSON format, avoiding incomplete standalone YAML metadata. Native session identity and lifecycle remain unknown. |
| VS Code / Copilot | Preferred portable workspace `.mcp.json`, or user `$COPILOT_HOME/mcp-config.json` / `~/.copilot/mcp-config.json`, with `mcpServers`. Older `.vscode/mcp.json` uses `servers` and remains a compatibility destination. [Official VS Code MCP guide](https://code.visualstudio.com/docs/agent-customization/mcp-servers) | Export targets portable `.mcp.json`. Do not paste it unchanged into the older `servers` format. Workspace trust, host policy and model/tool execution remain user-controlled. |
| Windsurf / legacy Cascade | Current official documentation redirects to Devin Desktop. Legacy Cascade uses Actions → Open MCP config file, at `~/.config/devin/mcp_config.json` (or `$XDG_CONFIG_HOME/devin/mcp_config.json`) on macOS/Linux and `%APPDATA%\devin\mcp_config.json` on Windows. [Official Cascade MCP guide](https://docs.devin.ai/desktop/cascade/mcp) | The `windsurf-cascade` export is specifically for legacy Cascade. The current default Devin Local agent uses a separate CLI configuration; this export does not claim to configure it. |

## Capability and verification limits

| Capability | Status for these profiles |
| --- | --- |
| MCP wire initialization, tool listing, pinned join and framed pull | SUPPORTED by the shared server; every exported argv/env profile is exercised by an actual standalone subprocess regression |
| Current vendor model execution and host acceptance of configuration | UNKNOWN until tested in that authenticated host |
| OpenComms member identity | SUPPORTED explicit pin, validated against the channel roster for protected calls |
| Native conversation identity / discovery / lifecycle / busy status | UNKNOWN; no adapter claims these from an MCP configuration |
| Server-initiated push, native resume, interrupt and managed creation | UNSUPPORTED by these profiles |
| Host model catalogue, model selection, usage and cost | UNSUPPORTED by these profiles |

The protocol regressions prove exported server wiring and OpenComms behavior outside the package directory. They are not vendor/model roundtrip evidence. Profile exports are intentionally separate from installed-host detection, which covers the shipped installers only. If a host documents a separate ACP executable, an operator can evaluate it through the configured ACP runtime and its opt-in live harness; an MCP profile does not imply ACP interoperability.
