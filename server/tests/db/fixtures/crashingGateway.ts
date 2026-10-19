// “中途崩溃”测试用的子进程：用 AI 网关发起一次调用，服务商开始响应后由父进程 SIGKILL 结束本进程，
// 模拟 worker 在调用中途崩溃、来不及结算或释放冻结。参数经环境变量传入（只在测试中使用）。
import Fastify from 'fastify';
import { createAiGateway } from '../../../src/ai/gateway.ts';
import { createFileKeyWrapper } from '../../../src/ai/keyring.ts';
import { createDatabase } from '../../../src/db/database.ts';

const env = process.env;
const database = createDatabase({
  host: env.DATABASE_HOST!,
  port: Number(env.DATABASE_PORT),
  name: env.DATABASE_NAME!,
  user: env.DATABASE_USER!,
  password: env.DATABASE_PASSWORD!,
});
const gateway = createAiGateway({
  db: database.db,
  keyWrapper: createFileKeyWrapper(Buffer.from(env.TEST_KEK!, 'base64'), 1),
  settings: { upstreamTimeoutMs: 60_000, holdTtlSeconds: Number(env.HOLD_SECONDS), maxOutputTokens: 1000, upstreamPrivateHosts: ['127.0.0.1'] },
  log: Fastify({ logger: false }).log,
});

await gateway.chat(
  { orgId: env.ORG_ID!, userId: env.USER_ID!, role: 'owner' },
  { provider: 'deepseek', model: 'deepseek-chat', messages: [{ role: 'user', content: env.MESSAGE! }], source: 'interactive' },
);
// 正常情况下到不了这里：父进程会在服务商收到请求后杀掉本进程。
process.stdout.write('FINISHED\n');
await database.destroy();
