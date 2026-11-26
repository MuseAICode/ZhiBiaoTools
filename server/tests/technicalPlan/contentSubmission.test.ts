// 正文写作阶段的提交校验（路线图第 8 步 8.10c3a，src/technicalPlan/contentSubmission.ts）与桌面版的对照：
// - server/ 不安装 cheerio，桌面版 inspectContentArtifacts 的结果由 fixtures/generateContentSubmissionExpected.mjs 对同一工作区预先生成：
//   各节字数与问题清单（类型、说明、所在小节、能否由修复子任务处理、顺序）须逐条相同；差异只有结果清单不是 JSON 时的固定说明
//   与 Web 版另加的 restricted-html 问题；
// - 修复说明的文字与桌面版 contentGenerationAgent.cjs 的 contentSubmissionInstructions / buildRetryPrompt 相同（核对桌面版源码中的原文）。
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { AGENT_SUBMISSION_MAX_ISSUES, AGENT_SUBMISSION_MAX_MESSAGE_CHARS, assertAgentSubmissionReport } from '../../src/agent/submission.ts';
import {
  CONTENT_SUBMISSION_ISSUES_FILE,
  CONTENT_SUBMISSION_MINIMUM_GOAL,
  contentImagePaths,
  contentImageWorkspacePath,
  contentSubmissionRepair,
  contentSubmissionReport,
  inspectContentSection,
  inspectContentSubmission,
  type ContentSectionIssue,
  type ContentSubmissionFile,
  type ContentSubmissionIssue,
  type ContentSubmissionTarget,
} from '../../src/technicalPlan/contentSubmission.ts';
import { CONTENT_RESULT_FILE } from '../../src/technicalPlan/contentWriting.ts';
import { normalizeSectionHtml, prepareSectionBody, SectionBodyRejectedError } from '../../src/technicalPlan/sectionBodies.ts';

interface Case {
  name: string;
  targets: ContentSubmissionTarget[];
  files: Record<string, string>;
  images: string[];
  dirs: string[];
}
const fixture = JSON.parse(readFileSync(new URL('./fixtures/contentSubmissionCases.json', import.meta.url), 'utf8')) as {
  cases: Case[];
  expected: Record<string, { sections: unknown[]; issues: Record<string, unknown>[] }>;
};
const desktopAgentSource = readFileSync(new URL('../../../client/electron/services/contentGenerationAgent.cjs', import.meta.url), 'utf8');

const file = (content: string): ContentSubmissionFile => ({ size: Buffer.byteLength(content), data: Buffer.from(content, 'utf8') });

/** 与任务的做法相同：读出结果清单与各节 HTML，再按正文中的引用确认哪些图片文件存在（目录不算）。 */
function inspectCase(item: Case) {
  const files = new Map(Object.entries(item.files).map(([path, content]) => [path, file(content)]));
  const wanted = new Set(item.targets.flatMap((target) => (item.files[target.file] !== undefined ? contentImagePaths(item.files[target.file]!) : [])));
  const existingImages = new Set([...wanted].filter((path) => item.images.includes(path)));
  return inspectContentSubmission({ targets: item.targets, files, existingImages });
}

const INVALID_JSON = `${CONTENT_RESULT_FILE} 不是有效 JSON：`;
const GOOD = '<!-- app:block -->\n<p>本节说明施工组织安排。</p>';
const TARGET: ContentSubmissionTarget = { id: 'n-1', number: '1.1', title: '施工组织', file: '正文/n-1.html' };

describe('inspectContentSubmission (desktop parity)', () => {
  it('has a desktop result for every case and the cases cover every desktop issue type', () => {
    expect(Object.keys(fixture.expected).sort()).toEqual(fixture.cases.map((item) => item.name).sort());
    const types = new Set(Object.values(fixture.expected).flatMap((item) => item.issues.map((issue) => issue.type)));
    expect([...types].sort()).toEqual(['content', 'image-ref', 'manifest', 'missing', 'structure']);
    // 对照组：有完全合格的输入。
    expect(fixture.expected['全部合格']!.issues).toEqual([]);
  });

  for (const item of fixture.cases) {
    it(`matches the desktop result: ${item.name}`, () => {
      const expected = fixture.expected[item.name]!;
      const inspected = inspectCase(item);
      expect(inspected.sections).toEqual(expected.sections);
      const desktopIssues = expected.issues.map((issue) =>
        typeof issue.message === 'string' && issue.message.startsWith(INVALID_JSON) ? { ...issue, message: `${CONTENT_RESULT_FILE} 不是有效 JSON，请修正后再次提交` } : issue,
      );
      // JSON 序列化后比较（键的顺序也须相同，供清单文件使用）。
      const own = inspected.issues.filter((issue) => issue.type !== 'restricted-html');
      expect(JSON.stringify(own)).toBe(JSON.stringify(desktopIssues));
    });
  }

  it('does not echo the parse error of an invalid manifest', () => {
    for (const name of ['结果清单不是 JSON', '结果清单带 BOM']) {
      const issues = inspectCase(fixture.cases.find((item) => item.name === name)!).issues;
      expect(issues).toEqual([{ type: 'manifest', severity: 'blocking', file: CONTENT_RESULT_FILE, message: `${CONTENT_RESULT_FILE} 不是有效 JSON，请修正后再次提交` }]);
    }
  });
});

describe('restricted HTML at submission (Web only)', () => {
  const restricted = (name: string) => inspectCase(fixture.cases.find((item) => item.name === name)!).issues.filter((issue) => issue.type === 'restricted-html');

  it('blocks sections the save would reject, with the same issues as the save', () => {
    const html = '<!-- app:block -->\n<p id="s_p001">正文</p><script>alert(1)</script>';
    expect(() => prepareSectionBody(html)).toThrow(SectionBodyRejectedError);
    const issues = inspectContentSection(TARGET, file(html), new Set()).issues;
    expect(issues.map((issue) => [issue.type, issue.message])).toEqual([['restricted-html', '不符合受限 HTML 规范：第 1 块：禁止使用 <script>']]);
    expect(issues[0]).toMatchObject({ section_id: 'n-1', number: '1.1', title: '施工组织', file: TARGET.file, severity: 'blocking', fixable: true });
    expect(restricted('不支持的块标签')[0]!.message).toBe('不符合受限 HTML 规范：第 2 块：不支持块标签 <div>');
    // 桌面版能通过、但缺少规范要求的块 id 的正文同样退回（入库规则比桌面版严格，#118）。
    const noId = inspectContentSection(TARGET, file('<!-- app:block -->\n<p>正文</p>'), new Set()).issues;
    expect(noId.map((issue) => issue.message)).toEqual(['不符合受限 HTML 规范：第 1 块：<p> 缺少合法 id']);
  });

  it('never keeps a leading script (parsed into the document head and dropped, as in the browser)', () => {
    expect(restricted('危险标签')).toEqual([]);
    const html = fixture.cases.find((item) => item.name === '危险标签')!.files[TARGET.file]!;
    expect(html).toContain('<script>');
    expect(normalizeSectionHtml(html)).toBe('<!-- app:block -->\n<p id="s_p001">正文</p>');
  });

  it('lets warning-level cleanup through (links, styles, event attributes are removed when saved)', () => {
    expect(restricted('链接与样式')).toEqual([]);
    const html = fixture.cases.find((item) => item.name === '链接与样式')!.files[TARGET.file]!;
    const saved = normalizeSectionHtml(html);
    expect(saved).not.toMatch(/href|style|onclick|<a\b/);
    expect(saved).toContain('见链接');
  });

  it('reports nothing extra for valid sections and for blank files (already a content issue)', () => {
    for (const name of ['全部合格', '配图引用存在', '配图文件不存在', '配图尚未生成', '链接与样式']) expect(restricted(name)).toEqual([]);
    const blank = inspectContentSection(TARGET, file('  \n'), new Set());
    expect(blank.issues.map((issue) => issue.type)).toEqual(['content']);
  });

  it('accepts workspace image paths before the images become artifacts', () => {
    expect(restricted('配图引用存在')).toEqual([]);
    expect(restricted('配图引用规范化后存在')).toEqual([]);
  });

  it('blocks sections whose normalized body exceeds the per-section limit', () => {
    const html = `<!-- app:block -->\n<p id="s_p001">${'字'.repeat(800 * 1024)}</p>`;
    const issues = inspectContentSection(TARGET, file(html), new Set()).issues;
    expect(issues.map((issue) => [issue.type, issue.message])).toEqual([['restricted-html', '不符合受限 HTML 规范：正文超过 2 MiB']]);
  });
});

describe('files that could not be read', () => {
  it('treats an oversized section or manifest as a blocking issue', () => {
    const big = { size: 32 * 1024 * 1024, data: null };
    const inspected = inspectContentSubmission({ targets: [TARGET], files: new Map([[CONTENT_RESULT_FILE, big], [TARGET.file, big]]), existingImages: new Set() });
    expect(inspected.sections).toEqual([{ section_id: 'n-1', number: '1.1', title: '施工组织', file: TARGET.file, words: 0 }]);
    expect(inspected.issues.map((issue) => [issue.type, issue.message])).toEqual([
      ['manifest', `${CONTENT_RESULT_FILE} 过大，无法读取`],
      ['too-large', '小节 HTML 文件过大，无法读取'],
    ]);
    expect((inspected.issues[1] as ContentSectionIssue).fixable).toBe(false);
  });
});

describe('image paths', () => {
  it('accepts only forward-slash relative paths inside the workspace (desktop resolveImageWorkspaceFile) and normalizes them', () => {
    expect(contentImageWorkspacePath('图片/a.png')).toBe('图片/a.png');
    expect(contentImageWorkspacePath('./图片//a.png')).toBe('图片/a.png');
    expect(contentImageWorkspacePath('图片/./b/../a.png')).toBe(null);
    for (const bad of ['', '../a.png', '图片/../../a.png', '/etc/passwd', 'C:/a.png', 'https://x/a.png', 'data:image/png;base64,AA', '图片\\a.png']) {
      expect(contentImageWorkspacePath(bad), bad).toBe(null);
    }
  });

  it('collects every valid reference, including images inside templates, once', () => {
    const html = '<!-- app:block -->\n<p>正文</p><figure><img data-app-asset-ref="图片/a.png" alt="a"><img data-app-asset-ref="./图片/a.png" alt="b"></figure><template><img data-app-asset-ref="图片/t.png"></template><img data-app-asset-ref="../x.png"><img alt="未生成">';
    expect(contentImagePaths(html)).toEqual(['图片/a.png', '图片/t.png']);
  });

  it('stops at the first unusable image like the desktop', () => {
    const html = '<!-- app:block -->\n<p>正文</p><figure data-app-size="wide"><img data-app-asset-ref="图片/missing.png" alt="一"></figure><figure data-app-size="wide"><img alt="二"></figure>';
    const issues = inspectContentSection(TARGET, file(html), new Set()).issues.filter((issue) => issue.type === 'image-ref');
    expect(issues.map((issue) => issue.message)).toEqual(['正文引用的图片文件不存在：图片/missing.png']);
  });
});

describe('contentSubmissionReport', () => {
  it('passes the section word counts when there are no issues', () => {
    const inspected = inspectCase(fixture.cases.find((item) => item.name === '全部合格')!);
    const report = contentSubmissionReport(inspected);
    expect(report).toEqual({ value: { sections: inspected.sections }, issues: [], minimumGoal: CONTENT_SUBMISSION_MINIMUM_GOAL });
    expect(desktopAgentSource).toContain(`minimumGoal: '${CONTENT_SUBMISSION_MINIMUM_GOAL}'`);
  });

  it('lists every issue message in order and has no value', () => {
    const inspected = inspectCase(fixture.cases.find((item) => item.name === '两节都有问题')!);
    const report = contentSubmissionReport(inspected);
    expect(report.value).toBe(null);
    expect(report.issues).toEqual(inspected.issues.map((issue) => ({ severity: 'blocking', message: issue.message })));
    assertAgentSubmissionReport(report);
  });

  it('keeps the report within the submission limits', () => {
    const issues: ContentSubmissionIssue[] = Array.from({ length: AGENT_SUBMISSION_MAX_ISSUES + 50 }, (_, index) => ({
      type: 'manifest', severity: 'blocking', file: CONTENT_RESULT_FILE, message: `问题 ${index} ${'长'.repeat(index === 0 ? 5000 : 1)}`,
    }));
    const report = contentSubmissionReport({ sections: [], issues });
    assertAgentSubmissionReport(report);
    expect(report.issues).toHaveLength(AGENT_SUBMISSION_MAX_ISSUES);
    expect(report.issues[0]!.message).toHaveLength(AGENT_SUBMISSION_MAX_MESSAGE_CHARS);
    expect(report.issues[0]!.message.endsWith('…')).toBe(true);
    expect(report.issues.at(-1)).toEqual({ severity: 'blocking', message: `另有 51 项问题未在此列出，小节问题的完整清单见 ${CONTENT_SUBMISSION_ISSUES_FILE}` });
    // 恰好在上限时不加说明。
    expect(contentSubmissionReport({ sections: [], issues: issues.slice(0, AGENT_SUBMISSION_MAX_ISSUES) }).issues).toHaveLength(AGENT_SUBMISSION_MAX_ISSUES);
    expect(contentSubmissionReport({ sections: [], issues: issues.slice(0, AGENT_SUBMISSION_MAX_ISSUES) }).issues.at(-1)!.message).toMatch(/^问题 199/);
  });
});

/** 问题在本模块结果中的位置（按 JSON 比较），用于把桌面版的问题与 Web 版另加的问题按同一顺序合并。 */
const order = (issues: readonly ContentSubmissionIssue[], issue: unknown): number => issues.findIndex((own) => JSON.stringify(own) === JSON.stringify(issue));

describe('contentSubmissionRepair (desktop wording)', () => {
  const sectionIssue = (id: string, fixable = true): ContentSectionIssue => ({
    section_id: id, title: `标题 ${id}`, file: `正文/${id}.html`, type: fixable ? 'structure' : 'missing', severity: 'blocking', message: '问题', fixable,
  });
  const manifestIssue: ContentSubmissionIssue = { type: 'manifest', severity: 'blocking', file: CONTENT_RESULT_FILE, message: `${CONTENT_RESULT_FILE} 尚未生成` };
  const SUFFIX = ' 保留已完成内容，不重新执行已结束阶段；本轮处理后重新提交，由程序判断是否继续。';

  it('uses the desktop texts', () => {
    for (const text of [
      '按问题说明修正当前结果，保留已完成内容和当前阶段范围。',
      SUFFIX.trim(),
      '由你直接修改对应小节',
      '，修复后重新提交。图片块按清单中的原始图片块恢复，保留文字修改。',
      '，正文或图片文件缺失等子任务无法处理的问题由你直接处理',
      '出现异常结束标记的小节多为写作输出中断，在生成任务文件中给该节加 "regenerate": true 重新生成。',
      "const STRUCTURE_RULE = '除 img 等空元素外，每个元素都写出对应的结束标签；每个 figure 以 </figure> 结束并直接包含一个 img，figure 不放在段落、列表项或加粗、链接等行内元素中。'",
    ]) {
      expect(desktopAgentSource, text).toContain(text);
    }
  });

  it('gives the generic instruction without section issues', () => {
    expect(contentSubmissionRepair([manifestIssue], { mode: 'normal', protectionActive: false })).toEqual({
      prompt: `本次结果文件：${CONTENT_RESULT_FILE}。按问题说明修正当前结果，保留已完成内容和当前阶段范围。${SUFFIX}`,
      issuesFile: null,
    });
  });

  it('asks the Agent to edit directly up to five sections and writes only the section issues', () => {
    const issues = [manifestIssue, ...['a', 'b', 'c', 'd', 'e'].map((id) => sectionIssue(id)), sectionIssue('a')];
    const repair = contentSubmissionRepair(issues, { mode: 'normal', protectionActive: false });
    expect(repair.prompt).toBe(
      `本次结果文件：${CONTENT_RESULT_FILE}。完整小节问题见 ${CONTENT_SUBMISSION_ISSUES_FILE}。由你直接修改对应小节，修复后重新提交。图片块按清单中的原始图片块恢复，保留文字修改。` +
        '除 img 等空元素外，每个元素都写出对应的结束标签；每个 figure 以 </figure> 结束并直接包含一个 img，figure 不放在段落、列表项或加粗、链接等行内元素中。' +
        `出现异常结束标记的小节多为写作输出中断，在生成任务文件中给该节加 "regenerate": true 重新生成。${SUFFIX}`,
    );
    expect(repair.issuesFile).toEqual({ path: CONTENT_SUBMISSION_ISSUES_FILE, content: JSON.stringify({ issues: issues.slice(1) }, null, 2) });
  });

  it('routes more than five sections to fix-submission-issues and mentions manual issues', () => {
    const ids = ['a', 'b', 'c', 'd', 'e', 'f'];
    const all = contentSubmissionRepair(ids.map((id) => sectionIssue(id)), { mode: 'normal', protectionActive: true });
    expect(all.prompt).toContain('涉及小节超过 5 个，调用 fix-submission-issues 并发修复，修复后重新提交。');
    expect(all.prompt).not.toContain('regenerate');
    const manual = contentSubmissionRepair([...ids.map((id) => sectionIssue(id)), sectionIssue('g', false)], { mode: 'change-strategy', protectionActive: false });
    expect(manual.prompt).toContain('涉及小节超过 5 个，调用 fix-submission-issues 并发修复，正文或图片文件缺失等子任务无法处理的问题由你直接处理，修复后重新提交。');
  });

  it('writes the issue list in the desktop shape (fixture issues serialized as-is)', () => {
    for (const name of ['小节文件不存在', '配图文件不存在', '小节缺少结束标签']) {
      const inspected = inspectCase(fixture.cases.find((item) => item.name === name)!);
      const repair = contentSubmissionRepair(inspected.issues, { mode: 'minimum', protectionActive: false });
      const desktop = fixture.expected[name]!.issues;
      const own = inspected.issues.filter((issue) => issue.type === 'restricted-html');
      expect(repair.issuesFile!.content, name).toBe(JSON.stringify({ issues: [...desktop, ...own].sort((a, b) => order(inspected.issues, a) - order(inspected.issues, b)) }, null, 2));
    }
  });
});
