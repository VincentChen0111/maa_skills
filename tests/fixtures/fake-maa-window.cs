using System;
using System.IO;
using System.Windows.Forms;
using System.Runtime.InteropServices;

class SyntheticMaaWindow : Form
{
    [DllImport("user32.dll")]
    static extern bool ShowWindow(IntPtr hwnd, int command);
    static string Home = AppDomain.CurrentDomain.BaseDirectory;
    static void Log(string type, string message)
    {
        Directory.CreateDirectory(Path.Combine(Home, "debug"));
        File.AppendAllText(Path.Combine(Home, "debug", "gui.log"), "[" + DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss.fff") + "][INF]" + ("[" + type + "]").PadRight(24) + " <1> " + message + Environment.NewLine);
    }
    [STAThread]
    static void Main(string[] args)
    {
        File.WriteAllLines(Path.Combine(Home, "launch-arguments.txt"), args);
        Log("Bootstrapper", "MaaAssistantArknights GUI started");
        Log("Bootstrapper", "Version v6.21.4");
        Application.Run(new SyntheticMaaWindow());
        Log("Bootstrapper", "MaaAssistantArknights GUI exited");
    }
    SyntheticMaaWindow()
    {
        Text = "Synthetic MAA process test";
        Opacity = 0;
        ShowInTaskbar = true;
        Load += delegate {
            // Make the transparent test window eligible for CloseMainWindow without showing test UI to the user.
            var timer = new Timer();
            timer.Interval = 50;
            timer.Tick += delegate { ShowWindow(Handle, 5); timer.Stop(); timer.Dispose(); Log("RunningState", "Init: False to True (called from Init)"); };
            timer.Start();
        };
    }
}
