using System.Text.Json;
using DocumentFormat.OpenXml.Packaging;
using DocumentFormat.OpenXml.Validation;
using Wp = DocumentFormat.OpenXml.Wordprocessing;

namespace ZhiBiao.OpenXmlHelper.Tests;

/// <summary>整本导出的页面范围：data-app-export-page-template 切换时分节，模板页面带页面设置和页眉，基础页面用空页眉页脚阻止继承。</summary>
public sealed class PageRangeTests : IDisposable
{
    const string JobId = "job-pages";
    readonly TestWorkspace _workspace = new();

    public void Dispose() => _workspace.Dispose();

    static readonly JsonElement TemplateFormat = JsonSerializer.SerializeToElement(new
    {
        page = new
        {
            paper_size = "a4",
            orientation = "landscape",
            margin_top_cm = 2.5,
            margin_bottom_cm = 2.5,
            margin_left_cm = 3,
            margin_right_cm = 3,
            header_enabled = true,
            header_text = "智标测试页眉",
            page_number_enabled = true,
            page_number_start = 5,
        },
        image = new { max_width_percent = 90 },
    });

    static string Range(bool template, bool pageTemplate, string inner) =>
        $"<section data-app-export-template=\"{(template ? "true" : "false")}\" data-app-export-page-template=\"{(pageTemplate ? "true" : "false")}\">{inner}</section>";

    WordprocessingDocument Render(string html, JsonElement? format = null)
    {
        _workspace.CreateJob(JobId, new
        {
            action = "render-restricted-html-docx",
            html,
            export_format = format ?? TemplateFormat,
            whole_document = true,
        });
        var (ok, result) = _workspace.Run(JobId);
        Assert.True(ok, result.ToString());
        return _workspace.OpenOutput(JobId);
    }

    static List<Wp.SectionProperties> Sections(WordprocessingDocument document) =>
        document.MainDocumentPart!.Document.Body!.Descendants<Wp.SectionProperties>().ToList();

    static string HeaderText(WordprocessingDocument document, Wp.SectionProperties section)
    {
        var reference = section.Elements<Wp.HeaderReference>().Single(item => item.Type?.Value == Wp.HeaderFooterValues.Default);
        var part = (HeaderPart)document.MainDocumentPart!.GetPartById(reference.Id!.Value!);
        return part.Header!.InnerText;
    }

    [Fact]
    public void PageTemplateSwitchStartsNewSection()
    {
        var html = Range(false, false, "<h1 data-app-outline-number=\"1\">投标函</h1><p>基础页面</p>")
            + Range(true, true, "<h1 data-app-outline-number=\"2\">技术方案</h1><p>模板页面</p>");

        using var document = Render(html);
        var sections = Sections(document);

        Assert.Equal(2, sections.Count);
        var basic = sections[0];
        var template = sections[1];
        Assert.Same(document.MainDocumentPart!.Document.Body!.LastChild, template);

        // 基础页面：沿用纸张、方向和页边距，下一页分节；页码从 page_number_start 开始只写一次；页眉为空，阻止继承。
        Assert.Equal(Wp.SectionMarkValues.NextPage, basic.GetFirstChild<Wp.SectionType>()!.Val!.Value);
        Assert.Equal(Wp.PageOrientationValues.Landscape, basic.GetFirstChild<Wp.PageSize>()!.Orient!.Value);
        Assert.Equal(1701U, basic.GetFirstChild<Wp.PageMargin>()!.Left!.Value);
        Assert.Equal(5, basic.GetFirstChild<Wp.PageNumberType>()!.Start!.Value);
        Assert.Equal("", HeaderText(document, basic));

        // 模板页面：横向、模板页边距、模板页眉，页码不重新开始。
        Assert.Equal(Wp.PageOrientationValues.Landscape, template.GetFirstChild<Wp.PageSize>()!.Orient!.Value);
        Assert.Equal(1701U, template.GetFirstChild<Wp.PageMargin>()!.Left!.Value);
        Assert.Null(template.GetFirstChild<Wp.PageNumberType>());
        Assert.Contains("智标测试页眉", HeaderText(document, template));
    }

    [Fact]
    public void AdjacentRangesWithSamePageTemplateShareOneSection()
    {
        // 正文样式范围不同但页面范围相同：不分节，内容连续。
        var html = Range(true, true, "<h1 data-app-outline-number=\"1\">第一部分</h1><p>甲</p>")
            + Range(false, true, "<h1 data-app-outline-number=\"2\">第二部分</h1><p>乙</p>");

        using var document = Render(html);

        Assert.Single(Sections(document));
        Assert.Equal(["1 第一部分", "甲", "2 第二部分", "乙"], ExportFormats.TopLevelParagraphTexts(document));
    }

    [Fact]
    public void FooterPageNumberOnlyOnTemplatePages()
    {
        var html = Range(false, false, "<p>基础</p>") + Range(true, true, "<p>模板</p>");

        using var document = Render(html);
        var sections = Sections(document);

        Assert.DoesNotContain("PAGE", FooterXml(document, sections[0]));
        Assert.Contains("PAGE", FooterXml(document, sections[1]));
    }

    static string FooterXml(WordprocessingDocument document, Wp.SectionProperties section)
    {
        var reference = section.Elements<Wp.FooterReference>().Single(item => item.Type?.Value == Wp.HeaderFooterValues.Default);
        return ((FooterPart)document.MainDocumentPart!.GetPartById(reference.Id!.Value!)).Footer!.OuterXml;
    }

    [Fact]
    public void WholeDocumentOutputPassesOpenXmlValidation()
    {
        _workspace.WriteJobFile(JobId, "a.png", TestImages.Png(300, 200));
        var html = Range(false, false, "<h1 data-app-outline-number=\"1\">投标函</h1><ol><li>一</li><li>二</li></ol>")
            + Range(true, true,
                "<h1 data-app-outline-number=\"2\">技术方案</h1>"
                + "<figure data-app-size=\"wide\"><img alt=\"图\" data-app-asset-ref=\"a.png\"><figcaption>图 1</figcaption></figure>"
                + "<table data-app-preset=\"imageText\"><tbody><tr><td><figure data-app-size=\"square\"><img alt=\"图\" data-app-asset-ref=\"a.png\"></figure></td><td>说明</td></tr></tbody></table>"
                + "<ul><li>甲</li></ul>");

        using var document = Render(html);

        var errors = new OpenXmlValidator(DocumentFormat.OpenXml.FileFormatVersions.Microsoft365).Validate(document)
            .Select(item => $"{item.Path?.XPath}: {item.Description}")
            .ToList();
        Assert.Empty(errors);
    }
}
