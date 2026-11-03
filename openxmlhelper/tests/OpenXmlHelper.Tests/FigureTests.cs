using System.Text.Json;
using DocumentFormat.OpenXml.Packaging;
using A = DocumentFormat.OpenXml.Drawing;
using DW = DocumentFormat.OpenXml.Drawing.Wordprocessing;
using Wp = DocumentFormat.OpenXml.Wordprocessing;

namespace ZhiBiao.OpenXmlHelper.Tests;

/// <summary>受限 HTML 的配图：画框预设、裁切与适配、图注、配图提示和无法导出的图片。</summary>
public sealed class FigureTests : IDisposable
{
    const string JobId = "job-figure";
    readonly TestWorkspace _workspace = new();

    public void Dispose() => _workspace.Dispose();

    (bool Ok, JsonElement Result) Render(string html, object? assetTypes = null)
    {
        _workspace.CreateJob(JobId, new
        {
            action = "render-restricted-html-docx",
            html,
            export_format = ExportFormats.Default(),
            asset_types = assetTypes,
        });
        return _workspace.Run(JobId);
    }

    static string Figure(string size, string assetRef, string alt = "示意图", string caption = "图 1 示意图", string extra = "")
    {
        return $"<figure id=\"fig_001\" data-app-generation=\"htmlImage\" data-app-size=\"{size}\"{extra}>"
            + "<template data-app-role=\"prompt\">配图提示不应写入 Word</template>"
            + $"<img alt=\"{alt}\" data-app-asset-ref=\"{assetRef}\"><figcaption>{caption}</figcaption></figure>";
    }

    [Theory]
    [InlineData("square", 0.65, 1, 1)]
    [InlineData("wide", 0.80, 3, 2)]
    [InlineData("tall", 0.50, 3, 4)]
    [InlineData("panorama", 0.90, 16, 9)]
    public void FigureSizePresetSetsFrame(string size, double widthRatio, int aspectWidth, int aspectHeight)
    {
        _workspace.WriteJobFile(JobId, "images/a.png", TestImages.Png(400, 300));

        var (ok, result) = Render(Figure(size, "images/a.png"));

        Assert.True(ok, result.ToString());
        using var document = _workspace.OpenOutput(JobId);
        var extent = document.MainDocumentPart!.Document.Descendants<DW.Extent>().Single();
        var contentWidth = ExportFormats.ContentWidthEmus(ExportFormats.LastSection(document));
        var expectedWidth = (long)Math.Round(contentWidth * widthRatio);
        Assert.Equal(expectedWidth, extent.Cx!.Value);
        Assert.Equal((long)Math.Round(expectedWidth * (double)aspectHeight / aspectWidth), extent.Cy!.Value);
        Assert.Single(document.MainDocumentPart.ImageParts, part => part.ContentType == "image/png");
    }

    [Fact]
    public void ImageMaxWidthLimitsStandaloneFigure()
    {
        _workspace.WriteJobFile(JobId, "a.png", TestImages.Png(400, 300));
        _workspace.CreateJob(JobId, new
        {
            action = "render-restricted-html-docx",
            html = Figure("panorama", "a.png"),
            export_format = new { image = new { max_width_percent = 50 } },
        });

        var (ok, result) = _workspace.Run(JobId);

        Assert.True(ok, result.ToString());
        using var document = _workspace.OpenOutput(JobId);
        var extent = document.MainDocumentPart!.Document.Descendants<DW.Extent>().Single();
        var contentWidth = ExportFormats.ContentWidthEmus(ExportFormats.LastSection(document));
        Assert.Equal((long)Math.Round(contentWidth * 0.5), extent.Cx!.Value);
    }

    [Fact]
    public void CoverCropsToFrameAndContainKeepsImageRatio()
    {
        // 400×300 的图放进 3:2 的 wide 画框：cover 上下各裁掉一部分，contain 不裁切、按 4:3 缩进画框。
        _workspace.WriteJobFile(JobId, "a.png", TestImages.Png(400, 300));
        var html = Figure("wide", "a.png") + Figure("wide", "a.png", extra: " data-app-fit=\"contain\"").Replace("fig_001", "fig_002");

        var (ok, result) = Render(html);

        Assert.True(ok, result.ToString());
        using var document = _workspace.OpenOutput(JobId);
        var crops = document.MainDocumentPart!.Document.Descendants<A.SourceRectangle>().ToList();
        var extents = document.MainDocumentPart.Document.Descendants<DW.Extent>().ToList();
        Assert.Equal(2, crops.Count);
        Assert.True(crops[0].Top!.Value > 0 && crops[0].Top!.Value == crops[0].Bottom!.Value, "cover 应上下对称裁切");
        Assert.Equal(0, crops[0].Left?.Value ?? 0);
        Assert.Equal(0, crops[1].Top?.Value ?? 0);
        Assert.Equal(0, crops[1].Bottom?.Value ?? 0);
        Assert.Equal(4.0 / 3.0, (double)extents[1].Cx!.Value / extents[1].Cy!.Value, 2);
        Assert.True(extents[1].Cy!.Value <= extents[0].Cy!.Value, "contain 的高度不超过画框");
    }

    [Fact]
    public void CaptionIsKeptAndPromptTemplateIsDropped()
    {
        _workspace.WriteJobFile(JobId, "a.png", TestImages.Png(40, 30));

        var (ok, result) = Render("<p>前文</p>" + Figure("wide", "a.png", caption: "图 1 质量控制流程") + "<p>后文</p>");

        Assert.True(ok, result.ToString());
        using var document = _workspace.OpenOutput(JobId);
        var texts = ExportFormats.TopLevelParagraphTexts(document);
        Assert.Equal(["前文", "图 1 质量控制流程", "后文"], texts);
        Assert.DoesNotContain("配图提示", document.MainDocumentPart!.Document.InnerText);
        var description = document.MainDocumentPart.Document.Descendants<DW.DocProperties>().Single().Description?.Value;
        Assert.Equal("示意图", description);
    }

    [Fact]
    public void MissingImageBecomesNoticeAndWarning()
    {
        var (ok, result) = Render(Figure("wide", "images/missing.png", alt: "施工平面图", caption: "图 2 施工平面图") + "<p>后文</p>");

        Assert.True(ok, result.ToString());
        var warning = Assert.Single(result.GetProperty("imageWarnings").EnumerateArray().ToList());
        Assert.Equal("images/missing.png", warning.GetProperty("assetRef").GetString());
        using var document = _workspace.OpenOutput(JobId);
        Assert.Empty(document.MainDocumentPart!.ImageParts);
        Assert.Equal(["[图片无法导出：施工平面图]", "图 2 施工平面图", "后文"], ExportFormats.TopLevelParagraphTexts(document));
    }

    [Fact]
    public void UnrecognizedImageUsesDeclaredTypeOnlyWhenNotDetectable()
    {
        // 文件头无法识别：声明为 PNG 等可核对格式时视为内容不符，声明为其他 image/* 时原样嵌入。
        _workspace.WriteJobFile(JobId, "a.png", [1, 2, 3, 4, 5, 6, 7, 8]);
        _workspace.WriteJobFile(JobId, "b.avif", [1, 2, 3, 4, 5, 6, 7, 8]);
        var html = Figure("wide", "a.png").Replace("fig_001", "fig_a") + Figure("wide", "b.avif").Replace("fig_001", "fig_b");

        var (ok, result) = Render(html, new Dictionary<string, string> { ["a.png"] = "image/png", ["b.avif"] = "image/avif" });

        Assert.True(ok, result.ToString());
        var warning = Assert.Single(result.GetProperty("imageWarnings").EnumerateArray().ToList());
        Assert.Equal("a.png", warning.GetProperty("assetRef").GetString());
        using var document = _workspace.OpenOutput(JobId);
        Assert.Single(document.MainDocumentPart!.ImageParts, part => part.ContentType == "image/avif");
    }

    [Theory]
    [InlineData("<figure data-app-size=\"huge\"><img alt=\"x\" data-app-asset-ref=\"a.png\"></figure>", "data-app-size")]
    [InlineData("<figure data-app-size=\"wide\"><img alt=\"x\"></figure>", "data-app-asset-ref")]
    [InlineData("<figure data-app-size=\"wide\"><img alt=\"x\" data-app-asset-ref=\"../a.png\"></figure>", "相对路径")]
    [InlineData("<figure data-app-size=\"wide\"><img alt=\"x\" data-app-asset-ref=\"/etc/passwd\"></figure>", "相对路径")]
    [InlineData("<p><img alt=\"x\" data-app-asset-ref=\"a.png\"></p>", "figure")]
    public void InvalidFigureStructureFails(string html, string expectedError)
    {
        _workspace.WriteJobFile(JobId, "a.png", TestImages.Png(40, 30));

        var (ok, result) = Render(html);

        Assert.False(ok);
        Assert.Contains(expectedError, result.GetProperty("error").GetString());
    }
}
