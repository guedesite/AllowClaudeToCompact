# Allow Claude To Compact

> An MCP server that lets an AI coding agent (Claude Code, Codex, …) **trigger its own `/compact`** — something agents normally cannot do for themselves.

**FR — En bref :** Ce serveur MCP donne à un agent (Claude Code, Codex, etc.) un outil pour **se compacter lui-même**. Aujourd'hui, le `/compact` ne se déclenche qu'automatiquement (quand le contexte est plein) ou manuellement par l'utilisateur. Avec cet outil, vous pouvez dire à l'agent : *« quand tu as fini cette tâche, compacte »*. L'outil prend le focus sur la fenêtre du terminal qui exécute l'agent, y tape `/compact` et appuie sur Entrée.

---

## The problem it solves

In Claude Code (and similar agents) the conversation context can only be compacted:

- **automatically**, when the context window fills up, or
- **manually**, when *you* type `/compact`.

The agent itself has no way to say *"I've finished this chunk of work, let me summarize and free up context now."* This server adds exactly that capability.

## How it works

The agent calls the MCP tool `compact_conversation`. The server then, on Windows:

1. **Finds the terminal window** that hosts the agent by walking up the process tree from the MCP server process (`node → claude → powershell → WindowsTerminal.exe`, etc.) until it reaches a known terminal/editor process that owns a real window.
2. **Brings that window to the foreground.**
3. **Types the command** (`/compact` by default) and presses **Enter**.
4. **Optionally resumes** — by default it then waits ~10 s and types `continue` + Enter, so the agent picks its work back up automatically once compaction finishes. Configurable / disable-able (see [Configuration](#configuration)).

All the OS-level work is done by an embedded PowerShell script using Win32 APIs (`SetForegroundWindow`, `AttachThreadInput`, `SendKeys`). No native Node modules are required.

```
┌────────────┐   tool call    ┌─────────────────────┐   walk process tree   ┌──────────────────┐
│   Agent    │ ─────────────► │  MCP server (node)  │ ────────────────────► │ WindowsTerminal  │
│ (Claude…)  │ compact_…      │  + PowerShell       │   focus + SendKeys    │  types /compact↵ │
└────────────┘                └─────────────────────┘                       └──────────────────┘
```

## Requirements

- **Windows** (uses the Win32 API; `win32` only for now — see [Limitations](#limitations)).
- **Node.js ≥ 18**.
- **Windows PowerShell** (`powershell.exe`, ships with Windows) — PowerShell 7 (`pwsh`) also works, see config.

## Installation

```powershell
git clone https://github.com/<your-user>/AllowClaudeToCompact.git
cd AllowClaudeToCompact
npm install      # also builds via the "prepare" script
npm run build    # (re-run anytime after editing src/)
```

This produces `dist/index.js`, the server entry point.

## Add it to your agent

### Claude Code

The quickest way — register it for your user (works in every project):

```powershell
claude mcp add allow-claude-to-compact --scope user -- node "C:\Users\<you>\Desktop\git\AllowClaudeToCompact\dist\index.js"
```

Or per-project (committed to the repo, shared with your team) — create / edit `.mcp.json` at the project root:

```jsonc
{
  "mcpServers": {
    "allow-claude-to-compact": {
      "command": "node",
      "args": ["C:\\Users\\<you>\\Desktop\\git\\AllowClaudeToCompact\\dist\\index.js"],
      "env": {
        "ACTC_COMMAND": "/compact",
        "ACTC_DELAY_MS": "600",
        "ACTC_FOLLOWUP": "continue",
        "ACTC_FOLLOWUP_DELAY_MS": "10000"
      }
    }
  }
}
```

Restart Claude Code, then check it is connected:

```
/mcp
```

You should see `allow-claude-to-compact` with the tools `compact_conversation` and `detect_terminal`.

### Codex / other MCP-capable agents

Any agent that speaks MCP over stdio can use it. In Codex's config (`~/.codex/config.toml`):

```toml
[mcp_servers.allow-claude-to-compact]
command = "node"
args = ["C:\\Users\\<you>\\Desktop\\git\\AllowClaudeToCompact\\dist\\index.js"]
```

> If your agent uses a different command to compact its context, set `ACTC_COMMAND` accordingly (e.g. `"/compact"`, `"/summarize"`, …) or pass `command` per call.

## Configuration

All optional, set via environment variables in the MCP server config:

| Variable                 | Default          | Description                                                                          |
| ------------------------ | ---------------- | ------------------------------------------------------------------------------------ |
| `ACTC_COMMAND`           | `/compact`       | Text typed into the terminal.                                                        |
| `ACTC_DELAY_MS`          | `600`            | Milliseconds to wait before stealing focus & typing (lets the turn render).          |
| `ACTC_FOLLOWUP`          | `continue`       | Text typed after the command once compaction has started. Set to `""` to send nothing. |
| `ACTC_FOLLOWUP_DELAY_MS` | `10000`          | Milliseconds to wait between the command and the follow-up text.                     |
| `ACTC_TITLE_REGEX`       | *(unset)*        | .NET regex matched against window titles — overrides process-tree detection.         |
| `ACTC_POWERSHELL`        | `powershell.exe` | PowerShell executable to use (set to `pwsh.exe` for PowerShell 7).                   |

By default the tool runs `/compact`, waits 10 s, then types `continue` so the agent automatically resumes after compaction. To compact **without** auto-resuming, set `ACTC_FOLLOWUP=""` (or pass `followUp: ""` on the call).

## Usage — telling the agent when to compact

The tool is most useful when you instruct the agent up front. Examples you can give in chat or in `CLAUDE.md`:

> "When you finish implementing the feature and the tests pass, call `compact_conversation` before moving on."

> "After each completed sub-task, summarize what you did and then compact the conversation."

Because typing happens in the live terminal, **the agent should call `compact_conversation` as the last action of a turn** so the keystroke is not interrupted by further output. The `delayMs` gives the current turn a moment to finish rendering.

### Suggested `CLAUDE.md` snippet

```markdown
## Context management
You can compact your own context with the `compact_conversation` MCP tool.
Call it as the final step after completing a self-contained task (e.g. a feature
+ passing tests), so we keep the context window lean across long sessions.
```

## Verifying / debugging

Use the **`detect_terminal`** tool (it types nothing) to confirm which window would be targeted:

```
> use the detect_terminal tool
```

It prints the chosen window and the full process chain from the agent up to the terminal. You can also test from the shell without an agent:

```powershell
# Dry run — detects the window but does NOT type anything
node -e "import('./dist/winAutomation.js').then(m=>m.runAutomation({command:'/compact',delayMs:0,dryRun:true}).then(r=>console.log(JSON.stringify(r,null,2))))"
```

Example output:

```json
{
  "success": true,
  "strategy": "process-tree",
  "target": { "name": "WindowsTerminal.exe", "pid": 25060, "hwnd": 133326, "title": "… your session …" },
  "chain": [ { "pid": 12720, "name": "node.exe" }, … , { "pid": 25060, "name": "WindowsTerminal.exe" } ]
}
```

## Troubleshooting

| Symptom                                          | Fix                                                                                                   |
| ------------------------------------------------ | ----------------------------------------------------------------------------------------------------- |
| `No terminal window found`                       | Set `ACTC_TITLE_REGEX` to match your terminal's title (e.g. `"Claude"` or your repo name).            |
| It types into the wrong window                   | Another window grabbed focus. Increase `ACTC_DELAY_MS`, or pin the target with `ACTC_TITLE_REGEX`.    |
| Nothing is typed in VS Code's integrated terminal | VS Code focus may not be on the terminal panel. Click into the terminal, or run the agent in Windows Terminal. |
| `only supports Windows`                          | This version is Windows-only. See [Limitations](#limitations).                                        |

## How detection picks a window

The server walks ancestors of its own process and selects the **closest** one that is (a) a known terminal/editor host **and** (b) owns a real top-level window. Recognized hosts include: Windows Terminal, `powershell` / `pwsh`, `cmd`, `conhost`/`OpenConsole`, VS Code / Cursor / Windsurf, Hyper, WezTerm, Alacritty, mintty, Tabby. Shells hosted inside Windows Terminal report no window of their own, so detection naturally lands on `WindowsTerminal.exe`. An explicit `ACTC_TITLE_REGEX` always wins when set.

## Limitations & notes

- **Windows only.** macOS/Linux would need an AppleScript / `xdotool` / `ydotool` backend (PRs welcome).
- **Focus stealing is intrusive by design** — it brings the terminal to the foreground and sends keystrokes. Don't be typing elsewhere at the moment it fires; the `delayMs` mitigates but cannot eliminate this.
- **One active session per terminal.** Under Windows Terminal it targets the window's *active* tab. If the agent's tab isn't active, switch to it or use a dedicated window. Use `ACTC_TITLE_REGEX` to disambiguate multiple windows.
- **It really types into your prompt.** Treat `compact_conversation` like pressing keys yourself; only enable it where that's acceptable.

## Project layout

```
src/
  index.ts          # MCP server: tools `compact_conversation` + `detect_terminal`
  winAutomation.ts  # Embedded PowerShell automation (process-tree walk, focus, SendKeys)
dist/               # Compiled output (after npm run build)
```

## License

[MIT](./LICENSE) © 2026 Hugo MATHIEU
