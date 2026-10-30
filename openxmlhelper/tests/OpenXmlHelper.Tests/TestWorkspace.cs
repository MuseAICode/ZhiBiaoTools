using System.Text;
using System.Text.Json;
using DocumentFormat.OpenXml.Packaging;
using ZhiBiao.OpenXmlHelper.Jobs;

// 渲染器有进程级的 HTML 与配图缓存，助手本身一次只跑一个任务；测试同样串行执行。
[assembly: CollectionBehavior(DisableTestParallelization = true)]

namespace ZhiBiao.OpenXmlHelper.Tests;

/// <summary>一次性的助手工作区：按 Main 的约定写 request.json，经 JobRunner 执行后读取 result.json 和产物。</summary>
sealed class TestWorkspace : IDisposable
{
    static readonly JsonSerializerOptions RequestOptions = new() { WriteIndented = true };

    public TestWorkspace()
    {
        Root = Path.Combine(Path.GetTempPath(), $"openxmlhelper-tests-{Guid.NewGuid():N}");
        Directory.CreateDirectory(Root);
        Runner = new JobRunner(Root);
    }

    public string Root { get; }
    public JobRunner Runner { get; }

    public string JobDirectory(string jobId) => Path.Combine(Root, JobFolder.JobsFolderName, jobId);

    /// <summary>创建任务目录并写入 request.json；request 按原样序列化，字段名与 Main 发送的一致。</summary>
    public string CreateJob(string jobId, object request)
    {
        var directory = JobDirectory(jobId);
        Directory.CreateDirectory(directory);
        File.WriteAllText(
            Path.Combine(directory, JobFolder.RequestFileName),
            JsonSerializer.Serialize(request, RequestOptions),
            new UTF8Encoding(encoderShouldEmitUTF8Identifier: false));
        return directory;
    }

    /// <summary>在任务目录中写入文件（配图等），返回完整路径。</summary>
    public string WriteJobFile(string jobId, string relativePath, byte[] bytes)
    {
        var path = Path.Combine(JobDirectory(jobId), relativePath.Replace('/', Path.DirectorySeparatorChar));
        Directory.CreateDirectory(Path.GetDirectoryName(path)!);
        File.WriteAllBytes(path, bytes);
        return path;
    }

    public (bool Ok, JsonElement Result) Run(string jobId)
    {
        var ok = Runner.Run(jobId);
        return (ok, ReadResult(jobId));
    }

    public JsonElement ReadResult(string jobId)
    {
        var text = File.ReadAllText(Path.Combine(JobDirectory(jobId), JobFolder.ResultFileName), Encoding.UTF8);
        return JsonDocument.Parse(text).RootElement.Clone();
    }

    public WordprocessingDocument OpenOutput(string jobId, string output = "preview.docx")
    {
        return WordprocessingDocument.Open(Path.Combine(JobDirectory(jobId), output), false);
    }

    public void Dispose()
    {
        try { Directory.Delete(Root, recursive: true); } catch { }
    }
}
