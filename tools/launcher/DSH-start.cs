// DSH-start.exe —— GUI 子系统启动器（不创建控制台窗口）
//
// 职责：拉起 node 进程跑 server\main.js，自身立即退出。
// 界面在浏览器里；node 绑好端口后会自己调 rundll32 打开默认浏览器。
//
// 关于「被安全软件拦截」：沿用上一版的做法 ——
//   1) 不用 -WindowStyle Hidden / -EncodedCommand 这类可疑特征；
//   2) 用 CREATE_NO_WINDOW 让宿主进程干脆没有控制台，同样零闪窗；
//   3) 显式 asInvoker（不提权）+ 完整版本信息，避免"无名 exe"被启发式判定。
using System;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;

internal static class Program
{
    private const uint CREATE_NO_WINDOW = 0x08000000;
    private const uint CREATE_UNICODE_ENVIRONMENT = 0x00000400;

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct STARTUPINFO
    {
        public int cb;
        public string lpReserved;
        public string lpDesktop;
        public string lpTitle;
        public int dwX, dwY, dwXSize, dwYSize, dwXCountChars, dwYCountChars, dwFillAttribute;
        public int dwFlags;
        public short wShowWindow;
        public short cbReserved2;
        public IntPtr lpReserved2;
        public IntPtr hStdInput, hStdOutput, hStdError;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct PROCESS_INFORMATION
    {
        public IntPtr hProcess, hThread;
        public int dwProcessId, dwThreadId;
    }

    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    private static extern bool CreateProcess(
        string appName, StringBuilder commandLine, IntPtr procAttr, IntPtr threadAttr,
        bool inheritHandles, uint creationFlags, IntPtr environment,
        string currentDirectory, ref STARTUPINFO startupInfo, out PROCESS_INFORMATION procInfo);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool CloseHandle(IntPtr handle);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern int MessageBox(IntPtr hWnd, string text, string caption, uint type);

    [STAThread]
    private static int Main(string[] args)
    {
        try
        {
            string root = AppDomain.CurrentDomain.BaseDirectory.TrimEnd('\\');
            string entry = Path.Combine(root, @"server\main.js");
            if (!File.Exists(entry))
            {
                ShowError("缺少 server\\main.js：\n" + entry + "\n\n请把整个 DSH-start 文件夹一起移动，不要只复制 exe。");
                return 2;
            }

            string node = FindNode();
            if (node == null)
            {
                ShowError("未找到 Node.js（node.exe）。\n\n" +
                          "请安装 Node.js 20 或更高版本：\nhttps://nodejs.org/\n" +
                          "安装后无需重启，直接再双击本程序。");
                return 3;
            }

            string arguments = "\"" + entry + "\"";
            foreach (string a in args)
            {
                arguments += " \"" + a + "\"";
            }

            int err;
            if (!LaunchHidden(node, arguments, root, out err))
            {
                if (err == 740)
                {
                    ShowError("启动被系统要求提升权限。\n\n请右键 DSH-start.exe →「以管理员身份运行」。");
                }
                else if (err == 5)
                {
                    ShowError("系统拒绝创建进程（错误 5）。\n\n通常是安全软件拦截：\n请把整个 DSH-start 文件夹加入白名单后重试。\n\nNode 路径：" + node);
                }
                else
                {
                    ShowError("无法启动 Node 进程（错误码 " + err + "）。\n\nNode 路径：" + node +
                              "\n\n如果是安全软件拦截，请把整个文件夹加入白名单。");
                }
                return 4;
            }

            return 0;
        }
        catch (Exception ex)
        {
            ShowError("启动失败：\n" + ex.Message);
            return 1;
        }
    }

    private static bool LaunchHidden(string exe, string arguments, string workDir, out int win32Error)
    {
        win32Error = 0;
        var si = new STARTUPINFO();
        si.cb = Marshal.SizeOf(typeof(STARTUPINFO));

        var cmd = new StringBuilder();
        cmd.Append('"').Append(exe).Append("\" ").Append(arguments);

        PROCESS_INFORMATION pi;
        bool ok = CreateProcess(null, cmd, IntPtr.Zero, IntPtr.Zero, false,
                                CREATE_NO_WINDOW | CREATE_UNICODE_ENVIRONMENT,
                                IntPtr.Zero, workDir, ref si, out pi);

        if (!ok)
        {
            win32Error = Marshal.GetLastWin32Error();
            return false;
        }

        if (pi.hThread != IntPtr.Zero) CloseHandle(pi.hThread);
        if (pi.hProcess != IntPtr.Zero) CloseHandle(pi.hProcess);
        return true;
    }

    private static string FindNode()
    {
        // 1) DSH_START_NODE 显式指定
        string env = Environment.GetEnvironmentVariable("DSH_START_NODE");
        if (!string.IsNullOrEmpty(env) && File.Exists(env)) return env;

        // 2) 常见安装位置（优先 Program Files，PATH 里可能是别的运行时）
        string[] candidates =
        {
            Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), @"nodejs\node.exe"),
            Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86), @"nodejs\node.exe"),
            Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), @"Programs\nodejs\node.exe"),
            @"C:\Program Files\nodejs\node.exe",
        };
        foreach (string c in candidates)
        {
            try { if (File.Exists(c)) return c; } catch { }
        }

        // 3) PATH
        string pathVar = Environment.GetEnvironmentVariable("PATH") ?? string.Empty;
        foreach (string dir in pathVar.Split(';'))
        {
            if (string.IsNullOrWhiteSpace(dir)) continue;
            try
            {
                string p = Path.Combine(dir.Trim('"').Trim(), "node.exe");
                if (File.Exists(p)) return p;
            }
            catch { }
        }

        // 4) 注册表 App Paths
        try
        {
            using (var key = Microsoft.Win32.Registry.LocalMachine.OpenSubKey(
                @"SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\node.exe"))
            {
                if (key != null)
                {
                    string p = key.GetValue(null) as string;
                    if (!string.IsNullOrEmpty(p) && File.Exists(p)) return p;
                }
            }
        }
        catch { }

        return null;
    }

    private static void ShowError(string message)
    {
        try { MessageBox(IntPtr.Zero, message, "DSH 控制台", 0x00000010 /* MB_ICONERROR */); } catch { }
    }
}
