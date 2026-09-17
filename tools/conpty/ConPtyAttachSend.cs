using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;

// ConPtyAttachSend: run `claude.exe attach <shortId>` under a real ConPTY, wait for the attached
// UI to be ready, type a message read from a UTF-8 file, submit with a separate CR, confirm the
// turn started, then DETACH (Ctrl+Z, client-side) without stopping the background session.
//
// Detach rationale (claude.exe v2.1.272): `claude attach --help` says "Ctrl+Z drops back to your
// shell. The session keeps running either way." In the attach client's stdin filter, byte 0x1A
// (and CSI-u Ctrl+Z, and the Ctrl+B,d prefix sequence) returns outcome "detached" locally and
// is NOT forwarded to the session. /exit is never sent.
//
// v2 (--mode): queue = wait for prompt marker + 1.5 s output silence (v1 behaviour);
// steer = type as soon as the prompt marker is drawn (fixed ~600 ms settle, no silence requirement);
// interrupt = prompt marker, then a single ESC (0x1B) as its own write, wait (<=10 s) for evidence the
// turn stopped, then type. Interrupt key source (claude.exe 2.1.272 bundle strings): default keybindings
// context "Chat" maps escape -> "chat:cancel", whose handler aborts the running turn with gesture "escape"
// (active only while work is in progress); the UI then prints "Interrupted - What should Claude do instead?".
// Double-ESC is the rewind/message-selector gesture, so exactly ONE ESC is sent.
// In interrupt mode the message file may be empty: then only the ESC is sent and nothing is typed.
//
// Pre-Enter gate (CONTRACTS Amendment 9, BUG-W8-1): with `--gate-file <path>` (queue/steer), the helper types nothing
// when the file already says `abort`; otherwise, after typing and the paste settle pause, it prints the line `TYPED`
// to stdout and polls the file every 50 ms for up to 5 s. `go` -> CR as usual. `abort` or no answer -> no CR; the
// typed text is erased with one DEL (0x7F, Backspace) per typed UTF-16 unit (extra DELs on an empty prompt do
// nothing). ESC is never used for this (it interrupts a running turn), and in claude.exe 2.1.271 Ctrl+L
// "chat:clearInput" is bound to a screen redraw and Ctrl+U only deletes to the start of the current line.
// Receipt: gateResult "go"|"abort"|"timeout", crSent false, inputCleared, abortReason "gate-<result>".
//
// Exit code (Relay Taskboard v2): 0 only when the child started, abortReason is null, stateMarkers holds no
// FATAL marker, and (mode is interrupt, or the message was typed and CR was sent); otherwise 5.
// Argument/usage errors before any attach attempt still exit 2 with an {"error":...} line and no receipt.
class ConPtyAttachSend
{
    const char ESC = (char)27;
    const int EXTENDED_STARTUPINFO_PRESENT = 0x00080000;
    const int CREATE_UNICODE_ENVIRONMENT = 0x00000400;
    const int WAIT_TIMEOUT = 258;
    static readonly IntPtr PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE = new IntPtr(0x00020016);

    [StructLayout(LayoutKind.Sequential)] struct COORD { public short X; public short Y; }
    [StructLayout(LayoutKind.Sequential)] struct STARTUPINFO {
        public int cb; public string lpReserved; public string lpDesktop; public string lpTitle;
        public int dwX; public int dwY; public int dwXSize; public int dwYSize; public int dwXCountChars; public int dwYCountChars;
        public int dwFillAttribute; public int dwFlags; public short wShowWindow; public short cbReserved2;
        public IntPtr lpReserved2; public IntPtr hStdInput; public IntPtr hStdOutput; public IntPtr hStdError;
    }
    [StructLayout(LayoutKind.Sequential)] struct STARTUPINFOEX { public STARTUPINFO StartupInfo; public IntPtr lpAttributeList; }
    [StructLayout(LayoutKind.Sequential)] struct PROCESS_INFORMATION { public IntPtr hProcess; public IntPtr hThread; public int dwProcessId; public int dwThreadId; }

    [DllImport("kernel32.dll", SetLastError=true)] static extern bool CreatePipe(out IntPtr readPipe, out IntPtr writePipe, IntPtr attributes, int size);
    [DllImport("kernel32.dll", SetLastError=true)] static extern int CreatePseudoConsole(COORD size, IntPtr inputRead, IntPtr outputWrite, int flags, out IntPtr pseudoConsole);
    [DllImport("kernel32.dll", SetLastError=true)] static extern void ClosePseudoConsole(IntPtr pseudoConsole);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool InitializeProcThreadAttributeList(IntPtr list, int count, int flags, ref IntPtr size);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool UpdateProcThreadAttribute(IntPtr list, int flags, IntPtr attribute, IntPtr value, IntPtr size, IntPtr previousValue, IntPtr returnSize);
    [DllImport("kernel32.dll")] static extern void DeleteProcThreadAttributeList(IntPtr list);
    [DllImport("kernel32.dll", SetLastError=true, CharSet=CharSet.Unicode)] static extern bool CreateProcess(string applicationName, StringBuilder commandLine, IntPtr processAttributes, IntPtr threadAttributes, bool inheritHandles, int creationFlags, IntPtr environment, string currentDirectory, ref STARTUPINFOEX startupInfo, out PROCESS_INFORMATION processInformation);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool WriteFile(IntPtr handle, byte[] bytes, int bytesToWrite, out int bytesWritten, IntPtr overlapped);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool ReadFile(IntPtr handle, byte[] bytes, int bytesToRead, out int bytesRead, IntPtr overlapped);
    [DllImport("kernel32.dll")] static extern int WaitForSingleObject(IntPtr handle, int milliseconds);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetExitCodeProcess(IntPtr process, out int exitCode);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool TerminateProcess(IntPtr process, int exitCode);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
    [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr GetStdHandle(int stdHandle);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool SetStdHandle(int stdHandle, IntPtr handle);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool SetHandleInformation(IntPtr handle, int mask, int flags);

    static readonly MemoryStream captured = new MemoryStream();
    static readonly object captureLock = new object();
    static IntPtr inputWrite = IntPtr.Zero;

    static byte[] CapturedBytesArr() { lock (captureLock) { return captured.ToArray(); } }
    static string CapturedText() { return Encoding.UTF8.GetString(CapturedBytesArr()); }
    static long CapturedBytes() { lock (captureLock) { return captured.Length; } }
    static string CapturedTextFrom(long offset) {
        lock (captureLock) {
            byte[] all = captured.ToArray();
            if (offset < 0) offset = 0;
            if (offset > all.Length) offset = all.Length;
            return Encoding.UTF8.GetString(all, (int)offset, all.Length - (int)offset);
        }
    }

    static readonly List<string> droppedVars = new List<string>();

    // Same scrub as the probe: drop CLAUDE* / ANTHROPIC* / MCP_* / AI_AGENT so the child sees a plain console env.
    static IntPtr BuildScrubbedEnvironment()
    {
        SortedDictionary<string, string> keep = new SortedDictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        foreach (System.Collections.DictionaryEntry e in Environment.GetEnvironmentVariables()) {
            string k = (string)e.Key;
            if (k.Length == 0) continue;
            string ku = k.ToUpperInvariant();
            if (ku.StartsWith("CLAUDE") || ku.StartsWith("ANTHROPIC") || ku.StartsWith("MCP_") || ku == "AI_AGENT") { droppedVars.Add(k); continue; }
            keep[k] = (string)e.Value;
        }
        StringBuilder sb = new StringBuilder();
        foreach (KeyValuePair<string, string> kv in keep) { sb.Append(kv.Key).Append('=').Append(kv.Value).Append((char)0); }
        sb.Append((char)0);
        return Marshal.StringToHGlobalUni(sb.ToString());
    }

    static void Send(string s)
    {
        byte[] b = Encoding.UTF8.GetBytes(s);
        int written;
        if (!WriteFile(inputWrite, b, b.Length, out written, IntPtr.Zero) || written != b.Length)
            throw new InvalidOperationException("WriteFile:" + Marshal.GetLastWin32Error());
    }

    static string Normalize(string text)
    {
        string s = StripAnsi(text);
        StringBuilder sb = new StringBuilder(s.Length);
        foreach (char c in s) { if (c > ' ') sb.Append(char.ToLowerInvariant(c)); }
        return sb.ToString();
    }

    static bool Has(string norm, string needle) { return norm.IndexOf(needle, StringComparison.Ordinal) >= 0; }

    static bool TrustPromptVisible(string norm)
    {
        return Has(norm, "projectyoucreatedoroneyoutrust") || Has(norm, "doyoutrustthefiles") || Has(norm, "yes,itrustthisfolder");
    }

    // Every UI-readiness marker currently visible (probe's list plus attach-specific ones).
    static List<string> ReadyMarkers(string norm, string rawText)
    {
        List<string> m = new List<string>();
        if (rawText.IndexOf(ESC + "[", StringComparison.Ordinal) < 0) return m;
        if (Has(norm, "shift+tabtocycle")) m.Add("mode-hint");
        if (Has(norm, "forshortcuts")) m.Add("for-shortcuts");
        if (Has(norm, "foragents")) m.Add("left-for-agents");
        if (Has(norm, ((char)0x276F).ToString())) m.Add("prompt-caret");
        if (Has(norm, ((char)0x256D).ToString()) && Has(norm, ((char)0x2570).ToString())) m.Add("prompt-box-corners");
        if (Has(norm, "try\"")) m.Add("try-hint");
        return m;
    }

    // Other notable screen states (recap, busy, errors). Recorded, some are fatal.
    static List<string> StateMarkers(string norm)
    {
        List<string> m = new List<string>();
        if (Has(norm, "whileyouwereaway") || Has(norm, "sinceyoulastlooked") || Has(norm, "recap")) m.Add("recap");
        if (Has(norm, "reconnecting")) m.Add("reconnecting");
        if (Has(norm, "esctointerrupt")) m.Add("busy-esc-to-interrupt");
        // Kept specific: these checks see the whole screen, including any transcript recap text.
        if (Has(norm, "pressentertorespawn")) m.Add("FATAL:session-crashed-respawn-prompt");
        if (Has(norm, "enojob")) m.Add("FATAL:enojob");
        if (Has(norm, "nojobmatching")) m.Add("FATAL:no-job-matching-id");
        if (Has(norm, "couldn'treconnectto") || Has(norm, "couldn'trestartthe")) m.Add("FATAL:daemon-unavailable");
        return m;
    }

    // Live spinner line, e.g. "<glyph> Infusing<U+2026> (11s ...)" -> normalized "<glyph>infusing<U+2026>(11s". Completed
    // lines ("<glyph> Brewed for 23s - done") have no ellipsis after the verb. Only meaningful on RECENT output.
    static readonly Regex SpinnerActive = new Regex("[\u273B\u2736\u2733\u2722\u273D\u00B7*]\\p{L}+\u2026", RegexOptions.CultureInvariant);
    static List<string> BusyMarkers(string recentNorm)
    {
        List<string> m = new List<string>();
        if (SpinnerActive.IsMatch(recentNorm)) m.Add("spinner-active");
        if (Has(recentNorm, "esctointerrupt")) m.Add("esc-to-interrupt");
        return m;
    }
    static string RecentText(int windowMs) { long off = CapturedBytes(); Thread.Sleep(windowMs); return CapturedTextFrom(off); }

    static bool AnyFatal(List<string> states) { foreach (string s in states) if (s.StartsWith("FATAL:")) return true; return false; }

    static string StripAnsi(string s)
    {
        StringBuilder sb = new StringBuilder(s.Length);
        for (int i = 0; i < s.Length; i++) {
            char c = s[i];
            if (c == ESC) {
                if (i + 1 < s.Length && (s[i + 1] == '[' || s[i + 1] == '?')) {
                    i++;
                    while (i + 1 < s.Length && !(s[i + 1] >= '@' && s[i + 1] <= '~' && s[i + 1] != '[')) i++;
                    i++;
                } else if (i + 1 < s.Length && (s[i + 1] == ']' || s[i + 1] == '_' || s[i + 1] == 'P' || s[i + 1] == '^')) {
                    i++;
                    while (i + 1 < s.Length && s[i + 1] != (char)7 && !(s[i + 1] == ESC && i + 2 < s.Length && s[i + 2] == '\\')) i++;
                    i++;
                    if (i < s.Length && s[i] == ESC) i++;
                } else { i++; }
                continue;
            }
            sb.Append(c);
        }
        return sb.ToString();
    }

    static string Collapse(string s)
    {
        StringBuilder sb = new StringBuilder(s.Length);
        char prev = (char)0;
        foreach (char c in s) {
            char o = c;
            if (c == '\r') continue;
            if (char.IsControl(c) && c != '\n') o = ' ';
            if (o == ' ' && prev == ' ') continue;
            if (o == '\n' && prev == '\n') continue;
            sb.Append(o);
            prev = o;
        }
        return sb.ToString();
    }

    static string JsonEscape(string s)
    {
        StringBuilder sb = new StringBuilder(s.Length + 16);
        foreach (char c in s) {
            if (c == '"') sb.Append("\\\"");
            else if (c == '\\') sb.Append("\\\\");
            else if (c == '\n') sb.Append("\\n");
            else if (c < 0x20 || c == 0x7f) sb.Append("\\u").Append(((int)c).ToString("x4"));
            else sb.Append(c);
        }
        return sb.ToString();
    }

    static string JsonList(List<string> items)
    {
        StringBuilder sb = new StringBuilder("[");
        for (int i = 0; i < items.Count; i++) { if (i > 0) sb.Append(","); sb.Append("\"").Append(JsonEscape(items[i])).Append("\""); }
        return sb.Append("]").ToString();
    }

    static void AddUnique(List<string> list, IEnumerable<string> items) { foreach (string s in items) if (!list.Contains(s)) list.Add(s); }

    static string Excerpt(string raw, int head, int tail)
    {
        string t = Collapse(StripAnsi(raw));
        if (t.Length <= head + tail) return t;
        return t.Substring(0, head) + "\n...[" + (t.Length - head - tail) + " chars omitted]...\n" + t.Substring(t.Length - tail);
    }

    // Remove control chars that the attach client or TUI would interpret as keys
    // (0x1A = detach, 0x02 = detach prefix, ESC, 0x03, ...). Keep \n and \t.
    static string SanitizeMessage(string s)
    {
        s = s.Replace("\r\n", "\n").Replace('\r', '\n');
        if (s.Length > 0 && s[0] == (char)0xFEFF) s = s.Substring(1);
        StringBuilder sb = new StringBuilder(s.Length);
        foreach (char c in s) { if (c == '\n' || c == '\t' || !(c < 0x20 || c == 0x7f || (c >= 0x80 && c <= 0x9f))) sb.Append(c); }
        return sb.ToString().Trim('\n', ' ', '\t');
    }

    const int GATE_TIMEOUT_MS = 5000;
    const int GATE_POLL_MS = 50;

    // "go" | "abort" | null (missing, empty or anything else). Opened with full sharing: the board rewrites it.
    static string ReadGate(string gateFile)
    {
        try {
            using (FileStream fs = new FileStream(gateFile, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete))
            using (StreamReader sr = new StreamReader(fs, new UTF8Encoding(false))) {
                string v = sr.ReadToEnd().Trim().ToLowerInvariant();
                if (v == "go" || v == "abort") return v;
            }
        } catch {}
        return null;
    }

    static int Main(string[] args)
    {
        try { Console.OutputEncoding = new UTF8Encoding(false); } catch {}
        string mode = "queue";
        string gateFile = null;
        List<string> pos = new List<string>();
        for (int ai = 0; ai < args.Length; ai++) {
            if (args[ai] == "--gate-file") {
                if (ai + 1 >= args.Length) { Console.WriteLine("{\"error\":\"--gate-file needs a path\"}"); return 2; }
                gateFile = args[++ai];
            } else if (args[ai].StartsWith("--gate-file=")) {
                gateFile = args[ai].Substring(12);
            } else if (args[ai] == "--mode") {
                if (ai + 1 >= args.Length) { Console.WriteLine("{\"error\":\"--mode needs a value: queue|steer|interrupt\"}"); return 2; }
                mode = args[++ai].ToLowerInvariant();
            } else if (args[ai].StartsWith("--mode=")) {
                mode = args[ai].Substring(7).ToLowerInvariant();
            } else pos.Add(args[ai]);
        }
        if (mode != "queue" && mode != "steer" && mode != "interrupt") { Console.WriteLine("{\"error\":\"invalid --mode (queue|steer|interrupt)\"}"); return 2; }
        args = pos.ToArray();
        if (args.Length < 4) {
            Console.WriteLine("{\"error\":\"usage: ConPtyAttachSend.exe <claude.exe> <shortId> <messageFile> <output.bin> [readyTimeoutMs=60000] [totalTimeoutMs=120000] [--mode queue|steer|interrupt] [--gate-file <path>]\"}");
            return 2;
        }
        string exePath = args[0];
        string shortId = args[1];
        string messageFile = args[2];
        string rawPath = args[3];
        int readyTimeoutMs = args.Length > 4 ? int.Parse(args[4]) : 60000;
        int totalTimeoutMs = args.Length > 5 ? int.Parse(args[5]) : 120000;
        if (readyTimeoutMs > totalTimeoutMs - 15000) readyTimeoutMs = Math.Max(5000, totalTimeoutMs - 15000);

        Stopwatch clock = Stopwatch.StartNew();
        List<string> stages = new List<string>();
        List<string> readyMarkers = new List<string>();
        List<string> stateMarkers = new List<string>();
        List<string> turnEvidence = new List<string>();
        string abortReason = null;
        bool uiReady = false; long uiReadyMs = -1;
        bool typed = false, crSent = false; long crSentMs = -1;
        string typedMode = null; int typedChars = 0;
        string detachMethod = null; bool detachedCleanly = false; bool clientTerminated = false;
        bool trustPromptSeen = false;
        int exitCode = -1;
        bool interruptSent = false; long interruptSentMs = -1;
        List<string> interruptEvidence = new List<string>();
        bool typedWhileBusy = false;
        List<string> busyAtType = new List<string>();
        Exception readerFailure = null;
        if (gateFile != null && (gateFile.Length == 0 || mode == "interrupt")) gateFile = null;
        string gateResult = null; long gateWaitMs = -1;
        bool inputCleared = false; string clearMethod = null;

        // Validate shortId: it goes onto a command line.
        foreach (char c in shortId) {
            if (!(char.IsLetterOrDigit(c) || c == '-' || c == '_')) {
                Console.WriteLine("{\"error\":\"invalid shortId characters\"}"); return 2;
            }
        }
        string message;
        try { message = SanitizeMessage(File.ReadAllText(messageFile, new UTF8Encoding(false, true))); }
        catch (Exception ex) { Console.WriteLine("{\"error\":\"cannot read messageFile as UTF-8: " + JsonEscape(ex.Message) + "\"}"); return 2; }
        if (message.Length == 0 && mode != "interrupt") { Console.WriteLine("{\"error\":\"messageFile is empty after sanitizing\"}"); return 2; }

        IntPtr inputRead = IntPtr.Zero, outputRead = IntPtr.Zero, outputWrite = IntPtr.Zero, hpc = IntPtr.Zero, attributeList = IntPtr.Zero, envBlock = IntPtr.Zero;
        PROCESS_INFORMATION pi = new PROCESS_INFORMATION();
        bool childStarted = false;
        Thread reader = null;

        try {
            if (!CreatePipe(out inputRead, out inputWrite, IntPtr.Zero, 0) || !CreatePipe(out outputRead, out outputWrite, IntPtr.Zero, 0)) throw new InvalidOperationException("CreatePipe:" + Marshal.GetLastWin32Error());
            int hresult = CreatePseudoConsole(new COORD { X = 120, Y = 40 }, inputRead, outputWrite, 0, out hpc);
            if (hresult != 0) throw new InvalidOperationException("CreatePseudoConsole:0x" + hresult.ToString("X8"));
            IntPtr bytes = IntPtr.Zero;
            InitializeProcThreadAttributeList(IntPtr.Zero, 1, 0, ref bytes);
            attributeList = Marshal.AllocHGlobal(bytes);
            if (!InitializeProcThreadAttributeList(attributeList, 1, 0, ref bytes)) throw new InvalidOperationException("InitializeProcThreadAttributeList:" + Marshal.GetLastWin32Error());
            if (!UpdateProcThreadAttribute(attributeList, 0, PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE, hpc, (IntPtr)IntPtr.Size, IntPtr.Zero, IntPtr.Zero)) throw new InvalidOperationException("UpdateProcThreadAttribute:" + Marshal.GetLastWin32Error());
            STARTUPINFOEX startup = new STARTUPINFOEX();
            startup.StartupInfo.cb = Marshal.SizeOf(typeof(STARTUPINFOEX));
            startup.lpAttributeList = attributeList;
            StringBuilder command = new StringBuilder("\"" + exePath + "\" attach " + shortId);
            envBlock = BuildScrubbedEnvironment();
            // Blank the parent's std handles across CreateProcess so the child uses the pseudoconsole (probe DEFECT 4 fix).
            IntPtr savedIn = GetStdHandle(-10), savedOut = GetStdHandle(-11), savedErr = GetStdHandle(-12);
            if (savedIn != IntPtr.Zero) SetHandleInformation(savedIn, 1, 0);
            if (savedOut != IntPtr.Zero) SetHandleInformation(savedOut, 1, 0);
            if (savedErr != IntPtr.Zero) SetHandleInformation(savedErr, 1, 0);
            SetStdHandle(-10, IntPtr.Zero); SetStdHandle(-11, IntPtr.Zero); SetStdHandle(-12, IntPtr.Zero);
            bool created; int createErr;
            try {
                created = CreateProcess(null, command, IntPtr.Zero, IntPtr.Zero, false, EXTENDED_STARTUPINFO_PRESENT | CREATE_UNICODE_ENVIRONMENT, envBlock, Environment.CurrentDirectory, ref startup, out pi);
                createErr = Marshal.GetLastWin32Error();
            } finally {
                SetStdHandle(-10, savedIn); SetStdHandle(-11, savedOut); SetStdHandle(-12, savedErr);
            }
            if (!created) throw new InvalidOperationException("CreateProcess:" + createErr);
            childStarted = true;
            stages.Add("child-started");
            // The pseudoconsole holds its own copies; closing ours lets ReadFile see EOF when conhost exits
            // (otherwise the reader blocks forever and CloseHandle(outputRead) hangs at cleanup).
            CloseHandle(outputWrite); outputWrite = IntPtr.Zero;
            CloseHandle(inputRead); inputRead = IntPtr.Zero;

            IntPtr outRead = outputRead;
            reader = new Thread(delegate() {
                try {
                    byte[] buffer = new byte[8192];
                    int read;
                    while (ReadFile(outRead, buffer, buffer.Length, out read, IntPtr.Zero) && read > 0) {
                        lock (captureLock) { captured.Write(buffer, 0, read); }
                    }
                } catch (Exception ex) { readerFailure = ex; }
            });
            reader.IsBackground = true;
            reader.Start();

            // ---- Phase 1: wait for attached UI ready (marker seen AND output quiet, so a recap replay has finished).
            long lastBytes = -1, lastChangeMs = 0;
            bool exitedEarly = false;
            while (clock.ElapsedMilliseconds < readyTimeoutMs) {
                if (WaitForSingleObject(pi.hProcess, 0) == 0) { exitedEarly = true; stages.Add("child-exited-before-ready"); break; }
                string text = CapturedText();
                string norm = Normalize(text);
                AddUnique(stateMarkers, StateMarkers(norm));
                if (AnyFatal(stateMarkers)) { abortReason = "fatal-screen-state"; stages.Add("fatal-state-seen"); break; }
                if (!trustPromptSeen && TrustPromptVisible(norm)) {
                    // An attach to an existing session should not show this; do not answer it blindly.
                    trustPromptSeen = true; abortReason = "unexpected-trust-prompt"; stages.Add("trust-prompt-seen-abort"); break;
                }
                List<string> m = ReadyMarkers(norm, text);
                AddUnique(readyMarkers, m);
                long nowBytes = CapturedBytes();
                if (nowBytes != lastBytes) { lastBytes = nowBytes; lastChangeMs = clock.ElapsedMilliseconds; }
                long quietMs = clock.ElapsedMilliseconds - lastChangeMs;
                bool promptish = m.Contains("prompt-caret") || m.Contains("mode-hint") || m.Contains("for-shortcuts") || m.Contains("left-for-agents");
                // steer/interrupt: the prompt being drawn is enough (a running turn keeps the screen busy).
                if (promptish && (mode != "queue" || quietMs >= 1500)) { uiReady = true; uiReadyMs = clock.ElapsedMilliseconds; break; }
                if (m.Count > 0 && quietMs >= 4000) { uiReady = true; uiReadyMs = clock.ElapsedMilliseconds; readyMarkers.Add("quiet-fallback"); break; }
                Thread.Sleep(200);
            }
            if (!uiReady && abortReason == null) abortReason = exitedEarly ? "child-exited-before-ready" : "ui-ready-timeout";

            string preTypeRecent = "";
            if (uiReady) {
                stages.Add("ui-ready");
                preTypeRecent = RecentText(mode == "queue" ? 800 : 600);
                AddUnique(stateMarkers, StateMarkers(Normalize(CapturedText())));
                if (AnyFatal(stateMarkers)) { uiReady = false; abortReason = "fatal-screen-state-after-ready"; stages.Add("fatal-state-seen"); }
            }

            // ---- Phase 1b (interrupt mode only): ONE ESC as its own write, bounded wait for the turn to stop.
            if (uiReady && mode == "interrupt" && WaitForSingleObject(pi.hProcess, 0) != 0) {
                List<string> busyBefore = BusyMarkers(Normalize(preTypeRecent));
                foreach (string b in busyBefore) interruptEvidence.Add("busy-before-esc:" + b);
                if (busyBefore.Count == 0) interruptEvidence.Add("not-busy-before-esc");
                long escOffset = CapturedBytes();
                Send(ESC.ToString());
                interruptSent = true; interruptSentMs = clock.ElapsedMilliseconds;
                stages.Add("esc-sent");
                long escDeadline = Math.Min(interruptSentMs + 10000, totalTimeoutMs - 30000);
                long lastSpinnerMs = interruptSentMs, prevOffset = escOffset, lb = CapturedBytes(), lcMs = interruptSentMs;
                bool stopped = false;
                while (clock.ElapsedMilliseconds < escDeadline) {
                    Thread.Sleep(250);
                    if (WaitForSingleObject(pi.hProcess, 0) == 0) { stages.Add("child-exited-after-esc"); break; }
                    AddUnique(stateMarkers, StateMarkers(Normalize(CapturedText())));
                    if (AnyFatal(stateMarkers)) { uiReady = false; abortReason = "fatal-screen-state-after-esc"; stages.Add("fatal-state-seen"); break; }
                    long now = clock.ElapsedMilliseconds, nb = CapturedBytes();
                    if (nb != lb) { lb = nb; lcMs = now; }
                    string after = Normalize(CapturedTextFrom(escOffset));
                    if (Has(after, "interrupted")) AddUnique(interruptEvidence, new string[] { "interrupted-text" });
                    if (Has(after, "whatshouldclaudedoinstead")) AddUnique(interruptEvidence, new string[] { "what-should-claude-do-instead" });
                    if (SpinnerActive.IsMatch(Normalize(CapturedTextFrom(prevOffset)))) lastSpinnerMs = now;
                    prevOffset = nb;
                    bool spinnerGone = now - lastSpinnerMs >= 1500;
                    bool quiet = now - lcMs >= 1500;
                    if (interruptEvidence.Contains("interrupted-text") || interruptEvidence.Contains("what-should-claude-do-instead")) { stopped = true; break; }
                    if (spinnerGone && quiet && now - interruptSentMs >= 2000) {
                        AddUnique(interruptEvidence, new string[] { "spinner-gone-1.5s", "output-quiet-1.5s" }); stopped = true; break;
                    }
                }
                stages.Add(stopped ? "interrupt-evidence-seen" : "interrupt-evidence-timeout");
                if (!stopped) interruptEvidence.Add("no-stop-evidence-within-bound");
                // Keep the next input clearly separate from the ESC key; this window also feeds typedWhileBusy.
                if (uiReady) preTypeRecent = RecentText(700);
            }

            // ---- Phase 2: type message, pause, CR as a separate write (skipped for an empty interrupt-only message).
            if (uiReady && message.Length > 0 && WaitForSingleObject(pi.hProcess, 0) != 0) {
                busyAtType = BusyMarkers(Normalize(preTypeRecent));
                typedWhileBusy = busyAtType.Count > 0;
              if (gateFile != null && ReadGate(gateFile) == "abort") {
                gateResult = "abort"; gateWaitMs = 0;
                abortReason = "gate-abort";
                stages.Add("gate-abort-before-type");
              } else {
                long beforeTypeOffset = CapturedBytes();
                if (message.IndexOf('\n') >= 0) {
                    typedMode = "bracketed-paste";
                    Send(ESC + "[200~" + message + ESC + "[201~");
                } else {
                    typedMode = "plain";
                    Send(message);
                }
                typed = true; typedChars = message.Length;
                stages.Add("message-typed");
                Thread.Sleep(Math.Min(4000, 1200 + message.Length / 4));
                if (gateFile != null) {
                    Console.WriteLine("TYPED");
                    Console.Out.Flush();
                    stages.Add("gate-wait");
                    long gateStart = clock.ElapsedMilliseconds;
                    while (true) {
                        string g = ReadGate(gateFile);
                        if (g != null) { gateResult = g; break; }
                        if (clock.ElapsedMilliseconds - gateStart >= GATE_TIMEOUT_MS) { gateResult = "timeout"; break; }
                        Thread.Sleep(GATE_POLL_MS);
                    }
                    gateWaitMs = clock.ElapsedMilliseconds - gateStart;
                    stages.Add("gate-" + gateResult);
                    if (gateResult != "go") {
                        // Erase what was typed; it is never submitted.
                        int remaining = message.Length;
                        while (remaining > 0) {
                            int n = Math.Min(32, remaining);
                            Send(new string((char)0x7F, n));
                            remaining -= n;
                            Thread.Sleep(15);
                        }
                        inputCleared = true; clearMethod = "backspace(0x7F)x" + message.Length;
                        stages.Add("input-cleared");
                        Thread.Sleep(400);
                        abortReason = "gate-" + gateResult;
                    }
                }
              if (gateResult == null || gateResult == "go") {
                long preCrOffset = CapturedBytes();
                Send("\r");
                crSent = true; crSentMs = clock.ElapsedMilliseconds;
                stages.Add("cr-sent");

                // ---- Phase 3: look for evidence the turn started in output produced after CR.
                string probeNeedle = Normalize(message);
                if (probeNeedle.Length > 24) probeNeedle = probeNeedle.Substring(0, 24);
                long evidenceDeadline = Math.Min(clock.ElapsedMilliseconds + 25000, totalTimeoutMs - 12000);
                while (clock.ElapsedMilliseconds < evidenceDeadline) {
                    if (WaitForSingleObject(pi.hProcess, 0) == 0) { stages.Add("child-exited-after-cr"); break; }
                    string after = Normalize(CapturedTextFrom(preCrOffset));
                    if (Has(after, "esctointerrupt")) AddUnique(turnEvidence, new string[] { "esc-to-interrupt" });
                    if (Has(after, "thinking")) AddUnique(turnEvidence, new string[] { "thinking" });
                    foreach (char sp in new char[] { (char)0x273B, (char)0x2736, (char)0x2733, (char)0x2722, (char)0x273D })
                        if (after.IndexOf(sp) >= 0) { AddUnique(turnEvidence, new string[] { "spinner-glyph" }); break; }
                    if (after.IndexOf((char)0x23FA) >= 0) AddUnique(turnEvidence, new string[] { "tool-or-response-bullet" });
                    if (probeNeedle.Length > 0 && Has(after, probeNeedle)) AddUnique(turnEvidence, new string[] { "message-echo-after-cr" });
                    if (Has(after, "queued") || Has(after, "willbesent")) AddUnique(turnEvidence, new string[] { "queued" });
                    if (Has(after, "interrupted")) AddUnique(turnEvidence, new string[] { "interrupted-text-after-cr" });
                    bool strong = turnEvidence.Contains("esc-to-interrupt") || turnEvidence.Contains("spinner-glyph") || turnEvidence.Contains("thinking") || turnEvidence.Contains("tool-or-response-bullet") || turnEvidence.Contains("queued");
                    if (strong && turnEvidence.Count >= 2) break;
                    Thread.Sleep(250);
                }
                stages.Add(turnEvidence.Count > 0 ? "turn-evidence-seen" : "turn-evidence-missing");
                Thread.Sleep(1000);
              }
              }
            }

            // ---- Phase 4: detach via Ctrl+Z (client-side). Never /exit.
            if (WaitForSingleObject(pi.hProcess, 0) != 0) {
                detachMethod = "ctrl-z(0x1A)";
                Send(((char)0x1A).ToString());
                stages.Add("ctrl-z-sent");
                int waitMs = (int)Math.Max(2000, Math.Min(10000, totalTimeoutMs - clock.ElapsedMilliseconds - 4000));
                if (WaitForSingleObject(pi.hProcess, waitMs) == 0) { detachedCleanly = true; stages.Add("client-exited-after-ctrl-z"); }
                else {
                    detachMethod += ";fallback ctrl-b,d";
                    Send(((char)0x02).ToString()); Thread.Sleep(300); Send("d");
                    stages.Add("ctrl-b-d-sent");
                    if (WaitForSingleObject(pi.hProcess, 3000) == 0) { detachedCleanly = true; stages.Add("client-exited-after-ctrl-b-d"); }
                    else {
                        // Last resort: terminate ONLY the attach client process (not a job object, not the daemon).
                        TerminateProcess(pi.hProcess, 0); WaitForSingleObject(pi.hProcess, 5000);
                        clientTerminated = true; detachMethod += ";terminated-attach-client";
                        stages.Add("attach-client-terminated");
                    }
                }
            } else {
                detachMethod = "none-needed(client-already-exited)";
                stages.Add("client-already-exited");
            }
            Thread.Sleep(500);
            GetExitCodeProcess(pi.hProcess, out exitCode);
        } catch (Exception ex) {
            abortReason = (abortReason == null ? "" : abortReason + ";") + "exception:" + ex.Message;
            stages.Add("exception");
            try {
                if (pi.hProcess != IntPtr.Zero && WaitForSingleObject(pi.hProcess, 0) != 0) {
                    try { Send(((char)0x1A).ToString()); detachMethod = "ctrl-z(0x1A)-after-exception"; } catch {}
                    if (WaitForSingleObject(pi.hProcess, 5000) != 0) { TerminateProcess(pi.hProcess, 0); clientTerminated = true; }
                }
                if (pi.hProcess != IntPtr.Zero) GetExitCodeProcess(pi.hProcess, out exitCode);
            } catch {}
        }

        // Close the pseudoconsole to flush remaining output before saving.
        byte[] rawBytes = null;
        try {
            if (hpc != IntPtr.Zero) { ClosePseudoConsole(hpc); hpc = IntPtr.Zero; }
            if (reader != null) reader.Join(3000);
            rawBytes = CapturedBytesArr();
            File.WriteAllBytes(rawPath, rawBytes);
        } catch (Exception ex) {
            abortReason = (abortReason == null ? "" : abortReason + ";") + "save-failed:" + ex.Message;
            if (rawBytes == null) rawBytes = CapturedBytesArr();
        }
        string rawText = Encoding.UTF8.GetString(rawBytes);
        AddUnique(stateMarkers, StateMarkers(Normalize(rawText)));

        Console.WriteLine("{"
            + "\"transport\":\"windows-conpty\""
            + ",\"command\":\"attach\""
            + ",\"mode\":\"" + mode + "\""
            + ",\"interruptSent\":" + (interruptSent ? "true" : "false")
            + ",\"interruptSentMs\":" + interruptSentMs
            + ",\"interruptEvidence\":" + JsonList(interruptEvidence)
            + ",\"typedWhileBusy\":" + (typedWhileBusy ? "true" : "false")
            + ",\"busyMarkersAtType\":" + JsonList(busyAtType)
            + ",\"shortId\":\"" + JsonEscape(shortId) + "\""
            + ",\"messageFile\":\"" + JsonEscape(messageFile) + "\""
            + ",\"childStarted\":" + (childStarted ? "true" : "false")
            + ",\"childPid\":" + pi.dwProcessId
            + ",\"uiReady\":" + (uiReady ? "true" : "false")
            + ",\"uiReadyMs\":" + uiReadyMs
            + ",\"readyMarkers\":" + JsonList(readyMarkers)
            + ",\"stateMarkers\":" + JsonList(stateMarkers)
            + ",\"typed\":" + (typed ? "true" : "false")
            + ",\"typedMode\":" + (typedMode == null ? "null" : "\"" + typedMode + "\"")
            + ",\"typedChars\":" + typedChars
            + ",\"crSent\":" + (crSent ? "true" : "false")
            + ",\"crSentMs\":" + crSentMs
            + ",\"gateFile\":" + (gateFile == null ? "null" : "\"" + JsonEscape(gateFile) + "\"")
            + ",\"gateResult\":" + (gateResult == null ? "null" : "\"" + gateResult + "\"")
            + ",\"gateWaitMs\":" + gateWaitMs
            + ",\"inputCleared\":" + (inputCleared ? "true" : "false")
            + ",\"clearMethod\":" + (clearMethod == null ? "null" : "\"" + JsonEscape(clearMethod) + "\"")
            + ",\"turnStartedEvidence\":" + JsonList(turnEvidence)
            + ",\"detachMethod\":" + (detachMethod == null ? "null" : "\"" + JsonEscape(detachMethod) + "\"")
            + ",\"detachedCleanly\":" + (detachedCleanly ? "true" : "false")
            + ",\"attachClientTerminated\":" + (clientTerminated ? "true" : "false")
            + ",\"abortReason\":" + (abortReason == null ? "null" : "\"" + JsonEscape(abortReason) + "\"")
            + ",\"exitCode\":" + exitCode
            + ",\"elapsedMs\":" + clock.ElapsedMilliseconds
            + ",\"outputBytesCaptured\":" + rawBytes.Length
            + ",\"rawOutputPath\":\"" + JsonEscape(rawPath) + "\""
            + ",\"readerError\":" + (readerFailure == null ? "null" : "\"" + JsonEscape(readerFailure.Message) + "\"")
            + ",\"stages\":" + JsonList(stages)
            + ",\"envVarsDroppedCount\":" + droppedVars.Count
            + ",\"outputExcerpt\":\"" + JsonEscape(Excerpt(rawText, 1500, 3000)) + "\""
            + "}");

        if (pi.hThread != IntPtr.Zero) CloseHandle(pi.hThread);
        if (pi.hProcess != IntPtr.Zero) CloseHandle(pi.hProcess);
        if (attributeList != IntPtr.Zero) { DeleteProcThreadAttributeList(attributeList); Marshal.FreeHGlobal(attributeList); }
        if (envBlock != IntPtr.Zero) Marshal.FreeHGlobal(envBlock);
        if (hpc != IntPtr.Zero) ClosePseudoConsole(hpc);
        if (inputRead != IntPtr.Zero) CloseHandle(inputRead);
        if (inputWrite != IntPtr.Zero) CloseHandle(inputWrite);
        if (outputWrite != IntPtr.Zero) CloseHandle(outputWrite);
        // Only close the read end if the reader thread is done; closing under a pending synchronous ReadFile blocks.
        if (outputRead != IntPtr.Zero && (reader == null || !reader.IsAlive)) CloseHandle(outputRead);
        bool succeeded = childStarted
            && abortReason == null
            && !AnyFatal(stateMarkers)
            && (mode == "interrupt" || (typed && crSent));
        int rc = succeeded ? 0 : 5;
        Console.Out.Flush();
        Environment.Exit(rc);
        return rc;
    }
}
