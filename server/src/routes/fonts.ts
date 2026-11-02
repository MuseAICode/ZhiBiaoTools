// 字体接口（路线图第 7 步 7.2）。需要登录。
//
// GET /api/fonts：导出模板可选的字体名 { fonts: string[] }，固定清单（src/templates/fonts.ts），不是服务器上安装的字体，
//   不随用户或组织变化。取代桌面版的 systemFonts.list。
import type { FastifyInstance } from 'fastify';
import { TEMPLATE_FONT_NAMES } from '../templates/fonts.ts';

const RESPONSE_SCHEMA = {
  type: 'object',
  properties: { fonts: { type: 'array', items: { type: 'string' } } },
  required: ['fonts'],
  additionalProperties: false,
} as const;

export async function registerFontRoutes(app: FastifyInstance): Promise<void> {
  app.get('/', { schema: { response: { 200: RESPONSE_SCHEMA } } }, async (_request, reply) => {
    // 与其他需要登录的接口相同，不缓存。
    reply.header('cache-control', 'no-store');
    return { fonts: TEMPLATE_FONT_NAMES };
  });
}
