using System.Text.Json;
using DocumentFormat.OpenXml.Packaging;
using Wp = DocumentFormat.OpenXml.Wordprocessing;

namespace ZhiBiao.OpenXmlHelper.Tests;

/// <summary>测试用的导出模板配置与 Word 读取工具。</summary>
static class ExportFormats
{
    /// <summary>只给出图片最大宽度，其余按渲染器默认值（A4 纵向、页边距 2 cm）。</summary>
    public static JsonElement Default() => JsonSerializer.SerializeToElement(new
    {
        image = new { max_width_percent = 90 },
    });

    /// <summary>A4 纵向时正文宽度：页宽减左右页边距（twips），换算为 EMU。</summary>
    public static long ContentWidthEmus(Wp.SectionProperties section)
    {
        var page = section.GetFirstChild<Wp.PageSize>()!;
        var margin = section.GetFirstChild<Wp.PageMargin>()!;
        return ((long)page.Width!.Value - margin.Left!.Value - margin.Right!.Value) * 635L;
    }

    public static Wp.SectionProperties LastSection(WordprocessingDocument document)
    {
        return document.MainDocumentPart!.Document.Body!.Elements<Wp.SectionProperties>().Single();
    }

    /// <summary>正文顶层段落的文字（不含表格内段落）。</summary>
    public static List<string> TopLevelParagraphTexts(WordprocessingDocument document)
    {
        return document.MainDocumentPart!.Document.Body!.Elements<Wp.Paragraph>()
            .Select(item => item.InnerText)
            .Where(item => item.Length > 0)
            .ToList();
    }
}
