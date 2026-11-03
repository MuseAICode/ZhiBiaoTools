using System.Diagnostics;
using System.Text;
using System.Text.Json;
using ZhiBiao.OpenXmlHelper.Jobs;

namespace ZhiBiao.OpenXmlHelper.Tests;

/// <summary>任务目录与 stdin / stdout 信号协议（见 openxmlhelper/开发说明.md）。</summary>
public sealed class JobProtocolTests : IDisposable
{
    readonly TestWorkspace _workspace = new();

    public void Dispose() => _workspace.Dispose();

    [Fact]
    public void PingWritesSuccessfulResult()
    {
        _workspace.CreateJob("20261030120000-ping", new { action = "ping" });

        var (ok, result) = _workspace.Run("20261030120000-ping");

        Assert.True(ok);
        Assert.True(result.GetProperty("ok").GetBoolean());
        Assert.Equal("ping", result.GetProperty("action").GetString());
    }

    [Fact]
    public void UnknownActionFailsWithReasonInResult()
    {
        _workspace.CreateJob("job-unknown", new { action = "delete-everything" });

        var (ok, result) = _workspace.Run("job-unknown");

        Assert.False(ok);
        Assert.False(result.GetProperty("ok").GetBoolean());
        Assert.Contains("未知动作", result.GetProperty("error").GetString());
    }

    [Fact]
    public void MissingRequestFails()
    {
        Directory.CreateDirectory(_workspace.JobDirectory("job-empty"));

        var (ok, result) = _workspace.Run("job-empty");

        Assert.False(ok);
        Assert.Contains("request.json", result.GetProperty("error").GetString());
    }

    [Theory]
    [InlineData("../escape")]
    [InlineData("a/b")]
    [InlineData("..\\escape")]
    [InlineData("")]
    [InlineData(" ")]
    public void JobIdRejectsPathCharacters(string jobId)
    {
        Assert.False(JobFolder.IsValidJobId(jobId));
    }

    [Fact]
    public void JobDirectoryCannotLeaveWorkspace()
    {
        Assert.Throws<InvalidOperationException>(() => JobFolder.GetJobDirectory(_workspace.Root, ".."));
    }

    [Fact]
    public void RenderOutputMustStayInJobDirectory()
    {
        _workspace.CreateJob("job-output", new
        {
            action = "render-restricted-html-docx",
            html = "<p>正文</p>",
            output = "../escape.docx",
            export_format = ExportFormats.Default(),
        });

        var (ok, result) = _workspace.Run("job-output");

        Assert.False(ok);
        Assert.Contains("output", result.GetProperty("error").GetString());
        Assert.False(File.Exists(Path.Combine(_workspace.Root, JobFolder.JobsFolderName, "escape.docx")));
    }

    [Fact]
    public void AssetRootMustStayInWorkspace()
    {
        _workspace.CreateJob("job-asset-root", new
        {
            action = "render-restricted-html-docx",
            html = "<p>正文</p>",
            asset_root = "../",
            export_format = ExportFormats.Default(),
        });

        var (ok, result) = _workspace.Run("job-asset-root");

        Assert.False(ok);
        Assert.Contains("越出工作区", result.GetProperty("error").GetString());
    }

    /// <summary>真实拉起助手进程：一行 run 信号进、一行 done 信号出，非法编号回失败且进程不退出。</summary>
    [Fact]
    public async Task StdioLoopAnswersRunSignals()
    {
        _workspace.CreateJob("job-stdio", new { action = "ping" });
        var helper = Path.Combine(AppContext.BaseDirectory, "openxmlhelper.dll");
        Assert.True(File.Exists(helper), $"找不到助手程序：{helper}");

        var start = new ProcessStartInfo("dotnet")
        {
            RedirectStandardInput = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false,
            StandardInputEncoding = new UTF8Encoding(false),
            StandardOutputEncoding = Encoding.UTF8,
        };
        start.ArgumentList.Add(helper);
        start.ArgumentList.Add("--workspace");
        start.ArgumentList.Add(_workspace.Root);
        using var process = Process.Start(start)!;
        try
        {
            using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(60));
            await process.StandardInput.WriteAsync("not json\n");
            await process.StandardInput.WriteAsync("{\"v\":1,\"type\":\"run\",\"job\":\"../job-stdio\"}\n");
            await process.StandardInput.WriteAsync("{\"v\":1,\"type\":\"run\",\"job\":\"job-stdio\"}\n");
            await process.StandardInput.FlushAsync();

            var rejected = JsonDocument.Parse((await process.StandardOutput.ReadLineAsync(timeout.Token))!).RootElement;
            Assert.Equal("done", rejected.GetProperty("type").GetString());
            Assert.Equal("../job-stdio", rejected.GetProperty("job").GetString());
            Assert.False(rejected.GetProperty("ok").GetBoolean());

            var done = JsonDocument.Parse((await process.StandardOutput.ReadLineAsync(timeout.Token))!).RootElement;
            Assert.Equal(1, done.GetProperty("v").GetInt32());
            Assert.Equal("job-stdio", done.GetProperty("job").GetString());
            Assert.True(done.GetProperty("ok").GetBoolean());
            Assert.True(_workspace.ReadResult("job-stdio").GetProperty("ok").GetBoolean());

            process.StandardInput.Close();
            await process.WaitForExitAsync(timeout.Token);
            Assert.Equal(0, process.ExitCode);
        }
        finally
        {
            if (!process.HasExited) process.Kill(entireProcessTree: true);
        }
    }
}
