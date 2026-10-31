using ZhiBiao.OpenXmlHelper.Host;
using ZhiBiao.OpenXmlHelper.Jobs;

var options = CommandLine.Parse(args);

// 一次性运行模式（服务端 export 沙箱）：执行一个任务目录、写 result.json 后退出，退出码表示成败。
if (options.RunJob is not null)
{
    StdioLoop.ConfigureUtf8();
    return OneShot.Run(options.Workspace, options.RunJob);
}

if (string.IsNullOrWhiteSpace(options.Workspace) || !Directory.Exists(options.Workspace))
{
    Console.Error.WriteLine("缺少有效的 --workspace 目录");
    return 1;
}

// 常驻模式（桌面版）：按 stdin 的 run 信号逐个执行任务，直到 stdin 关闭。
StdioLoop.ConfigureUtf8();
var runner = new JobRunner(Path.GetFullPath(options.Workspace));
await StdioLoop.RunAsync(runner);
return 0;
