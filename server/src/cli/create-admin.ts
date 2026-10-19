// 创建平台管理员：node src/cli/create-admin.ts --email <邮箱>（编译后为 dist/cli/create-admin.js，npm run admin:create）。
//
// 第一版只接受邀请注册，第一个平台管理员只能由运维在命令行创建（docs/SERVER_DESIGN.md 第 3.1 节）。
// - 用迁移角色连接（MIGRATION_DATABASE_USER / MIGRATION_DATABASE_PASSWORD[_FILE]）：应用角色没有 is_platform_admin 列的写权限，
//   api 进程无论如何都不能创建管理员；
// - 密码不从命令行参数读取（会留在 shell 历史和进程列表中）：终端中交互输入两次且不回显，否则读标准输入的第一行；
// - 输出一行 JSON，不含密码和哈希。
import { randomUUID } from 'node:crypto';
import { parseArgs } from 'node:util';
import { Kysely, PostgresDialect } from 'kysely';
import { normalizeEmail } from '../auth/email.ts';
import { checkPasswordStrength, createPasswordHasher, PASSWORD_PROBLEM_MESSAGES } from '../auth/password.ts';
import { insertPersonalAccount, isUniqueViolation } from '../auth/store.ts';
import { ConfigError, loadMigrationConfig } from '../config.ts';
import { createPool } from '../db/database.ts';
import type { Database } from '../db/schema.ts';
import { withTenant } from '../db/tenant.ts';

function writeLine(stream: NodeJS.WriteStream, entry: Record<string, unknown>): void {
  stream.write(`${JSON.stringify({ time: Date.now(), ...entry })}\n`);
}

function fail(msg: string, extra: Record<string, unknown> = {}): never {
  writeLine(process.stderr, { level: 'fatal', msg, ...extra });
  process.exit(1);
}

function promptHidden(prompt: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const stdin = process.stdin;
    process.stderr.write(prompt);
    stdin.setRawMode(true);
    stdin.setEncoding('utf8');
    stdin.resume();
    let chars: string[] = [];
    const cleanup = () => {
      stdin.off('data', onData);
      stdin.setRawMode(false);
      stdin.pause();
      process.stderr.write('\n');
    };
    function onData(chunk: string) {
      for (const char of chunk) {
        if (char === '\r' || char === '\n') {
          cleanup();
          resolve(chars.join(''));
          return;
        }
        if (char === '\u0003' || char === '\u0004') {
          cleanup();
          reject(new Error('已取消'));
          return;
        }
        if (char === '\u007f' || char === '\b') chars = chars.slice(0, -1);
        else chars.push(char);
      }
    }
    stdin.on('data', onData);
  });
}

async function readFirstLine(): Promise<string> {
  let input = '';
  for await (const chunk of process.stdin) input += chunk;
  return input.split(/\r?\n/, 1)[0] ?? '';
}

async function readPassword(): Promise<string> {
  if (!process.stdin.isTTY) return readFirstLine();
  const first = await promptHidden('密码：');
  const second = await promptHidden('再次输入密码：');
  if (first !== second) fail('两次输入的密码不一致');
  return first;
}

let values;
try {
  ({ values } = parseArgs({ options: { email: { type: 'string' } }, strict: true }));
} catch {
  fail('用法：create-admin --email <邮箱>（密码从终端输入或标准输入读取）');
}
const email = values.email === undefined ? null : normalizeEmail(values.email);
if (!email) fail('用法：create-admin --email <邮箱>（密码从终端输入或标准输入读取）');

let config;
try {
  config = loadMigrationConfig(process.env);
} catch (error) {
  if (error instanceof ConfigError) fail(error.message, { issues: error.issues });
  throw error;
}

const password = await readPassword();
const problem = checkPasswordStrength(password, email);
if (problem) fail(PASSWORD_PROBLEM_MESSAGES[problem]);

const hasher = await createPasswordHasher();
const passwordHash = await hasher.hash(password);
const context = { orgId: randomUUID(), userId: randomUUID(), role: 'owner' } as const;

const db = new Kysely<Database>({
  dialect: new PostgresDialect({ pool: createPool(config, { maxConnections: 1, applicationName: 'bidtools-create-admin' }) }),
});
try {
  await withTenant(db, context, (trx) => insertPersonalAccount(trx, context, { email, passwordHash, platformAdmin: true }));
} catch (error) {
  await db.destroy();
  if (isUniqueViolation(error, 'users_email_key')) fail('该邮箱已注册');
  fail('创建平台管理员失败', { error: error instanceof Error ? error.message : String(error) });
}
await db.destroy();
writeLine(process.stdout, { level: 'info', msg: 'platform admin created', userId: context.userId, orgId: context.orgId, email });
