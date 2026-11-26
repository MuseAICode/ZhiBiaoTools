// generate-sections 的测试材料（tests/technicalPlan/contentSectionGeneration.test.ts 与 tests/db/generateSections.test.ts 共用）：
// 一个一级标题下 12 个 AI 小节，不配图、不要求表格。
import { collectAiLeaves, type StoredContentPlan } from '../../src/technicalPlan/contentPlanning.ts';
import { contentSectionWritingMaterials } from '../../src/technicalPlan/contentSectionWriting.ts';
import { buildContentWritingFiles, type ContentWritingFilesInput } from '../../src/technicalPlan/contentWriting.ts';
import type { TechnicalPlanOutlineItem } from '../../src/technicalPlan/outline.ts';

export const LEAF = (n: number) => `00000000-0000-4000-8000-0000000000${String(n).padStart(2, '0')}`;
export const COUNT = 12;
export const OUTLINE: TechnicalPlanOutlineItem[] = [
  {
    id: '00000000-0000-4000-8000-0000000000a1',
    number: '1',
    title: '总体设计',
    description: '总体',
    children: Array.from({ length: COUNT }, (_, index) => ({ id: LEAF(index + 1), number: `1.${index + 1}`, title: `第 ${index + 1} 节`, description: '', content_mode: 'ai-generate' as const })),
  },
];
export const LEAVES = collectAiLeaves(OUTLINE);
export const PLANS: Record<string, StoredContentPlan> = Object.fromEntries(
  LEAVES.map(({ item }, index) => [
    item.id,
    {
      plan_version: 6,
      table_requirement: 'light',
      plan: {
        writing_focus: `第 ${index + 1} 节的写作重点`,
        target_words: 800,
        image_suitability_score: 0,
        image_needed: false,
        knowledge: { item_ids: [] },
        table: { needed: false, purpose: '' },
        original_material: { restored: false, optimized: false, source_hash: '', source_ranges: [], restored_words: 0 },
      } as StoredContentPlan['plan'],
    },
  ]),
);
export const INPUT: ContentWritingFilesInput = {
  outline: OUTLINE,
  targets: LEAVES,
  plans: PLANS,
  sectionStates: {},
  checkTotalWords: true,
  projectOverview: '某市智慧水务平台建设',
  globalFacts: [{ title: '工期', content: '180 天' }],
  globalFactsMode: 'omit',
  wordControl: { minimumWords: 3000, maximumWords: 6000, sectionWords: 1500 },
  generationOptions: {
    imageQuantity: 0,
    useAiImages: false,
    useMermaidImages: false,
    useHtmlImages: false,
    htmlImageTypes: '',
    useSingleImageLayout: true,
    useImageTextLayout: false,
    useThreeImagesLayout: false,
    useFourImagesLayout: false,
    tableRequirement: 'light',
  },
  requirement: '',
  template: { id: '00000000-0000-4000-8000-0000000000ee', name: '标准投标', isSystem: true, config: {}, createdAt: new Date(0), updatedAt: new Date(0) },
  documentIds: [],
  knowledgeDocuments: [],
};
export const MATERIALS = contentSectionWritingMaterials(buildContentWritingFiles(INPUT));
