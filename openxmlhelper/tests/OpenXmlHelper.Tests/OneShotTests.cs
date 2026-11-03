using System.Diagnostics;
using System.Text;
using ZhiBiao.OpenXmlHelper.Host;

namespace ZhiBiao.OpenXmlHelper.Tests;

/// <summary>
/// 一次性运行模式（路线图 7.1，服务端 export 沙箱用）：openxmlhelper --workspace &lt;目录&gt; --run &lt;任务编号&gt;
/// 执行一个任务目录、写 result.json 后退出；0 为成功，1 为任务失败（原因在 result.json），2 为参数不合法（不执行任务）。
/// </summary>
public sealed class OneShotTests : IDisposable
{
    readonly TestWorkspace _workspace = new();

    public void Dispose() => _workspace.Dispose();

    [Fact]
    public void ParsesWorkspaceAndRunJob()
    {
        var options = CommandLine.Parse(["--workspace", " /work ", "--run", "export"]);
        Assert.Equal("/work", options.Workspace);
        Assert.Equal("export", options.RunJob);

        Assert.Null(CommandLine.Parse(["--workspace", "/work"]).RunJob);
        Assert.Equal("", CommandLine.Parse(["--workspace", "/work", "--run"]).RunJob);
    }

    [Fact]
    public void SuccessfulJobExitsZeroAndWritesResult()
    {
        _workspace.CreateJob("job-once", new { action = "ping" });

        Assert.Equal(OneShot.ExitOk, OneShot.Run(_workspace.Root, "job-once"));
        Assert.True(_workspace.ReadResult("job-once").GetProperty("ok").GetBoolean());
    }

    [Fact]
    public void FailedJobExitsOneWithReasonInResult()
    {
        _workspace.CreateJob("job-once", new { action = "delete-everything" });

        Assert.Equal(OneShot.ExitFailed, OneShot.Run(_workspace.Root, "job-once"));
        Assert.Contains("未知动作", _workspace.ReadResult("job-once").GetProperty("error").GetString());
    }

    [Theory]
    [InlineData("")]
    [InlineData("../job-once")]
    [InlineData("a/b")]
    public void InvalidJobIdExitsTwoWithoutRunning(string jobId)
    {
        _workspace.CreateJob("job-once", new { action = "ping" });

        Assert.Equal(OneShot.ExitBadArguments, OneShot.Run(_workspace.Root, jobId));
        Assert.False(File.Exists(Path.Combine(_workspace.JobDirectory("job-once"), "result.json")));
    }

    [Fact]
    public void MissingWorkspaceExitsTwo()
    {
        Assert.Equal(OneShot.ExitBadArguments, OneShot.Run(null, "job-once"));
        Assert.Equal(OneShot.ExitBadArguments, OneShot.Run(Path.Combine(_workspace.Root, "missing"), "job-once"));
    }

    /// <summary>真实拉起助手进程：不读 stdin、不写信号，执行完即退出，退出码与 result.json 一致。</summary>
    [Theory]
    [InlineData("ping", 0, true)]
    [InlineData("delete-everything", 1, false)]
    public async Task ProcessRunsOneJobAndExits(string action, int expectedExitCode, bool expectedOk)
    {
        _workspace.CreateJob("job-process", new { action });

        var (exitCode, stdout) = await RunHelperAsync("--workspace", _workspace.Root, "--run", "job-process");

        Assert.Equal(expectedExitCode, exitCode);
        Assert.Equal("", stdout);
        Assert.Equal(expectedOk, _workspace.ReadResult("job-process").GetProperty("ok").GetBoolean());
    }

    [Fact]
    public async Task ProcessRejectsBadArguments()
    {
        Assert.Equal(2, (await RunHelperAsync("--workspace", _workspace.Root, "--run", "../escape")).ExitCode);
        Assert.Equal(2, (await RunHelperAsync("--workspace", _workspace.Root, "--run")).ExitCode);
        Assert.Equal(2, (await RunHelperAsync("--run", "job-process")).ExitCode);
    }

    static async Task<(int ExitCode, string Stdout)> RunHelperAsync(params string[] arguments)
    {
        var helper = Path.Combine(AppContext.BaseDirectory, "openxmlhelper.dll");
        Assert.True(File.Exists(helper), $"找不到助手程序：{helper}");
        var start = new ProcessStartInfo("dotnet")
        {
            // stdin 一直保持打开：一次性模式若去读 stdin 会卡住，由超时发现。
            RedirectStandardInput = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false,
            StandardOutputEncoding = Encoding.UTF8,
        };
        start.ArgumentList.Add(helper);
        foreach (var argument in arguments) start.ArgumentList.Add(argument);
        using var process = Process.Start(start)!;
        try
        {
            using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(60));
            var stdout = process.StandardOutput.ReadToEndAsync(timeout.Token);
            var stderr = process.StandardError.ReadToEndAsync(timeout.Token);
            await process.WaitForExitAsync(timeout.Token);
            await stderr;
            return (process.ExitCode, await stdout);
        }
        finally
        {
            if (!process.HasExited) process.Kill(entireProcessTree: true);
        }
    }
}
