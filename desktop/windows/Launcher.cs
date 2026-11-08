using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Net;
using System.Net.Sockets;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Web.Script.Serialization;
using System.Windows.Forms;

internal static class FynoteLauncher
{
    private const int RestartExitCode = 42;
    private const int SetupExitCode = 43;
    private static readonly JavaScriptSerializer Json = new JavaScriptSerializer();
    private static readonly Regex Version = new Regex(@"^(0|[1-9]\d{0,5})(\.(0|[1-9]\d{0,5})){2}$");

    [STAThread]
    private static void Main(string[] args)
    {
        if (args.Length == 3 && args[0] == "--apply-setup")
        {
            ApplySetup(args[1], args[2]);
            return;
        }

        string root = AppDomain.CurrentDomain.BaseDirectory;
        string profile = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Kept");
        using (var mutex = new Mutex(false, @"Local\FynoteDesktop"))
        {
            bool ownsMutex = false;
            try
            {
                try { ownsMutex = mutex.WaitOne(0); }
                catch (AbandonedMutexException) { ownsMutex = true; }

                Directory.CreateDirectory(profile);
                if (!ownsMutex)
                {
                    OpenWindow(root, ReadVersion(root), profile).Dispose();
                    return;
                }

                while (true)
                {
                    string stateFile = Path.Combine(root, "current.json");
                    var state = Json.Deserialize<Dictionary<string, string>>(File.ReadAllText(stateFile));
                    string version = ValidVersion(state, "version");
                    if (version == null) throw new InvalidDataException("找不到 Fynote 版本信息。");
                    string previousVersion = ValidVersion(state, "previousVersion");

                    Process startedWindow;
                    try
                    {
                        startedWindow = OpenWindow(root, version, profile);
                    }
                    catch
                    {
                        if (previousVersion == null || previousVersion == version ||
                            !File.Exists(Path.Combine(root, "versions", previousVersion, "window", "electron.exe"))) throw;
                        string rollback = stateFile + ".rollback";
                        File.WriteAllText(rollback, Json.Serialize(new { version = previousVersion }), new UTF8Encoding(false));
                        File.Replace(rollback, stateFile, null);
                        MessageBox.Show("新版启动失败，已切回版本 " + previousVersion + "。", "Fynote");
                        continue;
                    }

                    using (Process window = startedWindow)
                    {
                        window.WaitForExit();
                        if (window.ExitCode == SetupExitCode)
                        {
                            try
                            {
                                string helper = Path.Combine(root, ".update", "apply.exe");
                                File.Copy(Application.ExecutablePath, helper, true);
                                Process.Start(new ProcessStartInfo(helper,
                                    "--apply-setup " + Process.GetCurrentProcess().Id + " " + version)
                                { UseShellExecute = false });
                                return;
                            }
                            catch (Exception error)
                            {
                                MessageBox.Show("无法启动更新安装程序。\n" + error.Message, "Fynote");
                                continue;
                            }
                        }
                        if (window.ExitCode != RestartExitCode) break;
                    }
                }
            }
            catch (Exception error)
            {
                MessageBox.Show("无法启动 Fynote。\n" + error.Message, "Fynote", MessageBoxButtons.OK, MessageBoxIcon.Error);
            }
            finally
            {
                if (ownsMutex) mutex.ReleaseMutex();
            }
        }
    }

    private static void ApplySetup(string parent, string previous)
    {
        string staging = AppDomain.CurrentDomain.BaseDirectory;
        string root = Directory.GetParent(staging.TrimEnd(Path.DirectorySeparatorChar)).FullName;
        string setup = Path.Combine(staging, "setup.exe");
        string launcher = Path.Combine(root, "fynote.exe");
        try
        {
            int pid;
            if (!Int32.TryParse(parent, out pid) || !Version.IsMatch(previous))
                throw new InvalidDataException("无效的更新请求。");
            try
            {
                using (Process original = Process.GetProcessById(pid))
                    if (!original.WaitForExit(30000)) throw new IOException("Fynote 尚未退出。");
            }
            catch (ArgumentException) { } // The original launcher has already exited.

            var metadata = FileVersionInfo.GetVersionInfo(setup);
            var version = new System.Version(metadata.FileMajorPart, metadata.FileMinorPart, metadata.FileBuildPart);
            if ((metadata.ProductName ?? "").Trim() != "Fynote Installer" || version.CompareTo(new System.Version(previous)) <= 0)
                throw new InvalidDataException("安装程序名称或版本不符。");

            using (Process installer = Process.Start(new ProcessStartInfo(setup,
                "/SILENT /SUPPRESSMSGBOXES /NORESTART /DIR=\"" + root.TrimEnd(Path.DirectorySeparatorChar) + "\"")
            { UseShellExecute = true }))
            {
                installer.WaitForExit();
                if (installer.ExitCode != 0) throw new IOException("安装未完成，退出代码 " + installer.ExitCode + "。");
            }

            string stateFile = Path.Combine(root, "current.json");
            var state = Json.Deserialize<Dictionary<string, string>>(File.ReadAllText(stateFile));
            if (ValidVersion(state, "version") != version.ToString())
                throw new InvalidDataException("安装后未检测到新版本。");
            string pending = stateFile + ".setup";
            File.WriteAllText(pending, Json.Serialize(new { version = version.ToString(), previousVersion = previous }), new UTF8Encoding(false));
            File.Replace(pending, stateFile, null);
        }
        catch (Exception error)
        {
            MessageBox.Show("更新未完成。\n" + error.Message, "Fynote");
        }
        finally
        {
            try { File.Delete(setup); } catch (IOException) { }
            Process.Start(new ProcessStartInfo(launcher) { UseShellExecute = true });
        }
    }

    private static string ValidVersion(Dictionary<string, string> state, string key)
    {
        string value;
        return state.TryGetValue(key, out value) && value != null && Version.IsMatch(value) ? value : null;
    }

    private static Process StartServer(string root, string profile, string version, int port)
    {
        string payload = Path.Combine(root, "versions", version);
        var start = new ProcessStartInfo(Path.Combine(payload, "runtime", "node.exe"), "server/server.js");
        start.WorkingDirectory = Path.Combine(payload, "app");
        start.UseShellExecute = false;
        start.CreateNoWindow = true;
        start.RedirectStandardInput = true;
        start.EnvironmentVariables["NODE_ENV"] = "production";
        start.EnvironmentVariables["PORT"] = port.ToString();
        start.EnvironmentVariables["DATA_DIR"] = Path.Combine(profile, "data");
        start.EnvironmentVariables["BASE_URL"] = Address(port);
        start.EnvironmentVariables["FYNOTE_DESKTOP_ROOT"] = root;
        start.EnvironmentVariables["FYNOTE_CLOSE_ON_STDIN_END"] = "1";
        return Process.Start(start);
    }

    private static string Address(int port)
    {
        return "http://127.0.0.1:" + port;
    }

    private static int ReadPort(string file)
    {
        int port;
        return File.Exists(file) && Int32.TryParse(File.ReadAllText(file), out port) && port > 0 && port <= 65535 ? port : 0;
    }

    private static int ReservePort(int preferred)
    {
        var listener = new TcpListener(IPAddress.Loopback, preferred);
        try { listener.Start(); }
        catch (SocketException)
        {
            listener.Stop();
            if (preferred == 0) throw;
            return ReservePort(0);
        }
        try { return ((IPEndPoint)listener.LocalEndpoint).Port; }
        finally { listener.Stop(); }
    }

    private static bool WaitForReady(int port, string version, Process server)
    {
        var timeout = Stopwatch.StartNew();
        while (timeout.Elapsed < TimeSpan.FromSeconds(40))
        {
            if (server != null && server.HasExited) return false;
            try
            {
                var request = (HttpWebRequest)WebRequest.Create(Address(port) + "/api/health");
                request.Proxy = null;
                request.AllowAutoRedirect = false;
                request.Timeout = 750;
                using (var response = (HttpWebResponse)request.GetResponse())
                {
                    string actual = response.Headers["X-Fynote-Desktop-Version"];
                    if (response.StatusCode == HttpStatusCode.OK && actual != null && (version == null || version == actual))
                        return true;
                }
            }
            catch (WebException) {}
            Thread.Sleep(250);
        }
        return false;
    }

    private static string ReadVersion(string root)
    {
        var state = Json.Deserialize<Dictionary<string, string>>(File.ReadAllText(Path.Combine(root, "current.json")));
        return ValidVersion(state, "version");
    }

    private static Process OpenWindow(string root, string version, string profile)
    {
        if (version == null) throw new InvalidDataException("找不到 Fynote 版本信息。");
        string runtime = Path.Combine(root, "versions", version, "window", "electron.exe");
        if (!File.Exists(runtime)) throw new FileNotFoundException("缺少 Fynote 窗口组件，请重新安装。");
        string arguments = "--fynote-profile=\"" + Path.Combine(profile, "FynoteDesktopProfile") + "\"";
        return Process.Start(new ProcessStartInfo(runtime, arguments) { UseShellExecute = false });
    }
}
