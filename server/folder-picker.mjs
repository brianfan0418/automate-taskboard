// W15 follow-up: native folder picker for 建立專案 / 設定專案資料夾.
// The board runs in a Tauri window without IPC and in browsers, so the dialog is opened by the
// board service on this PC: a hidden Windows PowerShell (STA) shows the Explorer-style
// IFileOpenDialog (FOS_PICKFOLDERS), owned by an invisible top-most window so it comes up in
// front of the board. Falls back to FolderBrowserDialog if the COM helper cannot be compiled.
import { spawn as defaultSpawn } from "node:child_process";
import { stat } from "node:fs/promises";
import path from "node:path";

import { ApiError } from "../shared/api-fields.mjs";

export const FOLDER_PICKER_TIMEOUT_MS = 10 * 60 * 1000;

const CSHARP_HELPER = String.raw`
using System;
using System.Runtime.InteropServices;
public static class AutoMateFolderPicker {
  [ComImport, Guid("DC1C5A9C-E88A-4dde-A5A1-60F82A20AEF7")] private class FileOpenDialogRcw {}
  [ComImport, Guid("42f85136-db7e-439c-85f1-e4075d135fc8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  private interface IFileDialog {
    [PreserveSig] int Show(IntPtr parent);
    void SetFileTypes(uint count, IntPtr filters);
    void SetFileTypeIndex(uint index);
    void GetFileTypeIndex(out uint index);
    void Advise(IntPtr events, out uint cookie);
    void Unadvise(uint cookie);
    void SetOptions(uint options);
    void GetOptions(out uint options);
    void SetDefaultFolder(IShellItem item);
    void SetFolder(IShellItem item);
    void GetFolder(out IShellItem item);
    void GetCurrentSelection(out IShellItem item);
    void SetFileName([MarshalAs(UnmanagedType.LPWStr)] string name);
    void GetFileName([MarshalAs(UnmanagedType.LPWStr)] out string name);
    void SetTitle([MarshalAs(UnmanagedType.LPWStr)] string title);
    void SetOkButtonLabel([MarshalAs(UnmanagedType.LPWStr)] string label);
    void SetFileNameLabel([MarshalAs(UnmanagedType.LPWStr)] string label);
    void GetResult(out IShellItem item);
    void AddPlace(IShellItem item, int placement);
    void SetDefaultExtension([MarshalAs(UnmanagedType.LPWStr)] string extension);
    void Close(int result);
    void SetClientGuid(ref Guid guid);
    void ClearClientData();
    void SetFilter(IntPtr filter);
  }
  [ComImport, Guid("43826D1E-E718-42EE-BC55-A1E261C37BFE"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  private interface IShellItem {
    void BindToHandler(IntPtr bindContext, ref Guid handler, ref Guid iid, out IntPtr result);
    void GetParent(out IShellItem parent);
    void GetDisplayName(uint kind, out IntPtr name);
    void GetAttributes(uint mask, out uint attributes);
    void Compare(IShellItem other, uint hint, out int order);
  }
  [DllImport("shell32.dll", CharSet = CharSet.Unicode, PreserveSig = false)]
  private static extern void SHCreateItemFromParsingName(string path, IntPtr bindContext, [MarshalAs(UnmanagedType.LPStruct)] Guid iid, out IShellItem item);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr window);

  private static IFileDialog Create(string title, string initialPath) {
    IFileDialog dialog = (IFileDialog)new FileOpenDialogRcw();
    uint options;
    dialog.GetOptions(out options);
    // FOS_PICKFOLDERS | FOS_FORCEFILESYSTEM | FOS_PATHMUSTEXIST
    dialog.SetOptions(options | 0x20 | 0x40 | 0x800);
    if (!String.IsNullOrEmpty(title)) dialog.SetTitle(title);
    if (!String.IsNullOrEmpty(initialPath)) {
      try {
        IShellItem folder;
        SHCreateItemFromParsingName(initialPath, IntPtr.Zero, typeof(IShellItem).GUID, out folder);
        dialog.SetFolder(folder);
      } catch {}
    }
    return dialog;
  }

  public static string Check() {
    Create("check", null);
    return "READY";
  }

  public static string Pick(IntPtr owner, string title, string initialPath) {
    IFileDialog dialog = Create(title, initialPath);
    int hr = dialog.Show(owner);
    if (hr == unchecked((int)0x800704C7)) return null;
    if (hr != 0) Marshal.ThrowExceptionForHR(hr);
    IShellItem result;
    dialog.GetResult(out result);
    IntPtr name;
    result.GetDisplayName(0x80058000, out name);
    try { return Marshal.PtrToStringUni(name); } finally { Marshal.FreeCoTaskMem(name); }
  }
}
`;

// Output protocol (one line on stdout): READY | CANCEL | OK:<base64 UTF-8 path> | ERROR:<base64 UTF-8 message>
export const FOLDER_PICKER_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
function Emit([string]$prefix, [string]$value) {
  [Console]::Out.WriteLine($prefix + [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($value)))
}
function FromBase64([string]$value) {
  if ([string]::IsNullOrEmpty($value)) { return '' }
  return [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($value))
}
try {
  $title = FromBase64 $env:AUTOMATE_PICKER_TITLE
  $initial = FromBase64 $env:AUTOMATE_PICKER_INITIAL
  Add-Type -AssemblyName System.Windows.Forms
  Add-Type -AssemblyName System.Drawing
  $helper = $true
  try { Add-Type -TypeDefinition $env:AUTOMATE_PICKER_HELPER -Language CSharp } catch { $helper = $false }
  if ($env:AUTOMATE_PICKER_CHECK -eq '1') {
    if (-not $helper) { throw 'folder picker helper did not compile' }
    [Console]::Out.WriteLine([AutoMateFolderPicker]::Check())
    exit 0
  }
  [System.Windows.Forms.Application]::EnableVisualStyles()
  $screen = [System.Windows.Forms.Screen]::PrimaryScreen.WorkingArea
  $owner = New-Object System.Windows.Forms.Form
  $owner.FormBorderStyle = 'None'
  $owner.ShowInTaskbar = $false
  $owner.TopMost = $true
  $owner.Opacity = 0
  $owner.StartPosition = 'Manual'
  $owner.Size = New-Object System.Drawing.Size(1, 1)
  $owner.Location = New-Object System.Drawing.Point(($screen.Left + [int]($screen.Width / 2)), ($screen.Top + [int]($screen.Height / 3)))
  $owner.Show()
  $owner.Activate()
  if ($helper) { [void][AutoMateFolderPicker]::SetForegroundWindow($owner.Handle) }
  $picked = $null
  if ($helper) {
    $picked = [AutoMateFolderPicker]::Pick($owner.Handle, $title, $initial)
  } else {
    $dialog = New-Object System.Windows.Forms.FolderBrowserDialog
    $dialog.Description = $title
    $dialog.ShowNewFolderButton = $true
    if ($initial -and (Test-Path -LiteralPath $initial -PathType Container)) { $dialog.SelectedPath = $initial }
    if ($dialog.ShowDialog($owner) -eq [System.Windows.Forms.DialogResult]::OK) { $picked = $dialog.SelectedPath }
  }
  $owner.Close()
  if ([string]::IsNullOrEmpty($picked)) { [Console]::Out.WriteLine('CANCEL') } else { Emit 'OK:' $picked }
} catch {
  Emit 'ERROR:' $_.Exception.Message
  exit 1
}
`;

function encodePowerShell(script) {
  return Buffer.from(script, "utf16le").toString("base64");
}

function base64(value) {
  return Buffer.from(String(value ?? ""), "utf8").toString("base64");
}

export function parseFolderPickerOutput(stdout) {
  const line = String(stdout ?? "").split(/\r?\n/).map((part) => part.trim()).find(Boolean) ?? "";
  if (line === "CANCEL") return { path: null, canceled: true };
  if (line === "READY") return { ready: true };
  if (line.startsWith("OK:")) return { path: Buffer.from(line.slice(3), "base64").toString("utf8"), canceled: false };
  if (line.startsWith("ERROR:")) return { error: Buffer.from(line.slice(6), "base64").toString("utf8") };
  return { error: line || "folder picker returned no result" };
}

/**
 * Creates the picker used by POST /api/local/pick-folder.
 * `pick({ title, initialPath })` → { path: string|null, canceled: boolean, timedOut?: boolean }.
 */
export function createFolderPicker({
  spawn = defaultSpawn,
  platform = process.platform,
  timeoutMs = FOLDER_PICKER_TIMEOUT_MS,
  systemRoot = process.env.SystemRoot || "C:\\Windows",
} = {}) {
  let busy = false;
  // W15 review O2: the open dialog's process, so a closed page or a server shutdown can close it.
  const activeChildren = new Map();

  function run({ title = "", initialPath = "", check = false, signal = null } = {}) {
    return new Promise((resolve, reject) => {
      const executable = path.win32.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
      let child;
      try {
        child = spawn(executable, [
          "-NoLogo", "-NoProfile", "-NonInteractive", "-Sta", "-ExecutionPolicy", "Bypass",
          "-WindowStyle", "Hidden", "-EncodedCommand", encodePowerShell(FOLDER_PICKER_SCRIPT),
        ], {
          windowsHide: true,
          stdio: ["ignore", "pipe", "pipe"],
          env: {
            ...process.env,
            AUTOMATE_PICKER_HELPER: CSHARP_HELPER,
            AUTOMATE_PICKER_TITLE: base64(title),
            AUTOMATE_PICKER_INITIAL: base64(initialPath),
            AUTOMATE_PICKER_CHECK: check ? "1" : "0",
          },
        });
      } catch (error) {
        reject(error);
        return;
      }
      let stdout = "";
      let stderr = "";
      let timedOut = false;
      let aborted = false;
      const timer = setTimeout(() => {
        timedOut = true;
        try { child.kill(); } catch {}
      }, timeoutMs);
      const onAbort = () => {
        aborted = true;
        try { child.kill(); } catch {}
      };
      activeChildren.set(child, onAbort);
      if (signal?.aborted) onAbort();
      else signal?.addEventListener?.("abort", onAbort, { once: true });
      const finish = () => {
        clearTimeout(timer);
        activeChildren.delete(child);
        signal?.removeEventListener?.("abort", onAbort);
      };
      child.stdout?.on("data", (chunk) => { stdout += chunk; });
      child.stderr?.on("data", (chunk) => { stderr += chunk; });
      child.on("error", (error) => {
        finish();
        reject(error);
      });
      child.on("close", () => {
        finish();
        if (aborted) {
          resolve({ path: null, canceled: true, aborted: true });
          return;
        }
        if (timedOut) {
          resolve({ path: null, canceled: true, timedOut: true });
          return;
        }
        const parsed = parseFolderPickerOutput(stdout);
        if (parsed.error) {
          reject(new Error(`${parsed.error}${stderr ? ` (${stderr.trim().slice(0, 300)})` : ""}`));
          return;
        }
        resolve(parsed);
      });
    });
  }

  return {
    supported: platform === "win32",
    /** Compiles the helper and creates the COM dialog without showing it (tests). */
    async check() {
      if (platform !== "win32") return { ready: false };
      return run({ check: true });
    },
    /** Closes any open dialog (server shutdown). */
    dispose() {
      for (const abort of activeChildren.values()) abort();
    },
    get busy() {
      return busy;
    },
    async pick({ title, initialPath, signal } = {}) {
      if (platform !== "win32") {
        throw new ApiError(501, "FOLDER_PICKER_UNSUPPORTED", "這台電腦不支援選擇資料夾視窗，請直接輸入資料夾路徑");
      }
      if (busy) {
        throw new ApiError(409, "FOLDER_PICKER_BUSY", "選擇資料夾的視窗已經開著，請先在那個視窗選好或取消");
      }
      busy = true;
      try {
        return await run({ title, initialPath, signal });
      } catch (error) {
        throw new ApiError(500, "FOLDER_PICKER_FAILED", `無法開啟選擇資料夾視窗：${error.message}`);
      } finally {
        busy = false;
      }
    },
  };
}

/** Validates a project folder: an absolute path to an existing directory. Returns the normalized path. */
export async function assertProjectFolder(workspacePath, {
  statImpl = stat,
  isAbsolute = path.isAbsolute,
  platform = process.platform,
} = {}) {
  const trimmed = typeof workspacePath === "string" ? workspacePath.trim() : "";
  if (!trimmed) {
    throw new ApiError(400, "WORKSPACE_REQUIRED", "請選擇專案資料夾");
  }
  if (trimmed.includes("\0")) {
    throw new ApiError(400, "INVALID_FIELD", "'workspacePath' cannot contain null bytes");
  }
  // W15 review O3: on Windows a path must start with a drive letter (C:\) or be a UNC share
  // (\\server\share); `\foo` is "absolute" to Node but depends on the current drive.
  const windowsRooted = /^[A-Za-z]:[\\/]/.test(trimmed) || /^[\\/]{2}[^\\/]+[\\/][^\\/]+/.test(trimmed);
  if (!isAbsolute(trimmed) || (platform === "win32" && !windowsRooted)) {
    throw new ApiError(400, "WORKSPACE_NOT_ABSOLUTE", `資料夾路徑要是完整路徑（例如 C:\\Users\\你\\文件\\專案）：${trimmed}`);
  }
  let info = null;
  try {
    info = await statImpl(trimmed);
  } catch {
    info = null;
  }
  if (!info?.isDirectory?.()) {
    throw new ApiError(400, "WORKSPACE_FOLDER_MISSING", `找不到這個資料夾：${trimmed}`, { workspacePath: trimmed });
  }
  return path.normalize(trimmed).replace(/[\\/]+$/, (match, offset, whole) => (
    /^[A-Za-z]:[\\/]$/.test(whole) || whole === "/" ? match : ""
  ));
}
