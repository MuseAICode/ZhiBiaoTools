namespace ZhiBiao.OpenXmlHelper.Host;

/// <summary>命令行参数：--workspace &lt;目录&gt;，可选 --run &lt;任务编号&gt;。</summary>
sealed class CommandLineOptions
{
    public string? Workspace { get; init; }

    /// <summary>给出时为一次性运行模式；参数存在但没有值时为空字符串（按编号不合法处理）。</summary>
    public string? RunJob { get; init; }
}

static class CommandLine
{
    public static CommandLineOptions Parse(string[] arguments)
    {
        string? workspace = null;
        string? runJob = null;
        for (var index = 0; index < arguments.Length; index += 1)
        {
            var hasValue = index + 1 < arguments.Length;
            switch (arguments[index])
            {
                case "--workspace" when hasValue:
                    workspace = arguments[++index].Trim();
                    break;
                case "--run":
                    runJob = hasValue ? arguments[++index].Trim() : "";
                    break;
            }
        }

        return new CommandLineOptions { Workspace = workspace, RunJob = runJob };
    }
}
