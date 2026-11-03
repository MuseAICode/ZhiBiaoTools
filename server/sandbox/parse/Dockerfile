# syntax=docker/dockerfile:1
# parse 沙箱镜像（docs/SERVER_DESIGN.md 第 7.4、7.5 节；路线图第 6 步 6.5）：Node 24 + LibreOffice（Writer、Calc，无图形界面）+ 中文字体。
# 只由 sandbox-runner 按 parse 模板启动：断网、只读根文件系统、非 root、无任何能力，输入输出经 exec 中的 tar 传送。
# 镜像中没有凭据、编译器、网络工具和包管理器（npm、corepack、yarn 已删除），也没有 setuid / setgid 程序。
# 基础镜像与 server/Dockerfile 相同，按 digest 固定；部署时按构建出的镜像摘要引用（SANDBOX_PARSE_IMAGE=...@sha256:...）。
# 解析入口（/opt/parse/entry.mjs）与其 npm 依赖（mammoth、pdfjs 等，6.6 加入）在单独的构建阶段按 package-lock.json 安装
# （不执行依赖的安装脚本），最终镜像只复制安装结果，不含 npm。文本类格式（6.7）的检查与清理是 markupGuard.mjs（只用 Node 内置模块）
# 和 htmlSanitize.mjs（cheerio），没有新增依赖；标书查重的逐文档提取（6.10）是 duplicateText.mjs 与 duplicateTables.mjs（cheerio），同样没有新增依赖；
# 标书查重的文档格式元数据（6.10b）是 duplicateMetadata.mjs（内置模块，OLE 用 SheetJS 自带的 CFB、PDF 用已有的 pdf-parse），没有新增依赖。
ARG NODE_IMAGE=node:24.21.0-bookworm-slim@sha256:d6aa754f16b3197301076f047b5def2f02ea1dbbc2ca920407d46d7ec7f87b20

FROM ${NODE_IMAGE} AS deps
WORKDIR /opt/parse
COPY package.json package-lock.json .npmrc ./
COPY vendor ./vendor
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund \
 && rm -rf vendor

FROM ${NODE_IMAGE}
# libreoffice-*-nogui：不带 X11 / GTK 前端，只能 headless 运行；fonts-noto-cjk：中日韩字体（SIL OFL 1.1），fonts-dejavu-core：西文字体。
# LibreOffice 的全局安全设置（不执行宏、链接与域不在加载时更新、阻止不受信任的外部资源）与解析入口同时加入（6.6），
# 放在 share/registry 下、各项 finalized，每次转换新建的用户配置不能覆盖；断网是兜底。
# 安装后删除包管理器的缓存与列表，删除 Node 镜像自带的 npm / corepack / yarn，去掉所有 setuid / setgid 位。
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      libreoffice-writer-nogui \
      libreoffice-calc-nogui \
      fonts-noto-cjk \
      fonts-dejavu-core \
 && apt-get clean \
 && rm -rf /var/lib/apt/lists/* /var/cache/apt/* /var/log/apt /var/log/dpkg.log \
 && rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack /opt/yarn-* \
           /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack /usr/local/bin/yarn /usr/local/bin/yarnpkg \
 && find / -xdev -type f -perm /6000 -exec chmod a-s {} + \
 && groupadd --gid 10001 sandbox \
 && useradd --uid 10001 --gid 10001 --no-create-home --home-dir /tmp --shell /usr/sbin/nologin sandbox \
 && mkdir -p /input /output /opt/parse

COPY --chmod=0644 libreoffice/zhibiao-security.xcd /usr/lib/libreoffice/share/registry/zhibiao-security.xcd
COPY --from=deps /opt/parse/node_modules /opt/parse/node_modules
COPY --chmod=0644 package.json entry.mjs convert.mjs zipGuard.mjs markupGuard.mjs htmlSanitize.mjs duplicateText.mjs duplicateTables.mjs duplicateMetadata.mjs /opt/parse/

ENV HOME=/tmp LANG=C.UTF-8 TMPDIR=/tmp
USER 10001:10001
WORKDIR /tmp
# 主进程只是 sleep（sandbox-runner 也会显式指定），命令经 exec 执行。
ENTRYPOINT ["/usr/bin/sleep"]
CMD ["infinity"]
