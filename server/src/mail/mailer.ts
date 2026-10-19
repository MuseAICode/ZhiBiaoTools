// 发信接口。发信服务尚未选定（docs/EXTERNAL_SERVICES.md §7），目前只有输出到日志的实现：
// - development：完整输出收件人、主题和正文（含一次性链接），供本地联调；
// - 其他环境：只输出打码后的收件人和主题，正文（含令牌）不进日志。
// 选定发信服务后新增一个 Mailer 实现，在 src/server.ts 中替换。
import type { FastifyBaseLogger } from 'fastify';
import type { NodeEnv } from '../config.ts';

export interface MailMessage {
  to: string;
  subject: string;
  text: string;
}

export interface Mailer {
  send(message: MailMessage): Promise<void>;
}

/** a***@example.com：只保留用户名首字符和域名。 */
export function maskEmail(email: string): string {
  const at = email.lastIndexOf('@');
  if (at <= 0) return '***';
  return `${email[0]}***${email.slice(at)}`;
}

export function createLogMailer(logger: FastifyBaseLogger, nodeEnv: NodeEnv): Mailer {
  return {
    async send(message) {
      if (nodeEnv === 'development') {
        logger.info({ mail: { to: message.to, subject: message.subject, text: message.text } }, 'mail (development, not sent)');
        return;
      }
      logger.warn({ mail: { to: maskEmail(message.to), subject: message.subject } }, 'mail not sent: no mail service configured');
    },
  };
}

/**
 * 在响应之后异步发信：响应时间不随“邮箱是否存在”变化，发信服务慢或失败也不影响接口。失败只记日志。
 */
export function sendMailInBackground(logger: FastifyBaseLogger, mailer: Mailer, message: MailMessage): void {
  setImmediate(() => {
    mailer.send(message).catch((error: unknown) => logger.error({ err: error }, 'mail delivery failed'));
  });
}
