using System.Text.Json;
using DW = DocumentFormat.OpenXml.Drawing.Wordprocessing;

namespace ZhiBiao.OpenXmlHelper.Tests;

/// <summary>
/// 八种可按文件头核对的图片格式逐一识别（#43 登记、路线图 7.1 补上）：Word 图片类型与尺寸取自文件头而不是扩展名，
/// 扩展名或声明的类型与内容不符时按内容嵌入；声明为可核对格式而文件头无法识别时视为内容不符，原位改为文字提示。
/// </summary>
public sealed class ImageFormatTests : IDisposable
{
    const string JobId = "job-image-format";
    readonly TestWorkspace _workspace = new();

    public void Dispose() => _workspace.Dispose();

    /// <summary>格式名 → 400×300（4:3）的样本和 Word 图片部件的类型。EMF 的画面尺寸以 0.01 毫米计，同样是 4:3。</summary>
    public static TheoryData<string> Formats => new() { "png", "jpeg", "gif", "bmp", "webp", "tiff", "emf", "wmf" };

    static (byte[] Bytes, string ContentType) Sample(string format) => format switch
    {
        "png" => (TestImages.Png(400, 300), "image/png"),
        "jpeg" => (TestImages.Jpeg(400, 300), "image/jpeg"),
        "gif" => (TestImages.Gif(400, 300), "image/gif"),
        "bmp" => (TestImages.Bmp(400, 300), "image/bmp"),
        "webp" => (TestImages.Webp(400, 300), "image/webp"),
        "tiff" => (TestImages.Tiff(400, 300), "image/tiff"),
        "emf" => (TestImages.Emf(4000, 3000), "image/x-emf"),
        "wmf" => (TestImages.Wmf(400, 300), "image/x-wmf"),
        _ => throw new ArgumentOutOfRangeException(nameof(format)),
    };

    static string DeclaredType(string format) => format switch
    {
        "emf" => "image/emf",
        "wmf" => "image/wmf",
        _ => $"image/{format}",
    };

    /// <summary>contain 不裁切，画框内的实际宽高比就是从文件头读出的图片宽高比。</summary>
    static string Figure(string assetRef) =>
        "<figure id=\"fig_001\" data-app-generation=\"htmlImage\" data-app-size=\"square\" data-app-fit=\"contain\">"
        + $"<img alt=\"示意图\" data-app-asset-ref=\"{assetRef}\"><figcaption>图 1 示意图</figcaption></figure>";

    (bool Ok, JsonElement Result) Render(string assetRef, Dictionary<string, string>? assetTypes)
    {
        _workspace.CreateJob(JobId, new
        {
            action = "render-restricted-html-docx",
            html = Figure(assetRef),
            export_format = ExportFormats.Default(),
            asset_types = assetTypes,
        });
        return _workspace.Run(JobId);
    }

    void AssertEmbedded(JsonElement result, string contentType)
    {
        Assert.Empty(result.GetProperty("imageWarnings").EnumerateArray());
        using var document = _workspace.OpenOutput(JobId);
        var part = Assert.Single(document.MainDocumentPart!.ImageParts);
        Assert.Equal(contentType, part.ContentType);
        var extent = document.MainDocumentPart.Document.Descendants<DW.Extent>().Single();
        Assert.Equal(4.0 / 3.0, (double)extent.Cx!.Value / extent.Cy!.Value, 2);
    }

    [Theory]
    [MemberData(nameof(Formats))]
    public void RecognizesFormatAndSizeFromFileHeader(string format)
    {
        var (bytes, contentType) = Sample(format);
        _workspace.WriteJobFile(JobId, $"images/a.{format}", bytes);

        var (ok, result) = Render($"images/a.{format}", new() { [$"images/a.{format}"] = DeclaredType(format) });

        Assert.True(ok, result.ToString());
        AssertEmbedded(result, contentType);
    }

    [Theory]
    [MemberData(nameof(Formats))]
    public void MismatchedExtensionAndDeclaredTypeFollowTheContent(string format)
    {
        // 扩展名和声明的类型都说是另一种可核对格式（PNG 样本冒充 GIF，其余冒充 PNG），按文件头嵌入。
        var (bytes, contentType) = Sample(format);
        var (fakeExtension, fakeType) = format == "png" ? ("gif", "image/gif") : ("png", "image/png");
        _workspace.WriteJobFile(JobId, $"a.{fakeExtension}", bytes);

        var (ok, result) = Render($"a.{fakeExtension}", new() { [$"a.{fakeExtension}"] = fakeType });

        Assert.True(ok, result.ToString());
        AssertEmbedded(result, contentType);
    }

    [Theory]
    [MemberData(nameof(Formats))]
    public void DeclaredDetectableTypeWithUnrecognizedContentBecomesNotice(string format)
    {
        // 声明为可核对格式而文件头对不上（例如被改了扩展名的其他文件）：不按声明原样嵌入，原位改为文字提示并返回警告。
        _workspace.WriteJobFile(JobId, $"a.{format}", "not an image at all, just text"u8.ToArray());

        var (ok, result) = Render($"a.{format}", new() { [$"a.{format}"] = DeclaredType(format) });

        Assert.True(ok, result.ToString());
        var warning = Assert.Single(result.GetProperty("imageWarnings").EnumerateArray().ToList());
        Assert.Equal($"a.{format}", warning.GetProperty("assetRef").GetString());
        using var document = _workspace.OpenOutput(JobId);
        Assert.Empty(document.MainDocumentPart!.ImageParts);
        Assert.Contains("[图片无法导出：示意图]", ExportFormats.TopLevelParagraphTexts(document));
    }
}
