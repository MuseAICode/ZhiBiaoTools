import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { createLogMailer, maskEmail } from '../src/mail/mailer.ts';
import { createLogCapture } from './helpers.ts';

/** pino 是 fastify 的依赖而不是本项目的直接依赖，经 Fastify 取日志器。 */
function logger(stream: NodeJS.WritableStream) {
  return Fastify({ logger: { stream } }).log;
}

const message = {
  to: 'zhangsan@example.com',
  subject: '重置密码',
  text: '链接：https://bid.example.com/reset-password#token=one-time-secret-token',
};

describe('日志发信实现', () => {
  it('开发环境完整输出，便于本地联调', async () => {
    const logs = createLogCapture();
    await createLogMailer(logger(logs.stream), 'development').send(message);
    expect(logs.text()).toContain('one-time-secret-token');
    expect(logs.text()).toContain('zhangsan@example.com');
  });

  it.each(['production', 'test'] as const)('%s 环境不输出正文（令牌），收件人打码', async (nodeEnv) => {
    const logs = createLogCapture();
    await createLogMailer(logger(logs.stream), nodeEnv).send(message);
    const text = logs.text();
    expect(text).not.toContain('one-time-secret-token');
    expect(text).not.toContain('zhangsan@');
    expect(logs.lines()[0]).toMatchObject({ level: 40, mail: { to: 'z***@example.com', subject: '重置密码' } });
  });

  it('maskEmail', () => {
    expect(maskEmail('a@b.co')).toBe('a***@b.co');
    expect(maskEmail('not-an-email')).toBe('***');
  });
});
