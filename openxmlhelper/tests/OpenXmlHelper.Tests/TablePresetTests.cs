using DW = DocumentFormat.OpenXml.Drawing.Wordprocessing;
using Wp = DocumentFormat.OpenXml.Wordprocessing;

namespace ZhiBiao.OpenXmlHelper.Tests;

/// <summary>表格预设（data-app-preset）决定单元格中配图的宽度；没有预设时按逻辑网格计算。</summary>
public sealed class TablePresetTests : IDisposable
{
    const string JobId = "job-table";
    const long EmusPerPoint = 12_700L;
    readonly TestWorkspace _workspace = new();

    public void Dispose() => _workspace.Dispose();

    static string Cell(string assetRef, string id) =>
        $"<td><figure id=\"{id}\" data-app-size=\"wide\"><img alt=\"{id}\" data-app-asset-ref=\"{assetRef}\"></figure></td>";

    List<long> RenderWidths(string html, out long contentWidth)
    {
        _workspace.WriteJobFile(JobId, "a.png", TestImages.Png(300, 200));
        _workspace.CreateJob(JobId, new
        {
            action = "render-restricted-html-docx",
            html,
            export_format = ExportFormats.Default(),
        });
        var (ok, result) = _workspace.Run(JobId);
        Assert.True(ok, result.ToString());
        using var document = _workspace.OpenOutput(JobId);
        contentWidth = ExportFormats.ContentWidthEmus(ExportFormats.LastSection(document));
        Assert.NotEmpty(document.MainDocumentPart!.Document.Descendants<Wp.Table>());
        return document.MainDocumentPart.Document.Descendants<DW.Extent>().Select(item => item.Cx!.Value).ToList();
    }

    static long Expected(long contentWidth, double ratio, double paddingPoints) =>
        (long)Math.Round(contentWidth * ratio) - (long)Math.Round(paddingPoints * EmusPerPoint);

    [Fact]
    public void ImageTextPresetGivesImageCell44Percent()
    {
        var html = "<table data-app-preset=\"imageText\"><tbody><tr>"
            + Cell("a.png", "fig_1")
            + "<td><p>说明文字</p></td></tr></tbody></table>";

        var widths = RenderWidths(html, out var contentWidth);

        Assert.Equal([Expected(contentWidth, 0.44, 0)], widths);
    }

    [Fact]
    public void ThreeImagesPresetSplitsIntoThirds()
    {
        var html = "<table data-app-preset=\"threeImages\"><tbody><tr>"
            + Cell("a.png", "fig_1") + Cell("a.png", "fig_2") + Cell("a.png", "fig_3")
            + "</tr></tbody></table>";

        var widths = RenderWidths(html, out var contentWidth);

        Assert.Equal(Enumerable.Repeat(Expected(contentWidth, 1.0 / 3.0, 12), 3), widths);
    }

    [Fact]
    public void FourImagesPresetUsesTwoByTwoGrid()
    {
        var html = "<table data-app-preset=\"fourImages\"><tbody>"
            + "<tr>" + Cell("a.png", "fig_1") + Cell("a.png", "fig_2") + "</tr>"
            + "<tr>" + Cell("a.png", "fig_3") + Cell("a.png", "fig_4") + "</tr>"
            + "</tbody></table>";

        var widths = RenderWidths(html, out var contentWidth);

        Assert.Equal(Enumerable.Repeat(Expected(contentWidth, 0.5, 12), 4), widths);
    }

    [Fact]
    public void TableWithoutPresetUsesLogicalGridIncludingColspan()
    {
        // 4 列逻辑网格：第一行 colspan=3 的单元格占 3/4，第二行普通单元格占 1/4。
        var html = "<table><tbody>"
            + "<tr>" + Cell("a.png", "fig_1").Replace("<td>", "<td colspan=\"3\">") + "<td>备注</td></tr>"
            + "<tr>" + Cell("a.png", "fig_2") + "<td>a</td><td>b</td><td>c</td></tr>"
            + "</tbody></table>";

        var widths = RenderWidths(html, out var contentWidth);

        Assert.Equal([Expected(contentWidth, 0.75, 12), Expected(contentWidth, 0.25, 12)], widths);
    }

    [Fact]
    public void FigureInTableIgnoresStandaloneMaxWidth()
    {
        // 单元格内配图按单元格宽度排版，不受独立配图的 max_width_percent 限制。
        var html = "<table data-app-preset=\"imageText\"><tbody><tr>"
            + Cell("a.png", "fig_1") + "<td>说明</td></tr></tbody></table>";
        _workspace.WriteJobFile(JobId, "a.png", TestImages.Png(300, 200));
        _workspace.CreateJob(JobId, new
        {
            action = "render-restricted-html-docx",
            html,
            export_format = new { image = new { max_width_percent = 20 } },
        });

        var (ok, result) = _workspace.Run(JobId);

        Assert.True(ok, result.ToString());
        using var document = _workspace.OpenOutput(JobId);
        var contentWidth = ExportFormats.ContentWidthEmus(ExportFormats.LastSection(document));
        Assert.Equal(Expected(contentWidth, 0.44, 0), document.MainDocumentPart!.Document.Descendants<DW.Extent>().Single().Cx!.Value);
    }
}
