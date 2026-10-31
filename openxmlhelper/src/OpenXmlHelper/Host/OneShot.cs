using ZhiBiao.OpenXmlHelper.Jobs;

namespace ZhiBiao.OpenXmlHelper.Host;

/// <summary>
/// 一次性运行模式（路线图第 7 步 7.1）：服务端每个导出任务一个 export 沙箱，沙箱内只运行助手一次。
/// 与常驻模式共用 JobRunner，任务目录、request.json 与 result.json 的约定不变；不读 stdin、不写信号。
/// </summary>
static class OneShot
{
    /// <summary>任务成功，result.json 的 ok 为 true。</summary>
    public const int ExitOk = 0;

    /// <summary>任务失败，原因写在 result.json（任务目录不存在时没有 result.json）。</summary>
    public const int ExitFailed = 1;

    /// <summary>参数不合法：缺少工作区、工作区不存在或任务编号不合法，不执行任何任务。</summary>
    public const int ExitBadArguments = 2;

    public static int Run(string? workspace, string jobId)
    {
        if (string.IsNullOrWhiteSpace(workspace) || !Directory.Exists(workspace))
        {
            Console.Error.WriteLine("缺少有效的 --workspace 目录");
            return ExitBadArguments;
        }

        if (!JobFolder.IsValidJobId(jobId))
        {
            Console.Error.WriteLine("任务编号不合法");
            return ExitBadArguments;
        }

        var runner = new JobRunner(Path.GetFullPath(workspace));
        return runner.Run(jobId) ? ExitOk : ExitFailed;
    }
}
