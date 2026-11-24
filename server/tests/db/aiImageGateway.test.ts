// AI 网关的生图调用（src/ai/images.ts、迁移 0045_ai_image_generation，路线图第 8 步 8.9）对真实数据库与本机模拟服务商的集成测试：
// 按张冻结与结算、只按入库的张数收费、计入任务费用上限、步骤幂等、服务商失败 / 图片无效 / 取消 / 平台一侧失败都不收费、
// 模型类别与价格形状、网址下载的防护、Key 与提示词不进日志，以及 worker 一侧的入库（src/render/generatedImages.ts：
// 经 render-html 沙箱转 PNG、按上传图片的规则校验、写成图片产物；沙箱用假驱动，真实转换由 renderHtmlEntry / Docker 测试覆盖）。
import { execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import https from 'node:https';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import Fastify from 'fastify';
import { sql, type Kysely } from 'kysely';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { putCredential } from '../../src/ai/credentials.ts';
import { createAiGateway, createAiImageGateway } from '../../src/ai/gateway.ts';
import { MAX_IMAGES_PER_CALL, type AiImageGateway, type ImageOptions, type ImageRequest, type ProviderImage } from '../../src/ai/images.ts';
import { createFileKeyWrapper } from '../../src/ai/keyring.ts';
import { listModels, registerImageModel, registerModel, setModelEnabled } from '../../src/ai/models.ts';
import { addImagePrice, addModelPrice, chargeUsage, creditOrganization } from '../../src/billing/ledger.ts';
import { beginImageUsage, getAvailableBalance, settleUsage } from '../../src/billing/usage.ts';
import { migrateToLatest } from '../../src/db/migrator.ts';
import type { Database } from '../../src/db/schema.ts';
import { withTenant, type TenantContext } from '../../src/db/tenant.ts';
import { AppError } from '../../src/errors.ts';
import type { ObjectStore } from '../../src/files/objectStore.ts';
import { createLoggerOptions } from '../../src/logger.ts';
import { sniffGeneratedImage, storeGeneratedImages } from '../../src/render/generatedImages.ts';
import type { SandboxFile } from '../../src/sandbox/archive.ts';
import type { SandboxDriver, SandboxExecResult, SandboxRef } from '../../src/sandbox/driver.ts';
import { startMockProvider, type MockProvider } from '../ai/mockProvider.ts';
import { createLogCapture } from '../helpers.ts';
import { connect, createTestDatabase, type TestDatabase } from './harness.ts';

const API_KEY = `sk-image-${randomBytes(16).toString('hex')}`;
const keyWrapper = createFileKeyWrapper(randomBytes(32), 1);
/** qwen-image：每张 0.2 元（2000 计费单位），上游成本每张 0.1 元。 */
const IMAGE_PRICE = 2_000n;
const UPSTREAM_IMAGE_PRICE = 1_000n;
const PROMPT = '一张变电站施工现场的示意图，不要文字。';

let testDb: TestDatabase;
let appDb: Kysely<Database>;
let superuser: Kysely<any>;
let provider: MockProvider;
let gateway: AiImageGateway;
let logs: ReturnType<typeof createLogCapture>;
let imageServer: https.Server;
let imagePort: number;
let ca: Buffer;
const imageSockets = new Set<import('node:stream').Duplex>();
let imageRequests: { path: string; authorization: string | undefined }[] = [];

const platformOrg = randomUUID();
const platformAdmin = randomUUID();
const ctxAdmin: TenantContext = { orgId: platformOrg, userId: platformAdmin, role: 'owner' };

function fakePng(width: number, height: number): Buffer {
  const ihdr = Buffer.alloc(25);
  ihdr.writeUInt32BE(13, 0);
  ihdr.write('IHDR', 4, 'latin1');
  ihdr.writeUInt32BE(width, 8);
  ihdr.writeUInt32BE(height, 12);
  ihdr.writeUInt8(8, 16);
  ihdr.writeUInt8(6, 17);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), ihdr]);
}
const PNG_B64 = fakePng(64, 64).toString('base64');

function imageRequest(overrides: Partial<ImageRequest> = {}): ImageRequest {
  return { provider: 'qwen', model: 'qwen-image', prompt: PROMPT, count: 2, size: '1024x1024', source: 'interactive', ...overrides };
}

/** 假的入库：服务商的每张图都算入库成功（或按 accept 过滤），返回随机的产物编号。 */
function stubStore(accept: (image: ProviderImage) => boolean = () => true) {
  const received: ProviderImage[][] = [];
  const discarded: string[][] = [];
  const options: ImageOptions = {
    async store(images) {
      received.push([...images]);
      const verdicts = images.map(accept);
      const stored = verdicts.filter(Boolean).map(() => ({ artifactId: randomUUID(), width: 64, height: 64 }));
      return { stored, failures: verdicts.filter((ok) => !ok).map(() => 'image_invalid' as const) };
    },
    async discard(ids) {
      discarded.push([...ids]);
    },
    downloadCa: ca,
  };
  return { options, received, discarded };
}

function respondImages(data: unknown[], status = 200) {
  provider.setHandler((_request, response) => {
    response.writeHead(status, { 'content-type': 'application/json' });
    response.end(JSON.stringify(status === 200 ? { created: 1, data } : { error: { code: 'bad_request', message: '提示词被拒绝' } }));
  });
}

let orgCounter = 0;
async function newOrg(balance = 0n): Promise<TenantContext> {
  const orgId = randomUUID();
  const userId = randomUUID();
  orgCounter += 1;
  await superuser.insertInto('organizations').values({ id: orgId, name: `生图组织 ${orgCounter}`, kind: 'personal' }).execute();
  await superuser.insertInto('users').values({ id: userId, email: `img${orgCounter}-${userId.slice(0, 8)}@example.com`, password_hash: 'x' }).execute();
  await superuser.insertInto('org_memberships').values({ org_id: orgId, user_id: userId, role: 'owner' }).execute();
  if (balance > 0n) await creditOrganization(appDb, ctxAdmin, { orgId, type: 'recharge', amount: balance, reference: null, note: '测试充值' });
  return { orgId, userId, role: 'owner' };
}

async function usageRows(orgId: string): Promise<any[]> {
  return superuser.selectFrom('usage_records').selectAll().where('org_id', '=', orgId).orderBy('started_at').execute();
}

async function chargesOf(orgId: string): Promise<any[]> {
  return superuser.selectFrom('billing_ledger').selectAll().where('org_id', '=', orgId).where('entry_type', '=', 'charge').execute();
}

async function expectAppError(promise: Promise<unknown>, status: number, code: string): Promise<AppError> {
  const error = await promise.then(() => null, (caught: unknown) => caught);
  expect(error).toBeInstanceOf(AppError);
  expect(error).toMatchObject({ statusCode: status, code });
  return error as AppError;
}

async function expectUnbilled(ctx: TenantContext, balance: bigint, reason: string) {
  const rows = await usageRows(ctx.orgId);
  expect(rows.at(-1)).toMatchObject({ unit: 'image', status: 'unbilled', failure_reason: reason, amount: '0' });
  expect(await chargesOf(ctx.orgId)).toEqual([]);
  expect(await getAvailableBalance(appDb, ctx)).toEqual({ balance, held: 0n, available: balance });
}

async function runningJob(ctx: TenantContext, costLimit: bigint | null): Promise<string> {
  const id = randomUUID();
  await superuser.insertInto('jobs').values({
    id, org_id: ctx.orgId, user_id: ctx.userId, type: 'test-image-job', status: 'running', run_id: randomUUID(),
    lease_expires_at: new Date(Date.now() + 60_000), started_at: new Date(),
  }).execute();
  if (costLimit !== null) {
    await superuser.insertInto('agent_job_budgets').values({ org_id: ctx.orgId, job_id: id, cost_limit: costLimit.toString(), turn_limit: 100 }).execute();
  }
  return id;
}

beforeAll(async () => {
  testDb = await createTestDatabase();
  const owner = connect(testDb.ownerConfig);
  try {
    expect((await migrateToLatest(owner)).error).toBeUndefined();
  } finally {
    await owner.destroy();
  }
  superuser = testDb.admin;
  await superuser.insertInto('organizations').values({ id: platformOrg, name: '平台', kind: 'personal' }).execute();
  await superuser.insertInto('users').values({ id: platformAdmin, email: 'image-admin@example.com', password_hash: 'x', is_platform_admin: true }).execute();
  await superuser.insertInto('org_memberships').values({ org_id: platformOrg, user_id: platformAdmin, role: 'owner' }).execute();
  appDb = connect<Database>(testDb.appConfig, 20);

  // 生图模型、按张的价格；文本模型 qwen-plus 用来核对类别不能混用；免费的生图模型。
  const image = await registerImageModel(appDb, ctxAdmin, { provider: 'qwen', model: 'qwen-image', isFree: false, note: null });
  await setModelEnabled(appDb, ctxAdmin, image.id, true);
  await addImagePrice(appDb, ctxAdmin, { orgId: null, provider: 'qwen', model: 'qwen-image', imagePrice: IMAGE_PRICE, effectiveFrom: null, note: null, upstreamImagePrice: UPSTREAM_IMAGE_PRICE });
  const text = await registerModel(appDb, ctxAdmin, { provider: 'qwen', model: 'qwen-plus', isFree: false, note: null });
  await setModelEnabled(appDb, ctxAdmin, text.id, true);
  await addModelPrice(appDb, ctxAdmin, { orgId: null, provider: 'qwen', model: 'qwen-plus', inputPricePerMtok: 8000n, outputPricePerMtok: 20000n, effectiveFrom: null, note: null });
  const free = await registerImageModel(appDb, ctxAdmin, { provider: 'qwen', model: 'free-image', isFree: true, note: null });
  await setModelEnabled(appDb, ctxAdmin, free.id, true);
  await addImagePrice(appDb, ctxAdmin, { orgId: null, provider: 'qwen', model: 'free-image', imagePrice: 0n, effectiveFrom: null, note: null });

  provider = await startMockProvider(API_KEY);
  await putCredential(appDb, ctxAdmin, keyWrapper, { kind: 'image_model', provider: 'qwen', baseUrl: provider.baseUrl, apiKey: API_KEY });
  // 文本凭据用另一个 Key，核对生图只用 image_model 的凭据。
  await putCredential(appDb, ctxAdmin, keyWrapper, { kind: 'text_model', provider: 'qwen', baseUrl: provider.baseUrl, apiKey: `${API_KEY}-text` });

  // 模拟服务商的图片地址（https，自签名证书）。
  const dir = mkdtempSync(path.join(tmpdir(), 'image-gateway-'));
  try {
    execFileSync('openssl', [
      'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=127.0.0.1',
      '-addext', 'subjectAltName=IP:127.0.0.1', '-keyout', path.join(dir, 'key.pem'), '-out', path.join(dir, 'cert.pem'),
    ], { stdio: 'ignore' });
    ca = readFileSync(path.join(dir, 'cert.pem'));
    imageServer = https.createServer({ key: readFileSync(path.join(dir, 'key.pem')), cert: ca }, (req, res) => {
      imageRequests.push({ path: req.url ?? '', authorization: req.headers.authorization });
      if (req.url === '/redirect.png') {
        res.writeHead(302, { location: '/image.png' });
        res.end();
        return;
      }
      res.writeHead(200, { 'content-type': 'image/png' });
      res.end(fakePng(32, 32));
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  imageServer.on('connection', (socket) => {
    imageSockets.add(socket);
    socket.on('close', () => imageSockets.delete(socket));
  });
  imageServer.listen(0, '127.0.0.1');
  await once(imageServer, 'listening');
  imagePort = (imageServer.address() as AddressInfo).port;

  logs = createLogCapture();
  const log = Fastify({ logger: createLoggerOptions({ level: 'info', stream: logs.stream }) }).log;
  gateway = createAiImageGateway({
    db: appDb,
    keyWrapper,
    settings: { imageUpstreamTimeoutMs: 2_000, imageDownloadTimeoutMs: 1_000, imageHoldTtlSeconds: 60, upstreamPrivateHosts: ['127.0.0.1'] },
    log,
  });
});

afterAll(async () => {
  for (const socket of imageSockets) socket.destroy();
  imageServer?.close();
  await provider?.close();
  await appDb?.destroy();
  await testDb?.drop();
});

beforeEach(() => {
  provider.reset();
  imageRequests = [];
  respondImages([{ b64_json: PNG_B64 }, { b64_json: PNG_B64 }]);
});

describe('按张冻结与结算', () => {
  it('冻结“请求张数 × 单价”，按入库的张数扣费；用量记录的单位是 image，上游成本按张计算', async () => {
    const ctx = await newOrg(100_000n);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let received!: () => void;
    const arrived = new Promise<void>((resolve) => (received = resolve));
    provider.setHandler(async (_request, response) => {
      received();
      await gate;
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ data: [{ b64_json: PNG_B64 }, { b64_json: PNG_B64 }, { b64_json: PNG_B64 }] }));
    });
    const store = stubStore();
    const call = gateway.generate(ctx, imageRequest({ count: 3 }), store.options);
    await arrived;
    expect(await getAvailableBalance(appDb, ctx)).toEqual({ balance: 100_000n, held: 3n * IMAGE_PRICE, available: 100_000n - 3n * IMAGE_PRICE });
    const [pending] = await usageRows(ctx.orgId);
    expect(pending).toMatchObject({ unit: 'image', status: 'pending', estimated_input_tokens: '0', max_output_tokens: '3', hold_amount: String(3n * IMAGE_PRICE) });
    // 发给服务商的只有已校验的字段，Key 是生图凭据的。
    expect(provider.requests[0]).toMatchObject({ path: '/v1/images/generations', authorization: `Bearer ${API_KEY}` });
    expect(provider.requests[0]!.body).toEqual({ model: 'qwen-image', prompt: PROMPT, n: 3, size: '1024x1024' });
    release();

    const result = await call;
    expect(result).toMatchObject({ reused: false, failures: [], billing: { status: 'billed', amount: 3n * IMAGE_PRICE, images: 3 } });
    expect(result.images).toHaveLength(3);
    expect(store.received[0]!.map((image) => image.data.equals(fakePng(64, 64)))).toEqual([true, true, true]);
    const [record] = await usageRows(ctx.orgId);
    expect(record).toMatchObject({ unit: 'image', status: 'billed', input_tokens: '0', output_tokens: '3', amount: String(3n * IMAGE_PRICE), upstream_cost: String(3n * UPSTREAM_IMAGE_PRICE) });
    const [charge] = await chargesOf(ctx.orgId);
    expect(charge).toMatchObject({ amount: String(-3n * IMAGE_PRICE), input_tokens: '0', output_tokens: '3', usage_id: record.id, model: 'qwen-image' });
    expect(await getAvailableBalance(appDb, ctx)).toEqual({ balance: 100_000n - 3n * IMAGE_PRICE, held: 0n, available: 100_000n - 3n * IMAGE_PRICE });
  });

  it('只按成功入库的张数收费：服务商返回 2 张、入库 1 张，扣 1 张的钱，多余的冻结释放', async () => {
    const ctx = await newOrg(100_000n);
    let first = true;
    const store = stubStore(() => {
      const keep = first;
      first = false;
      return keep;
    });
    const result = await gateway.generate(ctx, imageRequest(), store.options);
    expect(result).toMatchObject({ failures: ['image_invalid'], billing: { status: 'billed', amount: IMAGE_PRICE, images: 1 } });
    expect(await usageRows(ctx.orgId)).toMatchObject([{ status: 'billed', output_tokens: '1', amount: String(IMAGE_PRICE) }]);
    expect(await getAvailableBalance(appDb, ctx)).toMatchObject({ balance: 100_000n - IMAGE_PRICE, held: 0n });
  });

  it('服务商多给的图片丢弃，不入库、不收费；缺图与坏 base64 只让该张失败', async () => {
    const ctx = await newOrg(100_000n);
    respondImages([{ b64_json: PNG_B64 }, { b64_json: '***not base64***' }, {}, { b64_json: PNG_B64 }]);
    const store = stubStore();
    const result = await gateway.generate(ctx, imageRequest({ count: 3 }), store.options);
    expect(store.received[0]).toHaveLength(1);
    expect(result).toMatchObject({ failures: ['image_invalid', 'image_missing'], billing: { amount: IMAGE_PRICE, images: 1 } });
  });

  it('免费的生图模型不扣费；未标记免费的零价格按未定价拒绝', async () => {
    const ctx = await newOrg();
    const result = await gateway.generate(ctx, imageRequest({ model: 'free-image', count: 1 }), stubStore().options);
    expect(result.billing).toMatchObject({ status: 'billed', amount: 0n, images: 1 });

    const unfree = await registerImageModel(appDb, ctxAdmin, { provider: 'qwen', model: 'zero-image', isFree: false, note: null });
    await setModelEnabled(appDb, ctxAdmin, unfree.id, true);
    await addImagePrice(appDb, ctxAdmin, { orgId: null, provider: 'qwen', model: 'zero-image', imagePrice: 0n, effectiveFrom: null, note: null });
    provider.reset();
    await expectAppError(gateway.generate(ctx, imageRequest({ model: 'zero-image' }), stubStore().options), 503, 'MODEL_PRICE_NOT_CONFIGURED');
    expect(provider.requests).toHaveLength(0);
  });
});

describe('不收费的情形', () => {
  it('余额不足以冻结：不调用服务商', async () => {
    const ctx = await newOrg(IMAGE_PRICE);
    await expectAppError(gateway.generate(ctx, imageRequest(), stubStore().options), 402, 'INSUFFICIENT_BALANCE');
    expect(provider.requests).toHaveLength(0);
    expect(await usageRows(ctx.orgId)).toEqual([]);
  });

  it.each([
    ['服务商返回错误', () => respondImages([], 400), 502, 'AI_UPSTREAM_ERROR', 'upstream_error'],
    ['响应不是 JSON', () => provider.setHandler((_q, r) => void r.end('<html>')), 502, 'AI_UPSTREAM_ERROR', 'invalid_upstream_response'],
    ['响应没有 data', () => provider.setHandler((_q, r) => void r.end('{"created":1}')), 502, 'AI_UPSTREAM_ERROR', 'invalid_upstream_response'],
    ['服务商超时', () => provider.setHandler(() => {}), 504, 'AI_UPSTREAM_TIMEOUT', 'upstream_timeout'],
    ['服务商跳转', () => provider.setHandler((_q, r) => { r.writeHead(302, { location: 'http://127.0.0.1:1/' }); r.end(); }), 502, 'AI_UPSTREAM_ERROR', 'upstream_error'],
    ['图片全部无效', () => respondImages([{ b64_json: '%%%%' }, {}]), 502, 'AI_IMAGE_INVALID', 'invalid_upstream_response'],
  ])('%s：冻结全额释放', async (_name, setup, status, code, reason) => {
    const ctx = await newOrg(100_000n);
    setup();
    const store = stubStore();
    await expectAppError(gateway.generate(ctx, imageRequest(), store.options), status, code);
    await expectUnbilled(ctx, 100_000n, reason);
    if (code !== 'AI_UPSTREAM_TIMEOUT') expect(store.received).toHaveLength(0);
  });

  it('入库后一张都没成功（沙箱判定为坏图）：不收费', async () => {
    const ctx = await newOrg(100_000n);
    await expectAppError(gateway.generate(ctx, imageRequest(), stubStore(() => false).options), 502, 'AI_IMAGE_INVALID');
    await expectUnbilled(ctx, 100_000n, 'invalid_upstream_response');
  });

  it('入库本身失败（沙箱不可用、配额已满）：不收费，原错误抛给调用方', async () => {
    const ctx = await newOrg(100_000n);
    const failure = new Error('sandbox unavailable');
    const error = await gateway.generate(ctx, imageRequest(), { store: () => Promise.reject(failure) }).catch((caught: unknown) => caught);
    expect(error).toBe(failure);
    await expectUnbilled(ctx, 100_000n, 'gateway_error');
  });

  it('调用方中途取消：不收费（caller_aborted）；平台原因中止：platform_interrupted', async () => {
    for (const [platform, reason, code, status] of [[false, 'caller_aborted', 'AI_REQUEST_ABORTED', 400], [true, 'platform_interrupted', 'AI_CALL_INTERRUPTED', 503]] as const) {
      const ctx = await newOrg(100_000n);
      let received!: () => void;
      const arrived = new Promise<void>((resolve) => (received = resolve));
      provider.setHandler(() => received());
      const controller = new AbortController();
      const call = gateway.generate(ctx, imageRequest(), { ...stubStore().options, signal: controller.signal, platformAborted: () => platform });
      await arrived;
      controller.abort();
      await expectAppError(call, status, code);
      await expectUnbilled(ctx, 100_000n, reason);
    }
  });
});

describe('任务调用：费用上限与步骤幂等', () => {
  it('计入任务费用上限：已扣费 + 未到期的冻结 + 本次冻结超过上限时不冻结、不调用服务商（TASK_COST_LIMIT）', async () => {
    const ctx = await newOrg(1_000_000n);
    const jobId = await runningJob(ctx, 3n * IMAGE_PRICE);
    const job = { source: 'job' as const, jobId, jobType: 'test-image-job' };
    const first = await gateway.generate(ctx, imageRequest({ ...job, stepKey: 'image:1', count: 2 }), stubStore().options);
    expect(first.billing).toMatchObject({ status: 'billed', amount: 2n * IMAGE_PRICE });
    expect(await superuser.selectFrom('jobs').select('billed_amount').where('id', '=', jobId).executeTakeFirst()).toEqual({ billed_amount: String(2n * IMAGE_PRICE) });
    provider.reset();
    // 已扣 2 张，再冻结 2 张超过 3 张的上限。
    await expectAppError(gateway.generate(ctx, imageRequest({ ...job, stepKey: 'image:2', count: 2 }), stubStore().options), 409, 'TASK_COST_LIMIT');
    expect(provider.requests).toHaveLength(0);
    // 1 张正好到上限，可以。
    respondImages([{ b64_json: PNG_B64 }]);
    const third = await gateway.generate(ctx, imageRequest({ ...job, stepKey: 'image:3', count: 1 }), stubStore().options);
    expect(third.billing.amount).toBe(IMAGE_PRICE);
  });

  it('文本调用的冻结同样计入同一份上限（生图与文本共用任务的费用）', async () => {
    const ctx = await newOrg(1_000_000n);
    const jobId = await runningJob(ctx, 2n * IMAGE_PRICE);
    // 用 beginImageUsage 直接占住 1 张的冻结（模拟进行中的另一次调用），再请求 2 张：合计超过上限。
    await beginImageUsage(appDb, ctx, { requestId: randomUUID(), source: 'job', jobId, jobType: null, provider: 'qwen', model: 'qwen-image', imageCount: 1, holdSeconds: 60 });
    await expectAppError(
      gateway.generate(ctx, imageRequest({ source: 'job', jobId, stepKey: 'image:1', count: 2 }), stubStore().options),
      409,
      'TASK_COST_LIMIT',
    );
  });

  it('任务不在执行中时拒绝', async () => {
    const ctx = await newOrg(1_000_000n);
    await expectAppError(gateway.generate(ctx, imageRequest({ source: 'job', jobId: randomUUID(), stepKey: 'image:1' }), stubStore().options), 409, 'JOB_NOT_RUNNING');
  });

  it('同一步骤、同一请求：续跑时取回已保存的结果，不再调用服务商、不再扣费；请求不同就是新的调用', async () => {
    const ctx = await newOrg(1_000_000n);
    const jobId = await runningJob(ctx, null);
    const request = imageRequest({ source: 'job', jobId, stepKey: 'section:7:image' });
    const first = await gateway.generate(ctx, request, stubStore().options);
    expect(first.reused).toBe(false);
    provider.reset();
    const again = await gateway.generate(ctx, request, stubStore().options);
    expect(again).toMatchObject({ reused: true, requestId: first.requestId, images: first.images, billing: { amount: 0n } });
    expect(provider.requests).toHaveLength(0);
    expect(await chargesOf(ctx.orgId)).toHaveLength(1);

    respondImages([{ b64_json: PNG_B64 }, { b64_json: PNG_B64 }]);
    const changed = await gateway.generate(ctx, { ...request, prompt: `${PROMPT}（换一个角度）` }, stubStore().options);
    expect(changed.reused).toBe(false);
    expect(await chargesOf(ctx.orgId)).toHaveLength(2);
  });

  it('并发的执行者完成同一步骤：后完成的一方不收费，入库的图片经 discard 作废，返回先完成的结果', async () => {
    const ctx = await newOrg(1_000_000n);
    const jobId = await runningJob(ctx, null);
    const request = imageRequest({ source: 'job', jobId, stepKey: 'section:9:image' });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const late = stubStore();
    const lateCall = gateway.generate(ctx, request, {
      ...late.options,
      store: async (images) => {
        await gate;
        return late.options.store(images);
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    const early = await gateway.generate(ctx, request, stubStore().options);
    release();
    const result = await lateCall;
    expect(result).toMatchObject({ reused: true, images: early.images, billing: { amount: 0n } });
    expect(late.discarded).toHaveLength(1);
    expect(late.discarded[0]).toHaveLength(2);
    expect((await usageRows(ctx.orgId)).map((row) => `${row.status}:${row.failure_reason}`).sort()).toEqual(['billed:null', 'unbilled:duplicate_step']);
  });
});

describe('白名单：模型类别与价格形状', () => {
  it('文本模型不能用来生图，生图模型不能用于文本调用', async () => {
    const ctx = await newOrg(1_000_000n);
    await expectAppError(gateway.generate(ctx, imageRequest({ model: 'qwen-plus' }), stubStore().options), 404, 'AI_MODEL_NOT_REGISTERED');
    const textGateway = createAiGateway({
      db: appDb,
      keyWrapper,
      settings: { upstreamTimeoutMs: 2_000, holdTtlSeconds: 60, maxOutputTokens: 100, upstreamPrivateHosts: ['127.0.0.1'] },
      log: Fastify().log,
    });
    await expectAppError(
      textGateway.chat(ctx, { provider: 'qwen', model: 'qwen-image', messages: [{ role: 'user', content: 'hi' }], source: 'interactive' }),
      404,
      'AI_MODEL_NOT_REGISTERED',
    );
    expect(provider.requests).toHaveLength(0);
  });

  it('文本模型的生效价格变成按张的、生图模型的变成按 token 的：都按未定价拒绝', async () => {
    const ctx = await newOrg(1_000_000n);
    const model = await registerImageModel(appDb, ctxAdmin, { provider: 'qwen', model: 'shape-image', isFree: false, note: null });
    await setModelEnabled(appDb, ctxAdmin, model.id, true);
    await addModelPrice(appDb, ctxAdmin, { orgId: null, provider: 'qwen', model: 'shape-image', inputPricePerMtok: 1n, outputPricePerMtok: 1n, effectiveFrom: null, note: null });
    await expectAppError(gateway.generate(ctx, imageRequest({ model: 'shape-image' }), stubStore().options), 503, 'MODEL_PRICE_NOT_CONFIGURED');
    const listed = (await listModels(appDb, ctxAdmin)).find((entry) => entry.model === 'shape-image');
    expect(listed).toMatchObject({ kind: 'image', imagePrice: null, status: 'unpriced' });
    expect((await listModels(appDb, ctxAdmin)).find((entry) => entry.model === 'qwen-image')).toMatchObject({ kind: 'image', imagePrice: IMAGE_PRICE, status: 'available' });
  });

  it('数据库约束：按张的价格不能带 token 单价；用量的张数不能超过请求；不经冻结的直接扣费不接受按张的价格', async () => {
    await expect(
      superuser.insertInto('model_prices').values({ provider: 'qwen', model: 'x', input_price_per_mtok: '1', output_price_per_mtok: '0', image_price: '5', effective_from: new Date(Date.now() + 1000), created_by: platformAdmin }).execute(),
    ).rejects.toMatchObject({ code: '23514' });
    const ctx = await newOrg(1_000_000n);
    const hold = await beginImageUsage(appDb, ctx, { requestId: randomUUID(), source: 'interactive', jobId: null, jobType: null, provider: 'qwen', model: 'qwen-image', imageCount: 2, holdSeconds: 60 });
    await expect(settleUsage(appDb, ctx, hold.usageId, { inputTokens: 0, cachedInputTokens: 0, outputTokens: 3, usageSource: 'provider' })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    await expect(settleUsage(appDb, ctx, hold.usageId, { inputTokens: 10, cachedInputTokens: 0, outputTokens: 1, usageSource: 'provider' })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    await expect(
      beginImageUsage(appDb, ctx, { requestId: randomUUID(), source: 'interactive', jobId: null, jobType: null, provider: 'qwen', model: 'qwen-image', imageCount: MAX_IMAGES_PER_CALL + 1, holdSeconds: 60 }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    await expect(
      chargeUsage(appDb, ctx, { requestId: randomUUID(), provider: 'qwen', model: 'qwen-image', inputTokens: 0, outputTokens: 1 }),
    ).rejects.toMatchObject({ code: 'MODEL_PRICE_NOT_CONFIGURED' });
    // 用量记录的单位不能改。
    await expect(superuser.updateTable('usage_records').set({ unit: 'token' }).where('id', '=', hold.usageId).execute()).rejects.toMatchObject({ code: 'BL003' });
    // 模型类别不能改。
    await expect(superuser.updateTable('platform_models').set({ kind: 'text' }).where('model', '=', 'qwen-image').execute()).rejects.toMatchObject({ code: 'BL003' });
  });

  it('应用角色读不到上游的按张成本，生图凭据与文本凭据分开保存', async () => {
    const ctx = await newOrg();
    const columns = await withTenant(appDb, ctx, (trx) =>
      sql<{ ok: boolean }>`SELECT has_column_privilege('bidtools_app', 'model_prices', 'upstream_image_price', 'SELECT') AS ok`.execute(trx),
    );
    expect(columns.rows[0]!.ok).toBe(false);
    const kinds = await superuser.selectFrom('provider_credentials').select(['kind', 'provider']).where('provider', '=', 'qwen').orderBy('kind').execute();
    expect(kinds).toEqual([{ kind: 'image_model', provider: 'qwen' }, { kind: 'text_model', provider: 'qwen' }]);
  });

  it.each([
    ['0 张', { count: 0 }],
    ['超过每次上限的张数', { count: MAX_IMAGES_PER_CALL + 1 }],
    ['空的提示词', { prompt: '  ' }],
    ['过长的提示词', { prompt: '字'.repeat(4001) }],
    ['不合法的尺寸', { size: '99999x1' }],
    ['任务调用不带步骤键', { source: 'job' as const, jobId: randomUUID() }],
    ['交互调用带任务编号', { jobId: randomUUID() }],
  ])('请求不合法（%s）：400，不冻结', async (_name, overrides) => {
    const ctx = await newOrg(1_000_000n);
    await expectAppError(gateway.generate(ctx, imageRequest(overrides), stubStore().options), 400, 'INVALID_AI_REQUEST');
    expect(await usageRows(ctx.orgId)).toEqual([]);
  });
});

describe('服务商以网址返回图片', () => {
  const url = (file: string) => `https://127.0.0.1:${imagePort}/${file}`;

  it('从服务商的域名下载（不带 Key），按入库的张数收费', async () => {
    const ctx = await newOrg(100_000n);
    respondImages([{ url: url('image.png') }]);
    const store = stubStore();
    const result = await gateway.generate(ctx, imageRequest({ count: 1 }), store.options);
    expect(result.billing).toMatchObject({ amount: IMAGE_PRICE, images: 1 });
    expect(store.received[0]![0]!.data.equals(fakePng(32, 32))).toBe(true);
    expect(imageRequests).toEqual([{ path: '/image.png', authorization: undefined }]);
  });

  it.each([
    ['不在白名单中的域名', () => 'https://evil.example.com/a.png', 'download_host_not_allowed'],
    ['http', () => `http://127.0.0.1:${imagePort}/image.png`, 'download_url_invalid'],
    ['跳转', () => url('redirect.png'), 'download_redirect'],
    ['内网地址的 IP 字面量（白名单中只有模拟服务商的 127.0.0.1）', () => 'https://10.1.2.3/a.png', 'download_host_not_allowed'],
  ])('%s：该张失败、不收费，不跟随也不访问', async (_name, target, failure) => {
    const ctx = await newOrg(100_000n);
    respondImages([{ url: target() }]);
    await expectAppError(gateway.generate(ctx, imageRequest({ count: 1 }), stubStore().options), 502, 'AI_IMAGE_INVALID');
    await expectUnbilled(ctx, 100_000n, 'invalid_upstream_response');
    expect(imageRequests.filter((entry) => entry.path === '/image.png')).toEqual([]);
    expect(logs.text()).toContain(failure);
  });
});

describe('日志', () => {
  it('不含 Key、提示词与图片网址', async () => {
    const ctx = await newOrg(100_000n);
    respondImages([{ url: `https://127.0.0.1:${imagePort}/image.png?Signature=secret-sig` }]);
    await gateway.generate(ctx, imageRequest({ count: 1 }), stubStore().options);
    const text = logs.text();
    expect(text).toContain('ai image call settled');
    expect(text).not.toContain(API_KEY);
    expect(text).not.toContain(PROMPT);
    expect(text).not.toContain('secret-sig');
  });
});

// ---- worker 一侧的入库（src/render/generatedImages.ts） ----

function memoryStore(): ObjectStore & { objects: Map<string, Buffer> } {
  const objects = new Map<string, Buffer>();
  return {
    objects,
    async put(key, body) {
      const chunks: Buffer[] = [];
      for await (const chunk of body) chunks.push(Buffer.from(chunk));
      objects.set(key, Buffer.concat(chunks));
    },
    async get(key) {
      const content = objects.get(key);
      return content ? { body: Readable.from(content), size: content.length } : null;
    },
    async exists(key) {
      return objects.has(key);
    },
    async delete(key) {
      objects.delete(key);
    },
  };
}

/** 假的 render-html 沙箱：记下放入的文件，按 respond 给出每一项的结果。 */
function fakeRenderSandbox(respond: (id: string, format: string) => { png: Buffer; width: number; height: number } | 'image_invalid') {
  const copied: string[][] = [];
  const ref = { id: 'sandbox-1', template: 'render-html' } as unknown as SandboxRef;
  let output: SandboxFile[] = [];
  const driver: SandboxDriver = {
    async create() {
      return ref;
    },
    async copyIn(_sandbox, files) {
      copied.push(files.map((file) => file.path));
      const request = JSON.parse((files.find((file) => file.path === 'request.json') as { data: Buffer }).data.toString()) as { items: { id: string; format: string }[] };
      const items: unknown[] = [];
      output = [];
      for (const item of request.items) {
        const outcome = respond(item.id, item.format);
        if (outcome === 'image_invalid') {
          items.push({ id: item.id, status: 'failed', error: 'image_invalid' });
        } else {
          items.push({ id: item.id, status: 'rendered', width: outcome.width, height: outcome.height });
          output.push({ path: `${item.id}.png`, data: outcome.png });
        }
      }
      output.unshift({ path: 'result.json', data: Buffer.from(JSON.stringify({ version: 1, items })) });
    },
    async exec() {
      const result: SandboxExecResult = { exitCode: 0, stdout: '', stderr: '', timedOut: false, stdoutTruncated: false, stderrTruncated: false };
      return result;
    },
    async copyOut() {
      return output;
    },
    async destroy() {},
  };
  return { driver, copied };
}

describe('入库：经 render-html 转 PNG、按上传图片的规则校验、写成图片产物', () => {
  async function storeContext(driver: SandboxDriver) {
    const ctx = await newOrg(100_000n);
    const project = await withTenant(appDb, ctx, (trx) =>
      trx.insertInto('projects').values({ org_id: ctx.orgId, kind: 'technical-plan', name: '项目', created_by: ctx.userId }).returning('id').executeTakeFirstOrThrow(),
    );
    const objectStore = memoryStore();
    return {
      ctx,
      objectStore,
      context: { jobId: randomUUID(), signal: new AbortController().signal, log: async () => {}, sandbox: driver, db: appDb, tenant: ctx, objectStore, projectId: project.id },
    };
  }

  it('按内容判断格式，只有 PNG / JPEG / WebP / SVG 送进沙箱；每张都重新编码成 PNG 后入库', async () => {
    const converted = fakePng(800, 600);
    const sandbox = fakeRenderSandbox(() => ({ png: converted, width: 800, height: 600 }));
    const { context, objectStore } = await storeContext(sandbox.driver);
    const images: ProviderImage[] = [
      { index: 0, data: fakePng(10, 10), declaredType: 'image/png' },
      { index: 1, data: Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0]), declaredType: null },
      // 声明为 PNG 的 HTML：不送进沙箱。
      { index: 2, data: Buffer.from('<html><script>alert(1)</script></html>'), declaredType: 'image/png' },
      { index: 3, data: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'), declaredType: null },
    ];
    const result = await storeGeneratedImages(context, images, { createRetryDelaysMs: [] });
    expect(sandbox.copied).toEqual([['request.json', 'h001.png', 'h002.jpeg', 'h003.svg']]);
    expect(result.failures).toEqual(['image_invalid']);
    expect(result.stored).toHaveLength(3);
    const rows = await superuser.selectFrom('artifacts').select(['id', 'kind', 'mime', 'name', 'project_id', 'status']).where('id', 'in', result.stored.map((image) => image.artifactId)).orderBy('name').execute();
    expect(rows.map((row: any) => [row.kind, row.mime, row.name, row.status])).toEqual([
      ['image', 'image/png', 'generated-01.png', 'ready'],
      ['image', 'image/png', 'generated-02.png', 'ready'],
      ['image', 'image/png', 'generated-04.png', 'ready'],
    ]);
    expect([...objectStore.objects.values()].every((data) => data.equals(converted))).toBe(true);
  });

  it('沙箱判定为坏图的只让该张失败', async () => {
    const sandbox = fakeRenderSandbox((id) => (id === 'h001' ? 'image_invalid' : { png: fakePng(100, 100), width: 100, height: 100 }));
    const { context } = await storeContext(sandbox.driver);
    const result = await storeGeneratedImages(context, [{ index: 0, data: fakePng(5, 5), declaredType: null }, { index: 1, data: fakePng(5, 5), declaredType: null }], { createRetryDelaysMs: [] });
    expect(result).toMatchObject({ failures: ['image_invalid'], stored: [{ width: 100, height: 100 }] });
  });

  it('接到网关：只按入库的张数收费', async () => {
    const sandbox = fakeRenderSandbox((id) => (id === 'h002' ? 'image_invalid' : { png: fakePng(64, 64), width: 64, height: 64 }));
    const { ctx, context } = await storeContext(sandbox.driver);
    const result = await gateway.generate(ctx, imageRequest(), { store: (images) => storeGeneratedImages(context, images, { createRetryDelaysMs: [] }) });
    expect(result).toMatchObject({ failures: ['image_invalid'], billing: { amount: IMAGE_PRICE, images: 1 } });
  });

  it('sniffGeneratedImage 不采用声明的类型', () => {
    expect(sniffGeneratedImage(fakePng(1, 1))).toBe('png');
    expect(sniffGeneratedImage(Buffer.from('RIFF\0\0\0\0WEBPVP8 '))).toBe('webp');
    expect(sniffGeneratedImage(Buffer.from('﻿  <?xml version="1.0"?><svg/>'))).toBe('svg');
    for (const data of [Buffer.from('GIF89a'), Buffer.from('BM\0\0\0\0\0\0\0\0\0\0\0\0'), Buffer.from('<html><svg/></html>'), Buffer.from([0xc3, 0x28]), Buffer.from('<svg\0>')]) {
      expect(sniffGeneratedImage(data)).toBeNull();
    }
  });
});
