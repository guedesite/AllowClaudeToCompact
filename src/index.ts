#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { runAutomation } from "./winAutomation.js";

// --- Configuration via environment variables --------------------------------
// ACTC_COMMAND           : the text to type (default "/compact")
// ACTC_DELAY_MS          : delay before stealing focus & typing (default 600)
// ACTC_TITLE_REGEX       : optional regex to find the target terminal by window title
// ACTC_FOLLOWUP          : text typed after the command (default "continue"; "" disables)
// ACTC_FOLLOWUP_DELAY_MS : wait between command and follow-up (default 1000)
const DEFAULT_COMMAND = process.env.ACTC_COMMAND || "/compact";
const DEFAULT_DELAY_MS = parseInt(process.env.ACTC_DELAY_MS || "600", 10);
const DEFAULT_TITLE_REGEX = process.env.ACTC_TITLE_REGEX || undefined;
const DEFAULT_FOLLOWUP =
  process.env.ACTC_FOLLOWUP !== undefined ? process.env.ACTC_FOLLOWUP : "continue";
const DEFAULT_FOLLOWUP_DELAY_MS = parseInt(
  process.env.ACTC_FOLLOWUP_DELAY_MS || "10000",
  10
);

const server = new McpServer({
  name: "allow-claude-to-compact",
  version: "1.0.0",
});

server.registerTool(
  "compact_conversation",
  {
    title: "Compact my own conversation",
    description:
      "Trigger a /compact of YOUR OWN conversation context. This works by focusing the " +
      "terminal window that runs this agent and typing the compact command (default '/compact') " +
      "followed by Enter. Call this when you have finished a logical chunk of work and want to " +
      "summarize and free up context before continuing — something agents normally cannot do for " +
      "themselves. By default, after compacting it waits ~10s and types 'continue' so you resume " +
      "your work automatically once compaction finishes. The compaction happens after this tool " +
      "returns. Prefer calling it as the last action of a turn so the typed command is not interrupted.",
    inputSchema: {
      command: z
        .string()
        .optional()
        .describe(
          `Text to type into the terminal. Defaults to "${DEFAULT_COMMAND}". ` +
            `Override only if your agent uses a different command to compact context.`
        ),
      delayMs: z
        .number()
        .int()
        .min(0)
        .max(10000)
        .optional()
        .describe(
          `Milliseconds to wait before focusing the terminal and typing (default ${DEFAULT_DELAY_MS}). ` +
            `A short delay lets the current turn finish rendering first.`
        ),
      titleRegex: z
        .string()
        .optional()
        .describe(
          "Optional .NET regex matched against window titles to pick the target terminal. " +
            "Only needed when automatic process-tree detection fails."
        ),
      followUp: z
        .string()
        .optional()
        .describe(
          `Text to type after the compact command, once compaction has had time to start. ` +
            `Defaults to "${DEFAULT_FOLLOWUP}". Pass an empty string to send nothing.`
        ),
      followUpDelayMs: z
        .number()
        .int()
        .min(0)
        .max(60000)
        .optional()
        .describe(
          `Milliseconds to wait between the compact command and the follow-up text ` +
            `(default ${DEFAULT_FOLLOWUP_DELAY_MS}).`
        ),
    },
  },
  async ({ command, delayMs, titleRegex, followUp, followUpDelayMs }) => {
    const result = await runAutomation({
      command: command ?? DEFAULT_COMMAND,
      delayMs: delayMs ?? DEFAULT_DELAY_MS,
      titleRegex: titleRegex ?? DEFAULT_TITLE_REGEX,
      followUp: followUp ?? DEFAULT_FOLLOWUP,
      followUpDelayMs: followUpDelayMs ?? DEFAULT_FOLLOWUP_DELAY_MS,
    });

    return {
      isError: !result.success,
      content: [
        {
          type: "text" as const,
          text: result.success
            ? `OK — ${result.message}`
            : `Could not compact: ${result.message}`,
        },
      ],
    };
  }
);

server.registerTool(
  "detect_terminal",
  {
    title: "Detect the host terminal (diagnostic)",
    description:
      "Diagnostic tool. Walks the process tree (and optional title regex) to report which terminal " +
      "window would be targeted by compact_conversation, WITHOUT typing anything. Use this to verify " +
      "setup or debug detection issues.",
    inputSchema: {
      titleRegex: z
        .string()
        .optional()
        .describe("Optional .NET regex matched against window titles."),
    },
  },
  async ({ titleRegex }) => {
    const result = await runAutomation({
      command: DEFAULT_COMMAND,
      delayMs: 0,
      titleRegex: titleRegex ?? DEFAULT_TITLE_REGEX,
      followUp: DEFAULT_FOLLOWUP,
      followUpDelayMs: DEFAULT_FOLLOWUP_DELAY_MS,
      dryRun: true,
    });

    const lines: string[] = [];
    if (result.target) {
      lines.push(
        `Target window (via ${result.strategy}):`,
        `  process : ${result.target.name} (pid ${result.target.pid})`,
        `  title   : ${result.target.title || "(untitled)"}`,
        `  hwnd    : ${result.target.hwnd}`
      );
    } else {
      lines.push(`No target window found. ${result.message}`);
    }
    lines.push("", "Process chain (agent → terminal):");
    for (const node of result.chain) {
      const win = node.hwnd ? ` [window: "${node.title}"]` : "";
      lines.push(`  pid ${node.pid} ${node.name}${win}`);
    }

    return {
      isError: !result.target,
      content: [{ type: "text" as const, text: lines.join("\n") }],
    };
  }
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // Log to stderr only — stdout is reserved for the MCP protocol.
  process.stderr.write(
    "[allow-claude-to-compact] MCP server started (stdio).\n"
  );
}

main().catch((err) => {
  process.stderr.write(`[allow-claude-to-compact] fatal: ${err?.stack || err}\n`);
  process.exit(1);
});
