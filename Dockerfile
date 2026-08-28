#
# 单阶段镜像, 简单可靠. better-sqlite3 是 native 模块, 必须在最终镜像里
# 编译; 多阶段拷贝 node_modules 容易因 glibc/musl 差异失败.
# 后续 LLM 可按需切多阶段优化体积.

FROM node:20-alpine

# better-sqlite3 编译需要 python3 + make + g++; alpine 默认没有
# 切阿里云 alpine 镜像加速 (tuna 对该路径返 403, 详见 obs 20520)
RUN sed -i 's#https\?://dl-cdn.alpinelinux.org#https://mirrors.aliyun.com#g' /etc/apk/repositories && \
    apk add --no-cache python3 make g++

WORKDIR /app

# Use headers bundled in the official Node image when better-sqlite3 falls
# back to node-gyp; this avoids an extra download from unofficial-builds.
ENV npm_config_nodedir=/usr/local

# 启用 corepack + pnpm; 用 pnpm 而不是 npm, 跟 create-next-app 生成的 lockfile 对齐.
# pnpm 11+ 要求 Node.js >= 22.13 (用到 node:sqlite 内置模块), 而本镜像是 node:20-alpine;
# 故 pin pnpm@10 — pnpm 10.x 兼容 Node 18+, 行为稳定. 升 Node 基础镜像留待单独评估.
RUN corepack enable && corepack prepare pnpm@10 --activate

COPY package.json pnpm-lock.yaml* pnpm-workspace.yaml* ./
# 切淘宝 npm registry 加速 (中国网络环境下默认 registry 慢)
RUN pnpm config set registry https://registry.npmmirror.com && \
    pnpm install --frozen-lockfile && \
    pnpm rebuild better-sqlite3

COPY . .

# NEXT_PUBLIC_INFERENCE_PROXY_URL 在 build 期被 Next.js 嵌入到客户端 bundle.
# compose-runner augment 阶段把这个值塞进 compose.yaml 的 build.args, 再透传
# 到这里. 不声明 ARG 则 docker build 默认丢弃 --build-arg, 导致 prerender
# 调 @inferencesh/sdk 抛 "Either apiKey, getToken, or proxyUrl is required".
ARG NEXT_PUBLIC_INFERENCE_PROXY_URL=""
ENV NEXT_PUBLIC_INFERENCE_PROXY_URL=${NEXT_PUBLIC_INFERENCE_PROXY_URL}

ARG NEXT_PUBLIC_FIRECRAWL_PROXY_URL=""
ENV NEXT_PUBLIC_FIRECRAWL_PROXY_URL=${NEXT_PUBLIC_FIRECRAWL_PROXY_URL}

RUN DATABASE_URL=file:/tmp/jiawang-build.db pnpm run build

# /data 是 SQLite 持久化挂载点 (compose.yaml 命名 volume 挂这里);
# 容器启动时如果 volume 已挂载, 实际目录被 volume 内容覆盖, 这里 mkdir
# 仅作镜像层保底.
RUN addgroup -g 1001 order && adduser -D -u 1001 -G order order && \
    mkdir -p /data && chown order:order /data

ENV NODE_ENV=production
ENV PORT=3000
ENV HOSTNAME=0.0.0.0
EXPOSE 3000

USER order
CMD ["pnpm", "run", "start"]
