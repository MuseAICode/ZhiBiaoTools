# syntax=docker/dockerfile:1
# render-layout 沙箱镜像（路线图第 8 步 8.8c；“第 8 步说明”第 3 项）：Node 24（入口）+ Playwright 的 chromium-headless-shell +
# 构建时打成一个文件的页面脚本（平台的 page.mjs / layoutProjection.mjs + 与前端同一版本、打上同一份补丁的 @docx-editor.dev/core）+
# 开源中文字体与 export 镜像相同的字体名映射。docx-editor 分页测量必须执行脚本，所以用专用镜像，与 export（禁用 JavaScript 的导出与
# render-html）、render-mermaid、parse、agent 镜像分开：镜像中只有测量需要的东西，没有 OpenXmlHelper、桌面版代码、esbuild、
# docx-editor 的 node_modules、凭据、编译器、网络工具和包管理器（npm、corepack、yarn 已删除），也没有 setuid / setgid 程序。
# 只由 sandbox-runner 按 render-layout 模板启动：断网、只读根文件系统、非 root、无任何能力，输入输出经 exec 中的 tar 传送。
#
# 构建上下文是本目录，另有两个具名上下文（与前端、export 镜像同一份文件，不复制进本目录）：
#   docker build -t zhibiao-render-layout:dev \
#     --build-context patches=client/patches \
#     --build-context fonts=server/sandbox/export/fonts \
#     server/sandbox/render-layout
# 部署时按构建出的镜像摘要引用（SANDBOX_LAYOUT_IMAGE=...@sha256:...）。
ARG NODE_IMAGE=node:24.21.0-bookworm-slim@sha256:d6aa754f16b3197301076f047b5def2f02ea1dbbc2ca920407d46d7ec7f87b20

# 依赖与页面脚本：按 package-lock.json 安装 playwright-core、@docx-editor.dev/core 与 esbuild（不执行依赖的安装脚本），
# 打上 client/patches 中的同一份 docx-editor 补丁（与前端 npm ci 时 patch-package 打上的结果逐字节相同，不允许模糊匹配），
# 用 build-page.mjs 打出页面脚本，再用 playwright-core 下载对应版本的 chromium-headless-shell。
# 最终镜像只取 playwright-core、页面脚本与浏览器。
FROM ${NODE_IMAGE} AS deps
WORKDIR /opt/render-layout
ENV PLAYWRIGHT_BROWSERS_PATH=/opt/ms-playwright
RUN apt-get update \
 && apt-get install -y --no-install-recommends patch \
 && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json .npmrc ./
COPY --from=patches @docx-editor.dev+core+2.15.0.patch /tmp/docx-editor.patch
COPY build-page.mjs page.mjs layoutProjection.mjs ./
RUN npm ci --ignore-scripts --no-audit --no-fund \
 && patch -p1 --forward --batch --fuzz=0 --no-backup-if-mismatch < /tmp/docx-editor.patch \
 && node build-page.mjs /opt/render-layout/assets/docx-layout.js \
 && test -s /opt/render-layout/assets/docx-layout.js \
 && node node_modules/playwright-core/cli.js install --only-shell chromium \
 && ln -s "$(echo /opt/ms-playwright/chromium_headless_shell-*/chrome-headless-shell-linux64)" /opt/ms-playwright/current \
 && test -x /opt/ms-playwright/current/chrome-headless-shell

FROM ${NODE_IMAGE}
# chromium-headless-shell 的运行库（与 export 镜像相同，按其 ldd 结果，不装 X11 服务和图形界面）；
# fontconfig + fonts-noto-cjk（Noto Sans / Serif CJK，SIL OFL 1.1）+ fonts-dejavu-core：字体（与 export 镜像相同）。
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
 && mkdir -p /work /output /opt/render-layout/assets /opt/render-layout/node_modules

# 中文字体名映射到 Noto CJK（与 export 镜像同一份文件），构建时生成字体缓存（根文件系统只读，运行时不写缓存）。
COPY --chmod=0644 --from=fonts 65-zhibiao-cjk.conf /etc/fonts/conf.d/65-zhibiao-cjk.conf
RUN fc-cache -f

COPY --from=deps /opt/ms-playwright /opt/ms-playwright
RUN ln -s "$(readlink -f /opt/ms-playwright/current)" /opt/chromium \
 && rm /opt/ms-playwright/current
COPY --from=deps /opt/render-layout/node_modules/playwright-core /opt/render-layout/node_modules/playwright-core
COPY --chmod=0644 --from=deps /opt/render-layout/assets/docx-layout.js /opt/render-layout/assets/docx-layout.js
COPY --chmod=0644 package.json entry.mjs wordLayout.mjs /opt/render-layout/

ENV HOME=/tmp LANG=C.UTF-8 TMPDIR=/tmp
USER 10001:10001
WORKDIR /tmp
# 主进程只是 sleep（sandbox-runner 也会显式指定），命令经 exec 执行。
ENTRYPOINT ["/usr/bin/sleep"]
CMD ["infinity"]
