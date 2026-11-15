# syntax=docker/dockerfile:1
# agent 沙箱镜像（docs/SERVER_DESIGN.md 第 7.3、7.4 节；路线图第 8 步 8.1，决定事项第 3 项）：Node 24 + rg / fd / jq + /bin/sh 与基本 coreutils。
# 只由 sandbox-runner 按 agent / agent-content 模板启动：gVisor、只读根文件系统、非 root、无任何能力，网络只通 agent-gw（每个沙箱一个
# 专用的 internal 网络），输入输出经 exec 中的 tar 传送。入口（/opt/agent/entry.mjs，8.6a）只用 Node 内置模块；Pi 运行时随 8.6b 加入。
# 不含 Chromium、LibreOffice、OpenXmlHelper（渲染与转换在 render-* / export 沙箱中做，偏离设计第 7.4 节，#70 确认），也不含凭据、编译器、
# 网络工具和包管理器（npm、corepack、yarn 已删除），没有 setuid / setgid 程序。
# 基础镜像与 server/Dockerfile、parse / export 镜像相同，按 digest 固定；部署时按构建出的镜像摘要引用（SANDBOX_AGENT_IMAGE=...@sha256:...）。
ARG NODE_IMAGE=node:24.21.0-bookworm-slim@sha256:d6aa754f16b3197301076f047b5def2f02ea1dbbc2ca920407d46d7ec7f87b20

FROM ${NODE_IMAGE}
# ripgrep（MIT 或 Unlicense）、fd-find（MIT 或 Apache-2.0）、jq（MIT，依赖 libjq1 / MIT、libonig5 / BSD-2-Clause）：桌面版 Pi 用到的搜索与 JSON 工具
# （设计第 7.3 节“rg、fd、jq 预装进沙箱镜像”）。Debian 中 fd 的命令名是 fdfind，另建 fd 的链接。
# 安装后删除包管理器的缓存与列表，删除 Node 镜像自带的 npm / corepack / yarn，去掉所有 setuid / setgid 位。
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      ripgrep \
      fd-find \
      jq \
 && apt-get clean \
 && rm -rf /var/lib/apt/lists/* /var/cache/apt/* /var/log/apt /var/log/dpkg.log \
 && rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack /opt/yarn-* \
           /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack /usr/local/bin/yarn /usr/local/bin/yarnpkg \
 && ln -s /usr/bin/fdfind /usr/local/bin/fd \
 && find / -xdev -type f -perm /6000 -exec chmod a-s {} + \
 && groupadd --gid 10001 sandbox \
 && useradd --uid 10001 --gid 10001 --no-create-home --home-dir /tmp --shell /usr/sbin/nologin sandbox \
 && mkdir -p /workspace /opt/agent

# 入口：模板的 run 命令（node /opt/agent/entry.mjs），请求（含任务令牌）经标准输入传入，协议见 protocol.mjs。属主为 root、只读。
COPY --chmod=0644 entry.mjs protocol.mjs /opt/agent/

ENV HOME=/tmp LANG=C.UTF-8 TMPDIR=/tmp
USER 10001:10001
WORKDIR /tmp
# 主进程只是 sleep（sandbox-runner 也会显式指定），命令经 exec 执行。
ENTRYPOINT ["/usr/bin/sleep"]
CMD ["infinity"]
