// @vitest-environment jsdom
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import MarkdownRenderer from '../../src/shared/ui/MarkdownRenderer';

type RendererProps = Omit<Parameters<typeof MarkdownRenderer>[0], 'children'>;

// 渲染后再解析成 DOM，按元素和属性断言，不依赖序列化细节。
function render(markdown: string, props: RendererProps = {}) {
  const html = renderToStaticMarkup(<MarkdownRenderer {...props}>{markdown}</MarkdownRenderer>);
  const container = document.createElement('div');
  container.innerHTML = html;
  return container;
}

function attributeNames(container: HTMLElement) {
  return Array.from(container.querySelectorAll('*')).flatMap((element) => element.getAttributeNames());
}

describe('MarkdownRenderer：默认禁用原始 HTML', () => {
  it('原始 HTML 按文本显示，不生成元素', () => {
    const container = render('<script>alert(1)</script>\n\n<img src="x" onerror="alert(1)">');

    expect(container.querySelector('script')).toBeNull();
    expect(container.querySelector('img')).toBeNull();
    expect(container.textContent).toContain('<script>alert(1)</script>');
    expect(container.textContent).toContain('<img src="x" onerror="alert(1)">');
  });

  it('仍识别不带属性的 <br> 和 <mark>（表格单元格换行、查错高亮）', () => {
    const container = render('| 列 |\n|---|\n| 第一行<br>第二行 |\n\n查到<mark>错别字</mark>了');

    expect(container.querySelector('td br')).not.toBeNull();
    expect(container.querySelector('mark')?.textContent).toBe('错别字');
  });

  it('带属性的 <mark> 不被识别', () => {
    const container = render('<mark onclick="alert(1)">x</mark>');
    expect(container.querySelector('mark')).toBeNull();
    expect(attributeNames(container)).not.toContain('onclick');
  });

  it('Markdown 链接中的 javascript: 地址不生成可点击链接', () => {
    const container = render('[点我](javascript:alert(1))');
    expect(container.querySelector('a')).toBeNull();
    expect(attributeNames(container)).not.toContain('href');
  });
});

describe('MarkdownRenderer：开启原始 HTML 后仍按白名单清洗', () => {
  const allowRawHtml = true;

  it('script、style、iframe 等标签连同内容一起丢弃', () => {
    const container = render([
      '<div>',
      '<script>window.pwned = 1</script>',
      '<style>body { display: none }</style>',
      '<iframe src="https://evil.example.com"></iframe>',
      '<object data="x"></object><embed src="x">',
      '<template><img src="x"></template>',
      '<textarea>secret</textarea>',
      '正文',
      '</div>',
    ].join('\n'), { allowRawHtml });

    for (const tag of ['script', 'style', 'iframe', 'object', 'embed', 'template', 'textarea']) {
      expect(container.querySelector(tag), tag).toBeNull();
    }
    expect(container.textContent).not.toContain('window.pwned');
    expect(container.textContent).not.toContain('display: none');
    expect(container.textContent).not.toContain('secret');
    expect(container.textContent).toContain('正文');
  });

  it('事件属性、style 和其他未列出的属性一律去掉', () => {
    const container = render(
      '<p onclick="alert(1)" style="position:fixed" data-x="1" id="evil">'
      + '<span onmouseover="alert(1)">a</span>'
      + '<img src="https://img.example.com/a.png" onerror="alert(1)" style="width:9999px">'
      + '</p>',
      { allowRawHtml },
    );

    const names = attributeNames(container);
    for (const name of ['onclick', 'onmouseover', 'onerror', 'style', 'data-x', 'id']) {
      expect(names, name).not.toContain(name);
    }
    expect(container.querySelector('img')?.getAttribute('src')).toBe('https://img.example.com/a.png');
  });

  it('class 只保留白名单内的名字', () => {
    const container = render('<pre><code class="language-js evil-overlay hidden">x</code></pre>', { allowRawHtml });
    expect(container.querySelector('code')?.getAttribute('class')).toBe('language-js');
  });

  it('不在白名单的标签降级为 span，表单等交互元素不保留', () => {
    const container = render('<form action="https://evil.example.com"><button formaction="x">提交</button><input type="text" value="x"></form>', { allowRawHtml });

    expect(container.querySelector('form')).toBeNull();
    expect(container.querySelector('button')).toBeNull();
    expect(container.querySelector('input')).toBeNull();
    expect(container.textContent).toContain('提交');
    expect(attributeNames(container)).not.toContain('action');
  });

  it('链接只允许 http(s)、mailto 和页内锚点', () => {
    const container = render([
      '<a href="https://ok.example.com">https</a>',
      '<a href="mailto:a@example.com">mail</a>',
      '<a href="#section">anchor</a>',
      '<a href=" JavaScript:alert(1)">js</a>',
      '<a href="data:text/html,<script>alert(1)</script>">data</a>',
      '<a href="vbscript:msgbox(1)">vb</a>',
      '<a href="file:///etc/passwd">file</a>',
    ].join(' '), { allowRawHtml });

    const hrefs = Array.from(container.querySelectorAll('a')).map((a) => a.getAttribute('href'));
    expect(hrefs).toEqual(['https://ok.example.com', 'mailto:a@example.com', '#section']);
    expect(container.textContent).toContain('js');
    expect(container.textContent).toContain('file');
  });

  it('外部链接在新窗口打开并带 noreferrer，www. 开头补全为 https', () => {
    const container = render('<a href="www.example.com">site</a>', { allowRawHtml });
    const link = container.querySelector('a');
    expect(link?.getAttribute('href')).toBe('https://www.example.com');
    expect(link?.getAttribute('target')).toBe('_blank');
    expect(link?.getAttribute('rel')).toBe('noreferrer');
  });

  it('图片只允许列出的协议，其余显示为替代文本', () => {
    const container = render([
      '<img src="https://img.example.com/a.png" alt="https">',
      '<img src="app-asset://workspace/a.png" alt="asset">',
      '<img src="data:image/png;base64,AAAA" alt="png">',
      '<img src="data:image/svg+xml;base64,PHN2Zz4=" alt="svg">',
      '<img src="javascript:alert(1)" alt="js">',
      '<img src="file:///C:/secret.png" alt="file">',
    ].join('\n'), { allowRawHtml });

    const sources = Array.from(container.querySelectorAll('img')).map((img) => img.getAttribute('alt'));
    expect(sources).toEqual(['https', 'asset', 'png']);
    expect(container.textContent).toContain('[svg]');
    expect(container.textContent).toContain('[js]');
    expect(container.textContent).toContain('[file]');
  });

  it('图片宽高只接受数字、px 或百分比', () => {
    const container = render(
      '<img src="https://img.example.com/a.png" width="320" height="50%">'
      + '<img src="https://img.example.com/b.png" width="100vw" height="expression(alert(1))">',
      { allowRawHtml },
    );
    const [first, second] = Array.from(container.querySelectorAll('img'));
    expect(first.getAttribute('width')).toBe('320');
    expect(first.getAttribute('height')).toBe('50%');
    expect(second.hasAttribute('width')).toBe(false);
    expect(second.hasAttribute('height')).toBe(false);
  });

  it('本地解析的 HTML 表格保留结构，并包一层横向滚动容器', () => {
    const container = render('<table><thead><tr><th>项</th></tr></thead><tbody><tr><td>值</td></tr></tbody></table>', { allowRawHtml });
    expect(container.querySelector('.markdown-table-scroll > table > tbody > tr > td')?.textContent).toBe('值');
  });
});

describe('MarkdownRenderer：Markdown 结构', () => {
  it('任务列表的复选框只读且禁用', () => {
    const container = render('- [x] 已完成\n- [ ] 未完成');
    const boxes = Array.from(container.querySelectorAll('input[type="checkbox"]')) as HTMLInputElement[];
    expect(boxes).toHaveLength(2);
    expect(boxes.every((box) => box.disabled)).toBe(true);
    expect(boxes.map((box) => box.hasAttribute('checked'))).toEqual([true, false]);
  });

  it('linkMode="text" 时链接显示为文本', () => {
    const container = render('[文档](https://docs.example.com)', { linkMode: 'text' });
    expect(container.querySelector('a')).toBeNull();
    expect(container.textContent?.trim()).toBe('文档');
  });
});
