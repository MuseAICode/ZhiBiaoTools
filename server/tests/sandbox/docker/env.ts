// 沙箱隔离测试的环境：
//   TEST_SANDBOX_IMAGE    parse 镜像（server/sandbox/parse/Dockerfile 构建的），必需
//   TEST_SANDBOX_RUNTIME  runsc（CI）或 runc（本机），默认 runc
//   TEST_SANDBOX_DOCKER_SOCKET  默认 /var/run/docker.sock
//   TEST_SANDBOX_OFFICE=1 镜像中有 LibreOffice 时运行转换用例（CI 构建的完整镜像）
//   TEST_SANDBOX_CONTROL_IMAGE  对照镜像：同一 parse 镜像去掉 zhibiao-security.xcd（CI 中由完整镜像派生），宏安全测试的对照组用
//   TEST_SANDBOX_EXPORT_IMAGE  export 镜像（server/sandbox/export/Dockerfile 构建的），未设置时跳过 export 的用例（路线图 7.1）
//   TEST_SANDBOX_AGENT_IMAGE  agent 镜像（server/sandbox/agent/Dockerfile 构建的），未设置时跳过 agent 的用例（路线图 8.1）
//   TEST_SANDBOX_MERMAID_IMAGE  render-mermaid 镜像（server/sandbox/render-mermaid/Dockerfile 构建的），未设置时跳过 render-mermaid 的用例（路线图 8.8b）
//   TEST_DATABASE_ADMIN_URL  解析卡住时的任务测试（parseJob.test.ts）用的数据库，未设置时跳过，见 tests/db/harness.ts
// 测试进程需要能在宿主网络上监听端口（控制组的沙箱经 Docker 网桥网关连接它），在容器中运行时用 --network host。
import { request } from 'node:http';
import { createDockerApi } from '../../../src/sandbox/dockerApi.ts';

const image = process.env.TEST_SANDBOX_IMAGE;
if (!image) throw new Error('TEST_SANDBOX_IMAGE is required for sandbox isolation tests');

export const sandboxEnv = Object.freeze({
  image,
  runtime: process.env.TEST_SANDBOX_RUNTIME ?? 'runc',
  socketPath: process.env.TEST_SANDBOX_DOCKER_SOCKET ?? '/var/run/docker.sock',
  office: process.env.TEST_SANDBOX_OFFICE === '1',
  controlImage: process.env.TEST_SANDBOX_CONTROL_IMAGE ?? null,
  exportImage: process.env.TEST_SANDBOX_EXPORT_IMAGE ?? null,
  agentImage: process.env.TEST_SANDBOX_AGENT_IMAGE ?? null,
  mermaidImage: process.env.TEST_SANDBOX_MERMAID_IMAGE ?? null,
});

export const docker = createDockerApi(sandboxEnv.socketPath);

/** 测试用的 Docker 调用（driver 不提供的：查看网络、创建不带标签的容器）。 */
export function dockerRequest(method: string, path: string, body?: unknown): Promise<{ status: number; json: unknown }> {
  const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
  return new Promise((resolve, reject) => {
    const req = request(
      { socketPath: sandboxEnv.socketPath, method, path: `/v1.44${path}`, headers: payload ? { 'content-type': 'application/json', 'content-length': payload.length } : {} },
      (response) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => chunks.push(chunk));
        response.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let json: unknown = text;
          try {
            json = text ? JSON.parse(text) : null;
          } catch {
            // 非 JSON 原样返回。
          }
          resolve({ status: response.statusCode ?? 0, json });
        });
      },
    );
    req.on('error', reject);
    req.end(payload);
  });
}

export const silentLog = { info: () => {}, warn: () => {}, error: () => {} };
