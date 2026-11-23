# syntax=docker/dockerfile:1
# render-mermaid 沙箱镜像（路线图第 8 步 8.8b；“第 8 步说明”第 3 项）：Node 24（入口）+ Playwright 的 chromium-headless-shell +
# 按版本固定的 mermaid.min.js（与 client/package-lock.json 同一版本）+ 开源中文字体。Mermaid 转图必须执行脚本，所以用专用镜像，
# 与 export（禁用 JavaScript 的导出与 render-html）、parse、agent 镜像分开：镜像中只有转图需要的东西，没有 OpenXmlHelper、
# 桌面版代码、凭据、编译器、网络工具和包管理器（npm、corepack、yarn 已删除），也没有 setuid / setgid 程序。
# 只由 sandbox-runner 按 render-mermaid 模板启动：断网、只读根文件系统、非 root、无任何能力，输入输出经 exec 中的 tar 传送。
#
# 构建（在仓库根目录）：docker build -t zhibiao-render-mermaid:dev server/sandbox/render-mermaid
# 部署时按构建出的镜像摘要引用（SANDBOX_MERMAID_IMAGE=...@sha256:...）。
ARG NODE_IMAGE=node:24.21.0-bookworm-slim@sha256:d6aa754f16b3197301076f047b5def2f02ea1dbbc2ca920407d46d7ec7f87b20

# 依赖：按 package-lock.json 安装 playwright-core 与 mermaid（不执行依赖的安装脚本），再用 playwright-core 下载对应版本的
# chromium-headless-shell。最终镜像只取 playwright-core 与 mermaid 的浏览器包 dist/mermaid.min.js（自包含，不需要其余依赖）。
FROM ${NODE_IMAGE} AS deps
WORKDIR /opt/render-mermaid
ENV PLAYWRIGHT_BROWSERS_PATH=/opt/ms-playwright
COPY package.json package-lock.json .npmrc ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund \
 && node node_modules/playwright-core/cli.js install --only-shell chromium \
 && ln -s "$(echo /opt/ms-playwright/chromium_headless_shell-*/chrome-headless-shell-linux64)" /opt/ms-playwright/current \
 && test -x /opt/ms-playwright/current/chrome-headless-shell \
 && test -s node_modules/mermaid/dist/mermaid.min.js

FROM ${NODE_IMAGE}
# chromium-headless-shell 的运行库（与 export 镜像相同，按其 ldd 结果，不装 X11 服务和图形界面）；
# fontconfig + fonts-noto-cjk（Noto Sans / Serif CJK，SIL OFL 1.1）+ fonts-dejavu-core：字体。
# 安装后删除包管理器的缓存与列表，删除 Node 镜像自带的 npm / corepack / yarn，去掉所有 setuid / setgid 位。
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      libglib2.0-0 libnspr4 libnss3 libdbus-1-3 libatk1.0-0 libatk-bridge2.0-0 libatspi2.0-0 libexpat1 \
      libx11-6 libxcb1 libxcomposite1 libxdamage1 libxext6 libxfixes3 libxrandr2 libxkbcommon0 \
      libgbm1 libdrm2 libudev1 libasound2 \
      fontconfig fonts-noto-cjk fonts-dejavu-core \
 && apt-get clean \
 && rm -rf /var/lib/apt/lists/* /var/cache/apt/* /var/log/apt /var/log/dpkg.log \
 && rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack /opt/yarn-* \
           /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack /usr/local/bin/yarn /usr/local/bin/yarnpkg \
 && find / -xdev -type f -perm /6000 -exec chmod a-s {} + \
 && groupadd --gid 10001 sandbox \
 && useradd --uid 10001 --gid 10001 --no-create-home --home-dir /tmp --shell /usr/sbin/nologin sandbox \
 && mkdir -p /work /output /opt/render-mermaid/assets /opt/render-mermaid/node_modules \
 && fc-cache -f

COPY --from=deps /opt/ms-playwright /opt/ms-playwright
RUN ln -s "$(readlink -f /opt/ms-playwright/current)" /opt/chromium \
 && rm /opt/ms-playwright/current
COPY --from=deps /opt/render-mermaid/node_modules/playwright-core /opt/render-mermaid/node_modules/playwright-core
COPY --chmod=0644 --from=deps /opt/render-mermaid/node_modules/mermaid/dist/mermaid.min.js /opt/render-mermaid/assets/mermaid.min.js
COPY --chmod=0644 package.json entry.mjs mermaidImage.mjs page.js /opt/render-mermaid/

ENV HOME=/tmp LANG=C.UTF-8 TMPDIR=/tmp
USER 10001:10001
WORKDIR /tmp
# 主进程只是 sleep（sandbox-runner 也会显式指定），命令经 exec 执行。
ENTRYPOINT ["/usr/bin/sleep"]
CMD ["infinity"]
