# syntax=docker/dockerfile:1
# export 沙箱镜像（docs/SERVER_DESIGN.md 第 7.9 节；路线图第 7 步 7.1）：Node 24（入口与装饰生成器）+ Playwright 的
# chromium-headless-shell（装饰 SVG 转 PNG）+ OpenXmlHelper（linux-x64 自包含发布）+ 开源中文字体与 fontconfig 映射。
# 只由 sandbox-runner 按 export-preview / export-document 模板启动：断网、只读根文件系统、非 root、无任何能力，
# 输入输出经 exec 中的 tar 传送。镜像中没有凭据、编译器、.NET SDK、网络工具和包管理器（npm、corepack、yarn 已删除），
# 也没有 setuid / setgid 程序。与 parse 镜像、第 8 步的 Agent 镜像分开，各自只装自己需要的东西。
#
# 构建上下文是本目录，另有两个具名上下文（与桌面版同一份代码，不复制进 server/）：
#   docker build -t zhibiao-export:dev \
#     --build-context openxmlhelper=openxmlhelper \
#     --build-context chrome=client/electron/shared/chrome \
#     server/sandbox/export
# 部署时按构建出的镜像摘要引用（SANDBOX_EXPORT_IMAGE=...@sha256:...）。
ARG NODE_IMAGE=node:24.21.0-bookworm-slim@sha256:d6aa754f16b3197301076f047b5def2f02ea1dbbc2ca920407d46d7ec7f87b20
# .NET SDK 只在构建阶段使用（与 openxmlhelper/global.json 的 10.0 一致），不进入最终镜像。
ARG DOTNET_SDK_IMAGE=mcr.microsoft.com/dotnet/sdk:10.0@sha256:de4fe90a98845d75910b9769662465c84de1a934665c431279d1382b2bddc02b

# 助手：linux-x64 自包含发布、不裁剪（同桌面版打包约定），但不打成单文件——单文件运行时要把原生库解压到可写目录再加载，
# 而沙箱中可写的 /tmp 是 noexec。
FROM ${DOTNET_SDK_IMAGE} AS helper
WORKDIR /src
COPY --from=openxmlhelper global.json ./
COPY --from=openxmlhelper src/OpenXmlHelper ./src/OpenXmlHelper
RUN dotnet publish src/OpenXmlHelper/OpenXmlHelper.csproj \
      --configuration Release \
      --runtime linux-x64 \
      --self-contained true \
      -p:PublishSingleFile=false \
      -p:PublishTrimmed=false \
      -p:DebugType=none \
      -p:GenerateDocumentationFile=false \
      --output /out \
 && test -x /out/openxmlhelper

# 入口依赖：按 package-lock.json 安装 playwright-core（不执行依赖的安装脚本），再用它下载对应版本的 chromium-headless-shell。
FROM ${NODE_IMAGE} AS deps
WORKDIR /opt/export
ENV PLAYWRIGHT_BROWSERS_PATH=/opt/ms-playwright
COPY package.json package-lock.json .npmrc ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund \
 && node node_modules/playwright-core/cli.js install --only-shell chromium \
 && ln -s "$(echo /opt/ms-playwright/chromium_headless_shell-*/chrome-headless-shell-linux64)" /opt/ms-playwright/current \
 && test -x /opt/ms-playwright/current/chrome-headless-shell

FROM ${NODE_IMAGE}
# chromium-headless-shell 的运行库（按其 ldd 结果，不装 X11 服务和图形界面）；libicu72：助手的全球化支持；
# fontconfig + fonts-noto-cjk（Noto Sans / Serif CJK，SIL OFL 1.1）+ fonts-dejavu-core：字体（决定事项第 3 项）。
# 安装后删除包管理器的缓存与列表，删除 Node 镜像自带的 npm / corepack / yarn，去掉所有 setuid / setgid 位。
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      libglib2.0-0 libnspr4 libnss3 libdbus-1-3 libatk1.0-0 libatk-bridge2.0-0 libatspi2.0-0 libexpat1 \
      libx11-6 libxcb1 libxcomposite1 libxdamage1 libxext6 libxfixes3 libxrandr2 libxkbcommon0 \
      libgbm1 libdrm2 libudev1 libasound2 \
      libicu72 \
      fontconfig fonts-noto-cjk fonts-dejavu-core \
 && apt-get clean \
 && rm -rf /var/lib/apt/lists/* /var/cache/apt/* /var/log/apt /var/log/dpkg.log \
 && rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack /opt/yarn-* \
           /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack /usr/local/bin/yarn /usr/local/bin/yarnpkg \
 && find / -xdev -type f -perm /6000 -exec chmod a-s {} + \
 && groupadd --gid 10001 sandbox \
 && useradd --uid 10001 --gid 10001 --no-create-home --home-dir /tmp --shell /usr/sbin/nologin sandbox \
 && mkdir -p /work /output /opt/export/chrome

# 模板可选的中文字体名映射到 Noto CJK；构建时生成字体缓存（根文件系统只读，运行时不写缓存）。
COPY --chmod=0644 fonts/65-zhibiao-cjk.conf /etc/fonts/conf.d/65-zhibiao-cjk.conf
RUN fc-cache -f

COPY --from=helper /out /opt/openxmlhelper
COPY --from=deps /opt/ms-playwright /opt/ms-playwright
RUN ln -s "$(readlink -f /opt/ms-playwright/current)" /opt/chromium \
 && rm /opt/ms-playwright/current
COPY --from=deps /opt/export/node_modules /opt/export/node_modules
COPY --chmod=0644 --from=chrome *.mjs /opt/export/chrome/
COPY --chmod=0644 package.json entry.mjs render.mjs /opt/export/

ENV HOME=/tmp LANG=C.UTF-8 TMPDIR=/tmp
USER 10001:10001
WORKDIR /tmp
# 主进程只是 sleep（sandbox-runner 也会显式指定），命令经 exec 执行。
ENTRYPOINT ["/usr/bin/sleep"]
CMD ["infinity"]
