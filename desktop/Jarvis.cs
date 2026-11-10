using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Net;
using System.Net.Sockets;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Web.Script.Serialization;
using System.Windows.Forms;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

namespace JarvisApp
{
    internal sealed class Config
    {
        public string OpenCodeUrl = "http://127.0.0.1:4096";
        public string OpenCodeBin = "";
        public bool AutoStart = true;
        public bool DevTools = false;
        public int Port = 8737;

        public static Config Load(string root)
        {
            var cfg = new Config();

            string envUrl = Environment.GetEnvironmentVariable("OPENCODE_URL");
            if (!string.IsNullOrEmpty(envUrl)) cfg.OpenCodeUrl = envUrl;

            string envBin = Environment.GetEnvironmentVariable("OPENCODE_BIN");
            if (!string.IsNullOrEmpty(envBin)) cfg.OpenCodeBin = envBin;

            string path = Path.Combine(root, "jarvis.config.json");
            if (File.Exists(path))
            {
                try
                {
                    var json = new JavaScriptSerializer();
                    var data = json.Deserialize<Dictionary<string, object>>(File.ReadAllText(path, Encoding.UTF8));
                    if (data != null)
                    {
                        if (data.ContainsKey("opencodeUrl") && data["opencodeUrl"] != null)
                            cfg.OpenCodeUrl = Convert.ToString(data["opencodeUrl"]);
                        if (data.ContainsKey("opencodeBin") && data["opencodeBin"] != null)
                            cfg.OpenCodeBin = Convert.ToString(data["opencodeBin"]);
                        if (data.ContainsKey("autoStartServer") && data["autoStartServer"] != null)
                            cfg.AutoStart = Convert.ToBoolean(data["autoStartServer"]);
                        if (data.ContainsKey("devTools") && data["devTools"] != null)
                            cfg.DevTools = Convert.ToBoolean(data["devTools"]);
                        if (data.ContainsKey("port") && data["port"] != null)
                            cfg.Port = Convert.ToInt32(data["port"]);
                    }
                }
                catch { }
            }
            return cfg;
        }
    }

    /* Запускает локальный сервер OpenCode вместе с приложением.
       Если сервер уже работает (например, из OpenCode Desktop),
       ничего не делает. Останавливает только тот процесс,
       который запустил сам. */
    internal static class OpenCodeServer
    {
        private static Process process;
        private static bool started;
        private static string password;
        private static string logPath;
        private static IntPtr job;
        private static readonly object logSync = new object();

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode)]
        private static extern IntPtr CreateJobObject(IntPtr attributes, string name);

        [DllImport("kernel32.dll")]
        private static extern bool SetInformationJobObject(
            IntPtr jobHandle, int infoClass, IntPtr info, uint infoLength);

        [DllImport("kernel32.dll")]
        private static extern bool AssignProcessToJobObject(IntPtr jobHandle, IntPtr processHandle);

        [StructLayout(LayoutKind.Sequential)]
        private struct BasicLimitInformation
        {
            public long PerProcessUserTimeLimit;
            public long PerJobUserTimeLimit;
            public uint LimitFlags;
            public UIntPtr MinimumWorkingSetSize;
            public UIntPtr MaximumWorkingSetSize;
            public uint ActiveProcessLimit;
            public UIntPtr Affinity;
            public uint PriorityClass;
            public uint SchedulingClass;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct IoCounters
        {
            public ulong ReadOperationCount;
            public ulong WriteOperationCount;
            public ulong OtherOperationCount;
            public ulong ReadTransferCount;
            public ulong WriteTransferCount;
            public ulong OtherTransferCount;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct ExtendedLimitInformation
        {
            public BasicLimitInformation BasicLimitInformation;
            public IoCounters IoInfo;
            public UIntPtr ProcessMemoryLimit;
            public UIntPtr JobMemoryLimit;
            public UIntPtr PeakProcessMemoryUsed;
            public UIntPtr PeakJobMemoryUsed;
        }

        /* Пароль созданного нами сервера. Наружу не показывается:
           приложение подставляет его в прокси автоматически. */
        public static string Password { get { return password; } }

        public static void ClearPassword()
        {
            password = null;
        }

        public static void EnsureRunning(Config cfg)
        {
            if (!cfg.AutoStart) return;
            if (!IsLocal(cfg.OpenCodeUrl)) return;

            int status = Probe(cfg.OpenCodeUrl, null, 1500);
            if (status == 200) return; /* уже работает без пароля */

            if (status == 401)
            {
                /* Чужой сервер с паролем — поднимаем свой на свободном порту. */
                int free = FreePort();
                cfg.OpenCodeUrl = "http://127.0.0.1:" + free;
                StartOwn(cfg, free);
                return;
            }

            int port = PortOf(cfg.OpenCodeUrl);
            if (!PortFree(port))
            {
                port = FreePort();
                cfg.OpenCodeUrl = "http://127.0.0.1:" + port;
            }

            StartOwn(cfg, port);
        }

        private static void StartOwn(Config cfg, int port)
        {
            string bin = FindBinary(cfg.OpenCodeBin);
            if (bin == null) return;

            password = NewPassword();
            if (!Start(bin, port, password))
            {
                password = null;
                return;
            }
            if (WaitReady(cfg.OpenCodeUrl, password, 25000)) return;

            /* Первый порт не подошёл — пробуем ещё один. */
            try { if (process != null && !process.HasExited) process.Kill(); }
            catch { }
            try { if (process != null) process.Dispose(); }
            catch { }
            process = null;

            int alt = FreePort();
            password = NewPassword();
            if (Start(bin, alt, password) &&
                WaitReady("http://127.0.0.1:" + alt, password, 25000))
            {
                cfg.OpenCodeUrl = "http://127.0.0.1:" + alt;
                return;
            }

            password = null;
        }

        public static void Stop()
        {
            if (!started) return;
            try { if (process != null && !process.HasExited) process.Kill(); }
            catch { }
            try { if (process != null) process.Dispose(); }
            catch { }
            process = null;
            started = false;
            password = null;
        }

        private static bool Start(string bin, int port, string pass)
        {
            try
            {
                var psi = new ProcessStartInfo();
                string args = "serve --port " + port + " --hostname 127.0.0.1";
                bool wrapper = EndsWith(bin, ".cmd") || EndsWith(bin, ".bat");

                if (wrapper)
                {
                    psi.FileName = "cmd.exe";
                    psi.Arguments = "/c \"" + bin + "\" " + args;
                }
                else
                {
                    psi.FileName = bin;
                    psi.Arguments = args;
                }

                psi.UseShellExecute = false;
                psi.CreateNoWindow = true;
                psi.WorkingDirectory = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
                psi.RedirectStandardOutput = true;
                psi.RedirectStandardError = true;
                psi.StandardOutputEncoding = Encoding.UTF8;
                psi.StandardErrorEncoding = Encoding.UTF8;
                psi.EnvironmentVariables["OPENCODE_PASSWORD"] = pass;

                var p = new Process();
                p.StartInfo = psi;
                p.OutputDataReceived += delegate(object s, DataReceivedEventArgs e) { Log("OUT " + e.Data); };
                p.ErrorDataReceived += delegate(object s, DataReceivedEventArgs e) { Log("ERR " + e.Data); };
                if (!p.Start()) return false;
                p.BeginOutputReadLine();
                p.BeginErrorReadLine();

                process = p;
                started = true;

                /* Сервер завершится вместе с Jarvis.exe, даже если тот упадёт. */
                EnsureJob();
                if (job != IntPtr.Zero)
                {
                    try { AssignProcessToJobObject(job, p.Handle); }
                    catch { }
                }

                return true;
            }
            catch { return false; }
        }

        private static void EnsureJob()
        {
            if (job != IntPtr.Zero) return;
            try
            {
                job = CreateJobObject(IntPtr.Zero, null);
                if (job == IntPtr.Zero) return;

                var info = new ExtendedLimitInformation();
                info.BasicLimitInformation.LimitFlags = 0x2000; /* KILL_ON_JOB_CLOSE */
                int size = Marshal.SizeOf(typeof(ExtendedLimitInformation));
                IntPtr ptr = Marshal.AllocHGlobal(size);
                try
                {
                    Marshal.StructureToPtr(info, ptr, false);
                    SetInformationJobObject(job, 9, ptr, (uint)size);
                }
                finally { Marshal.FreeHGlobal(ptr); }
            }
            catch { }
        }

        private static bool WaitReady(string url, string pass, int timeoutMs)
        {
            int waited = 0;
            while (waited < timeoutMs)
            {
                if (Probe(url, pass, 1200) == 200) return true;
                if (process != null && process.HasExited) return false;
                Thread.Sleep(400);
                waited += 400;
            }
            return Probe(url, pass, 1200) == 200;
        }

        /* Возвращает HTTP-код /api/info: 200 — сервер готов,
           401 — требует пароль, 0 — недоступен. */
        private static int Probe(string url, string pass, int timeoutMs)
        {
            try
            {
                var req = (HttpWebRequest)WebRequest.Create(url.TrimEnd('/') + "/api/info");
                req.Method = "GET";
                req.Proxy = null;
                req.KeepAlive = false;
                req.Timeout = timeoutMs;
                req.ReadWriteTimeout = timeoutMs;
                if (!string.IsNullOrEmpty(pass))
                {
                    string token = Convert.ToBase64String(
                        Encoding.UTF8.GetBytes("opencode:" + pass));
                    req.Headers["Authorization"] = "Basic " + token;
                }
                using (var resp = (HttpWebResponse)req.GetResponse())
                    return (int)resp.StatusCode;
            }
            catch (WebException ex)
            {
                var resp = ex.Response as HttpWebResponse;
                return resp != null ? (int)resp.StatusCode : 0;
            }
            catch { return 0; }
        }

        private static string NewPassword()
        {
            var bytes = new byte[32];
            using (var rng = RandomNumberGenerator.Create()) { rng.GetBytes(bytes); }
            return Convert.ToBase64String(bytes)
                .Replace('+', '-')
                .Replace('/', '_')
                .TrimEnd('=');
        }

        private static bool IsLocal(string url)
        {
            try
            {
                string host = new Uri(url).Host.ToLowerInvariant();
                return host == "127.0.0.1" || host == "localhost" || host == "::1";
            }
            catch { return false; }
        }

        private static int PortOf(string url)
        {
            try
            {
                var uri = new Uri(url);
                if (uri.Port > 0) return uri.Port;
                return uri.Scheme == "https" ? 443 : 80;
            }
            catch { return 4096; }
        }

        private static bool PortFree(int port)
        {
            try
            {
                var probe = new TcpListener(IPAddress.Loopback, port);
                probe.Start();
                probe.Stop();
                return true;
            }
            catch { return false; }
        }

        private static int FreePort()
        {
            var probe = new TcpListener(IPAddress.Loopback, 0);
            probe.Start();
            int p = ((IPEndPoint)probe.LocalEndpoint).Port;
            probe.Stop();
            return p;
        }

        private static string FindBinary(string hint)
        {
            if (!string.IsNullOrEmpty(hint) && File.Exists(hint)) return hint;

            string env = Environment.GetEnvironmentVariable("JARVIS_OPENCODE_BIN");
            if (!string.IsNullOrEmpty(env) && File.Exists(env)) return env;

            string[] names = { "opencode.exe", "opencode-cli.exe", "opencode.cmd", "opencode.bat" };
            string path = Environment.GetEnvironmentVariable("PATH") ?? "";
            string[] dirs = path.Split(';');
            foreach (string dir in dirs)
            {
                string d = dir.Trim().Trim('"');
                if (d.Length == 0) continue;
                foreach (string name in names)
                {
                    try
                    {
                        string full = Path.Combine(d, name);
                        if (File.Exists(full)) return full;
                    }
                    catch { }
                }
            }

            /* OpenCode Desktop: %APPDATA%\ai.opencode.desktop\cli\<версия>\opencode-cli.exe */
            try
            {
                string cli = Path.Combine(
                    Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData),
                    "ai.opencode.desktop", "cli");
                if (Directory.Exists(cli))
                {
                    string[] versions = Directory.GetDirectories(cli);
                    Array.Sort(versions, delegate(string a, string b)
                    {
                        return Directory.GetLastWriteTimeUtc(b)
                            .CompareTo(Directory.GetLastWriteTimeUtc(a));
                    });
                    foreach (string v in versions)
                    {
                        string exe = Path.Combine(v, "opencode-cli.exe");
                        if (File.Exists(exe)) return exe;
                    }
                }
            }
            catch { }

            string appData = Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData);
            string local = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
            string home = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);

            string[] extra = {
                Path.Combine(appData, "npm", "opencode.cmd"),
                Path.Combine(home, ".opencode", "bin", "opencode.exe"),
                Path.Combine(local, "opencode", "bin", "opencode.exe"),
                Path.Combine(local, "Programs", "opencode", "opencode.exe"),
            };
            foreach (string candidate in extra)
            {
                try { if (File.Exists(candidate)) return candidate; }
                catch { }
            }

            return null;
        }

        private static bool EndsWith(string value, string suffix)
        {
            return value.EndsWith(suffix, StringComparison.OrdinalIgnoreCase);
        }

        private static void Log(string message)
        {
            if (string.IsNullOrEmpty(message)) return;
            try
            {
                if (logPath == null)
                {
                    string dir = Path.Combine(
                        Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                        "Jarvis");
                    Directory.CreateDirectory(dir);
                    logPath = Path.Combine(dir, "opencode-server.log");
                }

                lock (logSync)
                {
                    var info = new FileInfo(logPath);
                    if (info.Exists && info.Length > 262144) File.Delete(logPath);
                    File.AppendAllText(logPath,
                        DateTime.Now.ToString("HH:mm:ss.fff") + " " + message + "\n");
                }
            }
            catch { }
        }
    }

    internal static class Program
    {
        [DllImport("dwmapi.dll")]
        private static extern int DwmSetWindowAttribute(IntPtr hwnd, int attr, ref int value, int size);

        public static string RootDir;
        public static string UiDir;
        public static Config Cfg;
        public static int Port;
        public static string BaseUrl;
        public static TtsService Tts;
        public static HttpServer Server;

        [STAThread]
        private static void Main(string[] args)
        {
            bool created;
            using (var mutex = new Mutex(true, "JarvisDesktopSingleton_v1", out created))
            {
                if (!created)
                {
                    MessageBox.Show("J.A.R.V.I.S. уже запущен.", "J.A.R.V.I.S.",
                        MessageBoxButtons.OK, MessageBoxIcon.Information);
                    return;
                }

                Application.EnableVisualStyles();
                Application.SetCompatibleTextRenderingDefault(false);

                RootDir = Path.GetDirectoryName(Application.ExecutablePath);
                UiDir = Path.Combine(RootDir, "ui");
                Cfg = Config.Load(RootDir);
                Tts = new TtsService(RootDir);
                Tts.Warmup();
                EnsureAgent();

                /* Сервер OpenCode поднимается автоматически вместе с приложением. */
                try { OpenCodeServer.EnsureRunning(Cfg); }
                catch { }

                if (!Directory.Exists(UiDir))
                {
                    MessageBox.Show("Не найдена папка ui рядом с Jarvis.exe.", "J.A.R.V.I.S.",
                        MessageBoxButtons.OK, MessageBoxIcon.Error);
                    return;
                }

                Server = new HttpServer(UiDir, Cfg, Tts);
                try
                {
                    Port = Server.Start();
                }
                catch (Exception ex)
                {
                    MessageBox.Show("Не удалось запустить локальный сервер:\n" + ex.Message,
                        "J.A.R.V.I.S.", MessageBoxButtons.OK, MessageBoxIcon.Error);
                    return;
                }

                BaseUrl = "http://127.0.0.1:" + Port + "/";

                try
                {
                    string infoDir = Path.Combine(
                        Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                        "Jarvis");
                    Directory.CreateDirectory(infoDir);
                    File.WriteAllText(Path.Combine(infoDir, "last-url.txt"), BaseUrl);
                }
                catch { }

                Application.ThreadException += delegate(object sender, ThreadExceptionEventArgs e)
                {
                    MessageBox.Show(e.Exception.Message, "J.A.R.V.I.S.",
                        MessageBoxButtons.OK, MessageBoxIcon.Error);
                };

                Application.Run(new MainForm());

                try { Server.Stop(); } catch { }
                try { Tts.Dispose(); } catch { }
                try { OpenCodeServer.Stop(); } catch { }
            }
        }

        public static void EnsureAgent()
        {
            try
            {
                string source = Path.Combine(RootDir, "agents", "jarvis.md");
                if (!File.Exists(source)) return;

                string home = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
                string dir = Path.Combine(home, ".config", "opencode", "agents");
                string target = Path.Combine(dir, "jarvis.md");
                if (File.Exists(target)) return;

                Directory.CreateDirectory(dir);
                File.Copy(source, target);
            }
            catch { }
        }

        public static void ApplyDarkTitleBar(IntPtr handle)
        {
            try
            {
                int value = 1;
                DwmSetWindowAttribute(handle, 20, ref value, sizeof(int));
            }
            catch { }
            try
            {
                int value = 1;
                DwmSetWindowAttribute(handle, 19, ref value, sizeof(int));
            }
            catch { }
        }
    }

    internal sealed class MainForm : Form
    {
        private readonly WebView2 web;
        private NotifyIcon tray;

        public MainForm()
        {
            Text = "J.A.R.V.I.S.";
            ClientSize = new Size(1180, 820);
            MinimumSize = new Size(860, 620);
            StartPosition = FormStartPosition.CenterScreen;
            BackColor = Color.FromArgb(3, 6, 11);
            try { Icon = Icon.ExtractAssociatedIcon(Application.ExecutablePath); } catch { }

            web = new WebView2();
            web.Dock = DockStyle.Fill;
            try { web.DefaultBackgroundColor = Color.FromArgb(3, 6, 11); } catch { }
            Controls.Add(web);

            Load += OnLoad;
            FormClosing += OnClosing;
            Resize += OnResize;
        }

        private async void OnLoad(object sender, EventArgs e)
        {
            Program.ApplyDarkTitleBar(Handle);

            try
            {
                string dataDir = Path.Combine(
                    Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                    "Jarvis", "WebView2");
                Directory.CreateDirectory(dataDir);
                var environment = await CoreWebView2Environment.CreateAsync(null, dataDir, null);
                await web.EnsureCoreWebView2Async(environment);
            }
            catch (Exception ex)
            {
                MessageBox.Show(
                    "Не удалось запустить WebView2. Установите компонент «Microsoft Edge WebView2 Runtime».\n\n" + ex.Message,
                    "J.A.R.V.I.S.", MessageBoxButtons.OK, MessageBoxIcon.Error);
                Close();
                return;
            }

            var core = web.CoreWebView2;
            core.Settings.AreDefaultContextMenusEnabled = false;
            core.Settings.AreDevToolsEnabled = Program.Cfg.DevTools;
            core.Settings.IsStatusBarEnabled = false;
            core.Settings.IsZoomControlEnabled = false;
            core.Settings.AreBrowserAcceleratorKeysEnabled = true;

            core.PermissionRequested += delegate(object s, CoreWebView2PermissionRequestedEventArgs a)
            {
                if (a.PermissionKind == CoreWebView2PermissionKind.Microphone)
                    a.State = CoreWebView2PermissionState.Allow;
            };

            core.NewWindowRequested += delegate(object s, CoreWebView2NewWindowRequestedEventArgs a)
            {
                a.Handled = true;
                try { Process.Start(a.Uri); } catch { }
            };

            core.NavigationCompleted += async delegate(object s, CoreWebView2NavigationCompletedEventArgs a)
            {
                if (!a.IsSuccess) return;
                try
                {
                    string json = await core.ExecuteScriptAsync(
                        "JSON.stringify({title:document.title,sr:typeof window.webkitSpeechRecognition," +
                        "sr2:typeof window.SpeechRecognition,tts:typeof window.speechSynthesis," +
                        "voice:!!window.Voice,neural:window.Voice&&window.Voice.neural," +
                        "engine:window.Voice&&window.Voice.engine})");
                    string dir = Path.Combine(
                        Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                        "Jarvis");
                    Directory.CreateDirectory(dir);
                    File.WriteAllText(Path.Combine(dir, "diag.json"), json);
                }
                catch { }
            };

            web.Source = new Uri(Program.BaseUrl);
            CreateTray();
        }

        private void CreateTray()
        {
            try
            {
                tray = new NotifyIcon();
                tray.Text = "J.A.R.V.I.S.";
                tray.Icon = Icon;
                tray.Visible = true;

                var menu = new ContextMenuStrip();
                menu.Items.Add("Открыть", null, delegate { ShowFromTray(); });
                menu.Items.Add(new ToolStripSeparator());
                menu.Items.Add("Выход", null, delegate { Close(); });
                tray.ContextMenuStrip = menu;
                tray.DoubleClick += delegate { ShowFromTray(); };
            }
            catch { }
        }

        private void ShowFromTray()
        {
            Show();
            WindowState = FormWindowState.Normal;
            Activate();
        }

        private void OnResize(object sender, EventArgs e)
        {
            if (WindowState == FormWindowState.Minimized && tray != null)
            {
                Hide();
            }
        }

        private void OnClosing(object sender, FormClosingEventArgs e)
        {
            if (tray != null)
            {
                tray.Visible = false;
                tray.Dispose();
                tray = null;
            }
        }
    }

    internal sealed class HttpServer
    {
        private readonly string uiDir;
        private readonly Config cfg;
        private readonly TtsService tts;
        private HttpListener listener;
        private Thread thread;
        private volatile bool running;
        private int port;

        public HttpServer(string uiDir, Config cfg, TtsService tts)
        {
            this.uiDir = Path.GetFullPath(uiDir);
            this.cfg = cfg;
            this.tts = tts;
        }

        public int Start()
        {
            Exception last = null;

            if (cfg.Port > 0)
            {
                var preferred = new HttpListener();
                preferred.Prefixes.Add("http://127.0.0.1:" + cfg.Port + "/");
                try
                {
                    preferred.Start();
                    listener = preferred;
                    port = cfg.Port;
                }
                catch (Exception ex)
                {
                    last = ex;
                    try { preferred.Close(); } catch { }
                }
            }

            for (int attempt = 0; listener == null && attempt < 20; attempt++)
            {
                int candidate = FreePort();
                var l = new HttpListener();
                l.Prefixes.Add("http://127.0.0.1:" + candidate + "/");
                try
                {
                    l.Start();
                    listener = l;
                    port = candidate;
                    break;
                }
                catch (Exception ex)
                {
                    last = ex;
                    try { l.Close(); } catch { }
                }
            }

            if (listener == null)
                throw new InvalidOperationException(last != null ? last.Message : "нет свободного порта");

            running = true;
            thread = new Thread(Loop);
            thread.IsBackground = true;
            thread.Start();
            return port;
        }

        public void Stop()
        {
            running = false;
            try { if (listener != null) listener.Stop(); } catch { }
            try { if (listener != null) listener.Close(); } catch { }
        }

        private static int FreePort()
        {
            var probe = new TcpListener(IPAddress.Loopback, 0);
            probe.Start();
            int p = ((IPEndPoint)probe.LocalEndpoint).Port;
            probe.Stop();
            return p;
        }

        private void Loop()
        {
            while (running)
            {
                HttpListenerContext context = null;
                try { context = listener.GetContext(); }
                catch { if (!running) break; continue; }

                ThreadPool.QueueUserWorkItem(delegate(object state)
                {
                    Handle((HttpListenerContext)state);
                }, context);
            }
        }

        private void Handle(HttpListenerContext ctx)
        {
            try
            {
                string path = ctx.Request.Url.AbsolutePath;

                if (path == "/app/info")
                {
                    var info = new Dictionary<string, object>();
                    info["desktop"] = true;
                    info["tts"] = tts.Available;
                    info["version"] = "1.0";
                    info["opencode"] = cfg.OpenCodeUrl;
                    Json(ctx, 200, info);
                    return;
                }

                if (path == "/app/config")
                {
                    if (ctx.Request.HttpMethod != "POST") { Json(ctx, 405, ErrorBody("Метод не поддерживается")); return; }
                    var data = ReadJson(ctx);
                    if (data != null)
                    {
                        if (data.ContainsKey("opencodeUrl") && data["opencodeUrl"] != null)
                        {
                            string url = Convert.ToString(data["opencodeUrl"]).Trim();
                            if (url.Length > 0)
                            {
                                string next = url.TrimEnd('/');
                                if (!string.Equals(next, cfg.OpenCodeUrl.TrimEnd('/'),
                                    StringComparison.OrdinalIgnoreCase))
                                {
                                    cfg.OpenCodeUrl = next;
                                    OpenCodeServer.ClearPassword();
                                }
                            }
                        }
                    }
                    Json(ctx, 200, new Dictionary<string, object> { { "ok", true } });
                    return;
                }

                if (path == "/tts")
                {
                    HandleTts(ctx);
                    return;
                }

                if (path == "/oc" || path.StartsWith("/oc/"))
                {
                    Proxy(ctx);
                    return;
                }

                Static(ctx);
            }
            catch (Exception ex)
            {
                try { Json(ctx, 500, ErrorBody(ex.Message)); } catch { }
            }
        }

        private void HandleTts(HttpListenerContext ctx)
        {
            if (ctx.Request.HttpMethod == "GET")
            {
                var result = new Dictionary<string, object>();
                result["available"] = tts.Available;
                result["voices"] = TtsService.VoiceList;
                Json(ctx, 200, result);
                return;
            }

            if (ctx.Request.HttpMethod != "POST")
            {
                Json(ctx, 405, ErrorBody("Метод не поддерживается"));
                return;
            }

            var data = ReadJson(ctx);
            string text = data != null && data.ContainsKey("text") ? Convert.ToString(data["text"]) : null;
            string voice = data != null && data.ContainsKey("voice") ? Convert.ToString(data["voice"]) : "auto";

            if (string.IsNullOrEmpty(text) || text.Trim().Length == 0)
            {
                Json(ctx, 400, ErrorBody("Пустой текст"));
                return;
            }

            byte[] audio = tts.Synthesize(text.Trim(), voice);
            if (audio == null)
            {
                Json(ctx, 502, ErrorBody("Синтез речи недоступен"));
                return;
            }

            ctx.Response.StatusCode = 200;
            ctx.Response.ContentType = "audio/mpeg";
            ctx.Response.ContentLength64 = audio.Length;
            ctx.Response.Headers["Cache-Control"] = "no-store";
            ctx.Response.OutputStream.Write(audio, 0, audio.Length);
            ctx.Response.Close();
        }

        private void Static(HttpListenerContext ctx)
        {
            string method = ctx.Request.HttpMethod;
            if (method != "GET" && method != "HEAD")
            {
                Json(ctx, 405, ErrorBody("Метод не поддерживается"));
                return;
            }

            string path = ctx.Request.Url.AbsolutePath;
            if (path == "/" || path.Length == 0) path = "/index.html";

            string rel = Uri.UnescapeDataString(path).TrimStart('/').Replace('/', Path.DirectorySeparatorChar);
            string full;
            try { full = Path.GetFullPath(Path.Combine(uiDir, rel)); }
            catch { Json(ctx, 400, ErrorBody("Некорректный путь")); return; }

            string prefix = uiDir.TrimEnd(Path.DirectorySeparatorChar) + Path.DirectorySeparatorChar;
            if (!full.StartsWith(prefix, StringComparison.OrdinalIgnoreCase) || !File.Exists(full))
            {
                Json(ctx, 404, ErrorBody("Файл не найден"));
                return;
            }

            byte[] body;
            try { body = File.ReadAllBytes(full); }
            catch (Exception ex) { Json(ctx, 500, ErrorBody(ex.Message)); return; }

            ctx.Response.StatusCode = 200;
            ctx.Response.ContentType = Mime(full);
            ctx.Response.ContentLength64 = body.Length;
            ctx.Response.Headers["Cache-Control"] = "no-store";
            ctx.Response.Headers["Service-Worker-Allowed"] = "/";
            if (method != "HEAD") ctx.Response.OutputStream.Write(body, 0, body.Length);
            ctx.Response.Close();
        }

        private void Proxy(HttpListenerContext ctx)
        {
            string pathAndQuery = ctx.Request.Url.PathAndQuery;
            string upstreamPath = pathAndQuery.Substring(3);
            if (upstreamPath.Length == 0) upstreamPath = "/";

            string url = cfg.OpenCodeUrl.TrimEnd('/') + upstreamPath;
            var req = (HttpWebRequest)WebRequest.Create(url);
            req.Method = ctx.Request.HttpMethod;
            req.Proxy = null;
            req.KeepAlive = false;
            req.AllowAutoRedirect = false;
            req.Timeout = 30000;
            req.ReadWriteTimeout = 3600000;
            req.UserAgent = "JarvisDesktop/1.0";

            if (!string.IsNullOrEmpty(ctx.Request.ContentType)) req.ContentType = ctx.Request.ContentType;
            string accept = ctx.Request.Headers["Accept"];
            if (!string.IsNullOrEmpty(accept)) req.Accept = accept;
            string range = ctx.Request.Headers["Range"];
            if (!string.IsNullOrEmpty(range)) req.Headers["Range"] = range;

            /* Пароль созданного нами сервера подставляется автоматически. */
            if (!string.IsNullOrEmpty(OpenCodeServer.Password))
            {
                string token = Convert.ToBase64String(
                    Encoding.UTF8.GetBytes("opencode:" + OpenCodeServer.Password));
                req.Headers["Authorization"] = "Basic " + token;
            }

            if (ctx.Request.HasEntityBody)
            {
                using (Stream input = ctx.Request.InputStream)
                using (Stream output = req.GetRequestStream())
                {
                    input.CopyTo(output);
                }
            }

            HttpWebResponse resp = null;
            try
            {
                resp = (HttpWebResponse)req.GetResponse();
            }
            catch (WebException ex)
            {
                resp = ex.Response as HttpWebResponse;
            }

            if (resp == null)
            {
                Json(ctx, 502, ErrorBody("OpenCode недоступен: " + cfg.OpenCodeUrl));
                return;
            }

            try
            {
                ctx.Response.StatusCode = (int)resp.StatusCode;
                if (!string.IsNullOrEmpty(resp.ContentType)) ctx.Response.ContentType = resp.ContentType;
                ctx.Response.Headers["Cache-Control"] = "no-store";
                ctx.Response.Headers["X-Accel-Buffering"] = "no";
                ctx.Response.KeepAlive = false;

                if (resp.StatusCode == HttpStatusCode.NoContent || resp.StatusCode == HttpStatusCode.NotModified)
                {
                    ctx.Response.ContentLength64 = 0;
                }
                else
                {
                    ctx.Response.SendChunked = true;
                    Stream source = resp.GetResponseStream();
                    Stream target = ctx.Response.OutputStream;
                    byte[] buffer = new byte[8192];
                    int read;
                    while ((read = source.Read(buffer, 0, buffer.Length)) > 0)
                    {
                        target.Write(buffer, 0, read);
                        target.Flush();
                    }
                }
            }
            catch
            {
                /* клиент отключился */
            }
            finally
            {
                try { resp.Close(); } catch { }
                try { ctx.Response.Close(); } catch { }
            }
        }

        private Dictionary<string, object> ReadJson(HttpListenerContext ctx)
        {
            try
            {
                using (var reader = new StreamReader(ctx.Request.InputStream, Encoding.UTF8))
                {
                    string body = reader.ReadToEnd();
                    if (string.IsNullOrEmpty(body)) return null;
                    return new JavaScriptSerializer().Deserialize<Dictionary<string, object>>(body);
                }
            }
            catch { return null; }
        }

        private static Dictionary<string, object> ErrorBody(string message)
        {
            return new Dictionary<string, object> { { "message", message } };
        }

        private static void Json(HttpListenerContext ctx, int status, object payload)
        {
            byte[] body = Encoding.UTF8.GetBytes(new JavaScriptSerializer().Serialize(payload));
            ctx.Response.StatusCode = status;
            ctx.Response.ContentType = "application/json; charset=utf-8";
            ctx.Response.ContentLength64 = body.Length;
            ctx.Response.Headers["Cache-Control"] = "no-store";
            ctx.Response.OutputStream.Write(body, 0, body.Length);
            ctx.Response.Close();
        }

        private static string Mime(string path)
        {
            switch (Path.GetExtension(path).ToLowerInvariant())
            {
                case ".html": return "text/html; charset=utf-8";
                case ".htm": return "text/html; charset=utf-8";
                case ".css": return "text/css; charset=utf-8";
                case ".js": return "text/javascript; charset=utf-8";
                case ".mjs": return "text/javascript; charset=utf-8";
                case ".json": return "application/json; charset=utf-8";
                case ".webmanifest": return "application/manifest+json; charset=utf-8";
                case ".svg": return "image/svg+xml; charset=utf-8";
                case ".png": return "image/png";
                case ".jpg":
                case ".jpeg": return "image/jpeg";
                case ".gif": return "image/gif";
                case ".ico": return "image/x-icon";
                case ".woff": return "font/woff";
                case ".woff2": return "font/woff2";
                case ".mp3": return "audio/mpeg";
                case ".wav": return "audio/wav";
                case ".txt": return "text/plain; charset=utf-8";
                default: return "application/octet-stream";
            }
        }
    }

    internal sealed class TtsService : IDisposable
    {
        public static readonly string[] VoiceList = new string[]
        {
            "auto",
            "ru-RU-DmitryNeural",
            "en-GB-RyanNeural",
            "ru-RU-SvetlanaNeural"
        };

        private readonly string root;
        private readonly string python;
        private readonly string worker;
        private readonly string cacheDir;
        private readonly string debugLog;
        private readonly object logSync = new object();

        private Process process;
        private StreamWriter input;
        private StreamReader output;
        private Thread reader;
        private readonly object sync = new object();
        private readonly Dictionary<string, Pending> pending = new Dictionary<string, Pending>();
        private bool disposed;

        private sealed class Pending
        {
            public readonly ManualResetEventSlim Done = new ManualResetEventSlim(false);
            public bool Ok;
            public string Error;
        }

        public TtsService(string root)
        {
            this.root = root;
            python = Path.Combine(root, "tts", "py", "python.exe");
            worker = Path.Combine(root, "tts", "worker.py");
            cacheDir = Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                "Jarvis", "tts-cache");
            debugLog = Path.Combine(cacheDir, "worker-debug.log");
            try { Directory.CreateDirectory(cacheDir); } catch { }
        }

        public bool Available
        {
            get { return File.Exists(python) && File.Exists(worker); }
        }

        public void Warmup()
        {
            if (!Available) return;
            var thread = new Thread(delegate(object state) { EnsureWorker(); });
            thread.IsBackground = true;
            thread.Start();
        }

        public byte[] Synthesize(string text, string voice)
        {
            if (!Available) return null;

            string resolved = ResolveVoice(text, voice);
            string key = Hash(resolved + "|" + text);
            string cachePath = Path.Combine(cacheDir, key + ".mp3");

            try
            {
                if (File.Exists(cachePath)) return File.ReadAllBytes(cachePath);
            }
            catch { }

            if (!EnsureWorker()) return null;

            string id = Guid.NewGuid().ToString("N");
            string outPath = Path.Combine(Path.GetTempPath(), "jarvis-tts-" + id + ".mp3");
            var item = new Pending();

            lock (sync)
            {
                pending[id] = item;
            }

            try
            {
                var request = new Dictionary<string, object>();
                request["id"] = id;
                request["text"] = text;
                request["voice"] = resolved;
                request["out"] = outPath;
                string line = AsciiJson(new JavaScriptSerializer().Serialize(request));
                Log("SEND id=" + id + " voice=" + resolved + " chars=" + text.Length);

                lock (sync)
                {
                    if (input == null) return null;
                    input.WriteLine(line);
                    input.Flush();
                }

                if (!item.Done.Wait(90000))
                {
                    Log("TIMEOUT id=" + id);
                    lock (sync) { pending.Remove(id); }
                    return null;
                }

                Log("RESULT ok=" + item.Ok + " err=" + item.Error + " exists=" + File.Exists(outPath));

                if (!item.Ok || !File.Exists(outPath)) return null;

                byte[] audio = File.ReadAllBytes(outPath);
                try { File.WriteAllBytes(cachePath, audio); } catch { }
                return audio;
            }
            catch
            {
                return null;
            }
            finally
            {
                lock (sync) { pending.Remove(id); }
                try { if (File.Exists(outPath)) File.Delete(outPath); } catch { }
            }
        }

        private static string ResolveVoice(string text, string voice)
        {
            if (!string.IsNullOrEmpty(voice) && voice != "auto") return voice;
            return Regex.IsMatch(text, "[А-Яа-яЁё]") ? "ru-RU-DmitryNeural" : "en-GB-RyanNeural";
        }

        /* StreamWriter стандартного ввода в .NET Framework пишет в ANSI,
           поэтому передаём JSON в чистом ASCII с \uXXXX-экранированием. */
        private static string AsciiJson(string value)
        {
            var sb = new StringBuilder(value.Length + 16);
            foreach (char c in value)
            {
                if (c < 128) sb.Append(c);
                else sb.Append("\\u").Append(((int)c).ToString("x4"));
            }
            return sb.ToString();
        }

        private void Log(string message)
        {
            try
            {
                lock (logSync)
                {
                    var info = new FileInfo(debugLog);
                    if (info.Exists && info.Length > 262144) File.Delete(debugLog);
                    File.AppendAllText(debugLog, DateTime.Now.ToString("HH:mm:ss.fff") + " " + message + "\n");
                }
            }
            catch { }
        }

        private static string Hash(string value)
        {
            using (var sha = SHA1.Create())
            {
                byte[] data = sha.ComputeHash(Encoding.UTF8.GetBytes(value));
                var sb = new StringBuilder(data.Length * 2);
                foreach (byte b in data) sb.Append(b.ToString("x2"));
                return sb.ToString();
            }
        }

        private bool EnsureWorker()
        {
            lock (sync)
            {
                if (process != null && !process.HasExited && input != null) return true;

                try
                {
                    if (process != null) process.Dispose();
                }
                catch { }

                try
                {
                    var psi = new ProcessStartInfo();
                    psi.FileName = python;
                    psi.Arguments = "-u \"" + worker + "\"";
                    psi.WorkingDirectory = Path.Combine(root, "tts");
                    psi.UseShellExecute = false;
                    psi.CreateNoWindow = true;
                    psi.RedirectStandardInput = true;
                    psi.RedirectStandardOutput = true;
                    psi.RedirectStandardError = true;
                    psi.StandardOutputEncoding = Encoding.UTF8;
                    psi.StandardErrorEncoding = Encoding.UTF8;
                    psi.EnvironmentVariables["PYTHONIOENCODING"] = "utf-8";
                    psi.EnvironmentVariables["PYTHONUTF8"] = "1";

                    process = Process.Start(psi);
                    if (process == null) return false;

                    input = process.StandardInput;
                    input.AutoFlush = true;
                    output = process.StandardOutput;

                    process.ErrorDataReceived += delegate(object s, DataReceivedEventArgs e)
                    {
                        if (!string.IsNullOrEmpty(e.Data)) Log("STDERR " + e.Data);
                    };
                    process.BeginErrorReadLine();

                    reader = new Thread(ReadLoop);
                    reader.IsBackground = true;
                    reader.Start();
                    return true;
                }
                catch
                {
                    process = null;
                    input = null;
                    output = null;
                    return false;
                }
            }
        }

        private void ReadLoop()
        {
            StreamReader source;
            lock (sync) { source = output; }

            try
            {
                string line;
                while (source != null && (line = source.ReadLine()) != null)
                {
                    Log("RECV " + line);
                    Dictionary<string, object> message = null;
                    try { message = new JavaScriptSerializer().Deserialize<Dictionary<string, object>>(line); }
                    catch { continue; }

                    string id = message != null && message.ContainsKey("id") ? Convert.ToString(message["id"]) : null;
                    if (id == null) continue;

                    Pending item = null;
                    lock (sync)
                    {
                        if (pending.TryGetValue(id, out item)) pending.Remove(id);
                    }
                    if (item == null) continue;

                    item.Ok = message.ContainsKey("ok") && Convert.ToBoolean(message["ok"]);
                    item.Error = message.ContainsKey("error") ? Convert.ToString(message["error"]) : null;
                    item.Done.Set();
                }
            }
            catch { }

            lock (sync)
            {
                foreach (var item in pending.Values)
                {
                    item.Error = "TTS-воркер остановлен";
                    item.Done.Set();
                }
                pending.Clear();
                input = null;
            }
        }

        public void Dispose()
        {
            if (disposed) return;
            disposed = true;
            try
            {
                if (process != null && !process.HasExited) process.Kill();
            }
            catch { }
            try { if (process != null) process.Dispose(); } catch { }
        }
    }
}
