import { spawn } from "node:child_process";
import { writeFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * The PowerShell script that does the real work on Windows:
 *  1. Walk up the process tree from the MCP server PID to find the terminal
 *     window that ultimately hosts the AI agent.
 *  2. Bring that window to the foreground.
 *  3. Type the command (e.g. "/compact") and press Enter.
 *
 * It is embedded as a string so the package works no matter how it is
 * installed (npm, npx, global, local clone) without path-resolution issues.
 */
const PS_SCRIPT = String.raw`
param(
  [int]$StartPid,
  [string]$CommandText = "/compact",
  [int]$DelayMs = 400,
  [string]$TitleRegex = "",
  [switch]$DryRun
)

$ErrorActionPreference = "Stop"

Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class W32 {
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int n);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr h);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint a, uint b, bool f);
  [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
}
"@ | Out-Null

Add-Type -AssemblyName System.Windows.Forms

# Terminal / editor host processes whose window we are willing to drive.
$terminals = @(
  "windowsterminal.exe","windowsterminalpreview.exe","openconsole.exe",
  "conhost.exe","powershell.exe","pwsh.exe","cmd.exe",
  "code.exe","code - insiders.exe","cursor.exe","windsurf.exe",
  "hyper.exe","wezterm-gui.exe","alacritty.exe","mintty.exe","tabby.exe"
)

function Get-Hwnd-Info($procId) {
  try {
    $p = Get-Process -Id $procId -ErrorAction Stop
    return [pscustomobject]@{ hwnd = $p.MainWindowHandle; title = $p.MainWindowTitle }
  } catch {
    return [pscustomobject]@{ hwnd = [IntPtr]::Zero; title = "" }
  }
}

function Focus-Window([IntPtr]$hwnd) {
  if ([W32]::IsIconic($hwnd)) { [W32]::ShowWindow($hwnd, 9) | Out-Null } # SW_RESTORE
  $fgPid = [uint32]0
  $fg = [W32]::GetForegroundWindow()
  $fgThread = [W32]::GetWindowThreadProcessId($fg, [ref]$fgPid)
  $curThread = [W32]::GetCurrentThreadId()
  [W32]::AttachThreadInput($curThread, $fgThread, $true) | Out-Null
  [W32]::BringWindowToTop($hwnd) | Out-Null
  [W32]::SetForegroundWindow($hwnd) | Out-Null
  [W32]::AttachThreadInput($curThread, $fgThread, $false) | Out-Null
  Start-Sleep -Milliseconds 120
}

function Escape-SendKeys([string]$text) {
  $special = "+^%~(){}[]"
  $sb = New-Object System.Text.StringBuilder
  foreach ($ch in $text.ToCharArray()) {
    if ($special.Contains($ch)) { [void]$sb.Append("{" + $ch + "}") }
    else { [void]$sb.Append($ch) }
  }
  return $sb.ToString()
}

# --- Build the process tree -------------------------------------------------
$procs = Get-CimInstance Win32_Process -ErrorAction Stop |
  Select-Object ProcessId, ParentProcessId, Name
$byId = @{}
foreach ($p in $procs) { $byId[[int]$p.ProcessId] = $p }

$chain = @()
$cur = $StartPid
$guard = 0
while ($cur -and $byId.ContainsKey($cur) -and $guard -lt 64) {
  $p = $byId[$cur]
  $info = Get-Hwnd-Info $cur
  $chain += [pscustomobject]@{
    pid    = $cur
    name   = $p.Name
    parent = [int]$p.ParentProcessId
    hwnd   = [int64]$info.hwnd
    title  = $info.title
  }
  $cur = [int]$p.ParentProcessId
  $guard++
}

# --- Pick the target window -------------------------------------------------
$target = $null
$strategy = ""

# Strategy 1: explicit window-title regex (highest priority when supplied).
if ($TitleRegex -ne "") {
  $match = Get-Process |
    Where-Object { $_.MainWindowHandle -ne 0 -and $_.MainWindowTitle -match $TitleRegex } |
    Select-Object -First 1
  if ($match) {
    $target = [pscustomobject]@{
      pid = $match.Id; name = "$($match.ProcessName).exe"
      hwnd = [int64]$match.MainWindowHandle; title = $match.MainWindowTitle
    }
    $strategy = "title-regex"
  }
}

# Strategy 2: closest ancestor that is a known terminal with a real window.
if ($null -eq $target) {
  foreach ($node in $chain) {
    if ($node.hwnd -ne 0 -and $terminals -contains $node.name.ToLower()) {
      $target = $node
      $strategy = "process-tree"
      break
    }
  }
}

$result = [ordered]@{
  success   = $false
  strategy  = $strategy
  command   = $CommandText
  dryRun    = [bool]$DryRun
  startPid  = $StartPid
  target    = $null
  chain     = $chain
  message   = ""
}

if ($null -eq $target) {
  $result.message = "No terminal window found by walking the process tree. Set ACTC_TITLE_REGEX to target a window by title."
  $result | ConvertTo-Json -Depth 6 -Compress
  exit 2
}

$result.target = [ordered]@{
  pid = $target.pid; name = $target.name; hwnd = $target.hwnd; title = $target.title
}

if ($DryRun) {
  $result.success = $true
  $result.message = "Dry run: would type '$CommandText' + Enter into window '$($target.title)' (pid $($target.pid))."
  $result | ConvertTo-Json -Depth 6 -Compress
  exit 0
}

if ($DelayMs -gt 0) { Start-Sleep -Milliseconds $DelayMs }

try {
  Focus-Window ([IntPtr]$target.hwnd)
  [System.Windows.Forms.SendKeys]::SendWait((Escape-SendKeys $CommandText))
  Start-Sleep -Milliseconds 150
  [System.Windows.Forms.SendKeys]::SendWait("{ENTER}")
  $result.success = $true
  $result.message = "Typed '$CommandText' + Enter into '$($target.title)' (pid $($target.pid))."
} catch {
  $result.message = "Failed while sending keys: $($_.Exception.Message)"
  $result | ConvertTo-Json -Depth 6 -Compress
  exit 3
}

$result | ConvertTo-Json -Depth 6 -Compress
exit 0
`;

export interface ChainNode {
  pid: number;
  name: string;
  parent: number;
  hwnd: number;
  title: string;
}

export interface AutomationTarget {
  pid: number;
  name: string;
  hwnd: number;
  title: string;
}

export interface AutomationResult {
  success: boolean;
  strategy: string;
  command: string;
  dryRun: boolean;
  startPid: number;
  target: AutomationTarget | null;
  chain: ChainNode[];
  message: string;
}

export interface RunOptions {
  command: string;
  delayMs: number;
  titleRegex?: string;
  dryRun?: boolean;
  startPid?: number;
}

/**
 * Execute the PowerShell automation and return its parsed result.
 * Throws only on a hard failure to launch PowerShell; logical failures
 * (no window found, send error) are reported via the returned object.
 */
export async function runAutomation(opts: RunOptions): Promise<AutomationResult> {
  if (process.platform !== "win32") {
    throw new Error(
      `This MCP server currently only supports Windows (win32). Detected platform: ${process.platform}.`
    );
  }

  const dir = await mkdtemp(join(tmpdir(), "actc-"));
  const scriptPath = join(dir, "compact.ps1");
  await writeFile(scriptPath, PS_SCRIPT, "utf8");

  const startPid = opts.startPid ?? process.pid;
  const args = [
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    scriptPath,
    "-StartPid",
    String(startPid),
    "-CommandText",
    opts.command,
    "-DelayMs",
    String(opts.delayMs),
  ];
  if (opts.titleRegex) {
    args.push("-TitleRegex", opts.titleRegex);
  }
  if (opts.dryRun) {
    args.push("-DryRun");
  }

  try {
    const { stdout, stderr, code } = await spawnPwsh(args);
    const parsed = parseLastJson(stdout);
    if (parsed) return parsed;

    // Could not parse JSON: surface raw output for debugging.
    return {
      success: false,
      strategy: "",
      command: opts.command,
      dryRun: !!opts.dryRun,
      startPid,
      target: null,
      chain: [],
      message:
        `PowerShell exited with code ${code} but produced no parseable result.\n` +
        `stdout: ${stdout.trim()}\nstderr: ${stderr.trim()}`,
    };
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

function spawnPwsh(
  args: string[]
): Promise<{ stdout: string; stderr: string; code: number | null }> {
  return new Promise((resolve, reject) => {
    const exe = process.env.ACTC_POWERSHELL || "powershell.exe";
    const child = spawn(exe, args, { windowsHide: true });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => (stderr += d.toString()));
    child.on("error", reject);
    child.on("close", (code) => resolve({ stdout, stderr, code }));
  });
}

function parseLastJson(text: string): AutomationResult | null {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (line.startsWith("{") && line.endsWith("}")) {
      try {
        return JSON.parse(line) as AutomationResult;
      } catch {
        // keep looking
      }
    }
  }
  return null;
}
