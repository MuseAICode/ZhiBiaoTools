using System.Text.Json;

namespace ZhiBiao.OpenXmlHelper.Tests;

/// <summary>标题编号：小节与样张按文档内计数，整本导出按 Main 给出的 data-app-outline-number。</summary>
public sealed class HeadingNumberingTests : IDisposable
{
    const string JobId = "job-heading";
    readonly TestWorkspace _workspace = new();

    public void Dispose() => _workspace.Dispose();

    // Main 总会发送 page 一节；整本导出按它拆出基础页面设置。
    static JsonElement Format(params object[] headings) => JsonSerializer.SerializeToElement(new { page = new { }, headings });

    List<string> Render(string html, JsonElement format, bool wholeDocument = false)
    {
        _workspace.CreateJob(JobId, new
        {
            action = "render-restricted-html-docx",
            html,
            export_format = format,
            whole_document = wholeDocument,
        });
        var (ok, result) = _workspace.Run(JobId);
        Assert.True(ok, result.ToString());
        using var document = _workspace.OpenOutput(JobId);
        return ExportFormats.TopLevelParagraphTexts(document);
    }

    [Fact]
    public void CustomTemplatesNumberHeadingsInDocumentOrder()
    {
        var format = Format(
            new { numbering_format = "custom", numbering_template = "第{zh}章" },
            new { numbering_format = "custom", numbering_template = "{full}" },
            new { numbering_format = "custom", numbering_template = "（{num}）" });
        var html = "<h1>总体方案</h1><h2>编制依据</h2><h3>法规</h3><h3>标准</h3><h2>工程概况</h2>"
            + "<h1>施工组织</h1><h2>组织机构</h2><p>正文</p>";

        var texts = Render(html, format);

        Assert.Equal(
            ["第一章 总体方案", "1.1 编制依据", "（1）法规", "（2）标准", "1.2 工程概况", "第二章 施工组织", "2.1 组织机构", "正文"],
            texts);
    }

    [Theory]
    [InlineData("{circled}", 3, "③")]
    [InlineData("{alpha}.", 3, "c.")]
    [InlineData("{ALPHA}、", 28, "AB、")]
    [InlineData("{roman}", 4, "iv")]
    [InlineData("{ROMAN}", 9, "IX")]
    [InlineData("第{zh}节", 21, "第二十一节")]
    public void TemplatePlaceholdersFormatTheLastLevel(string template, int count, string expectedPrefix)
    {
        var format = Format(new { numbering_format = "custom", numbering_template = template });
        var html = string.Concat(Enumerable.Range(1, count).Select(index => $"<h1>标题{index}</h1>"));

        var texts = Render(html, format);

        Assert.Equal(count, texts.Count);
        Assert.StartsWith(expectedPrefix, texts[^1]);
        Assert.EndsWith($"标题{count}", texts[^1]);
    }

    [Fact]
    public void OutlineDecimalAndNoneFormats()
    {
        var format = Format(
            new { numbering_format = "outline-decimal" },
            new { numbering_format = "outline-decimal" },
            new { numbering_format = "none" });

        var texts = Render("<h1>概述</h1><h2>范围</h2><h3>细则</h3>", format);

        Assert.Equal(["1 概述", "1.1 范围", "细则"], texts);
    }

    [Fact]
    public void WholeDocumentUsesOutlineNumbersFromMain()
    {
        // 目录标题按 Main 给出的编号；正文内部标题（没有 data-app-outline-number）不参与目录计数，也不编号。
        var format = Format(
            new { numbering_format = "custom", numbering_template = "第{zh}章" },
            new { numbering_format = "custom", numbering_template = "{full}" });
        var html = "<section data-app-export-template=\"true\" data-app-export-page-template=\"true\">"
            + "<h1 data-app-outline-number=\"3\">质量保证</h1>"
            + "<h2>正文内部标题</h2>"
            + "<h2 data-app-outline-number=\"3.2\">检验制度</h2>"
            + "</section>";

        var texts = Render(html, format, wholeDocument: true);

        Assert.Equal(["第三章 质量保证", "正文内部标题", "3.2 检验制度"], texts);
    }

    [Fact]
    public void WholeDocumentBasicRangeKeepsPlainOutlineNumber()
    {
        // 未套用模板样式的范围没有标题格式，直接使用目录编号。
        var format = Format(new { numbering_format = "custom", numbering_template = "第{zh}章" });
        var html = "<section data-app-export-template=\"false\" data-app-export-page-template=\"false\">"
            + "<h1 data-app-outline-number=\"1\">投标函</h1><h2 data-app-outline-number=\"1.1\">承诺</h2>"
            + "</section>";

        var texts = Render(html, format, wholeDocument: true);

        Assert.Equal(["1 投标函", "1.1 承诺"], texts);
    }
}
