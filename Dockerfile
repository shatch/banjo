# ---- build stage: needs devDependencies (typescript) ----
# Docker Official Images, pulled from their ECR Public mirror: GitHub runners
# hit Docker Hub's anonymous pull limit (2026-10-09).
FROM public.ecr.aws/docker/library/node:22-alpine AS builder
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

# ---- runtime stage: production deps only ----
FROM public.ecr.aws/docker/library/node:22-alpine AS runtime
# Proves to the MCP Registry that this image is the server server.json names
# (io.github.shatch/banjo). Must match server.json's `name` exactly.
LABEL io.modelcontextprotocol.server.name="io.github.shatch/banjo"
ENV NODE_ENV=production
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=builder /app/dist ./dist
# The committed migrations. src/db/migrate.ts resolves this folder relative to
# its own module URL, so dist/db/migrate.js finds /app/drizzle. drizzle-kit
# itself is a devDependency and is NOT in this image — migrations are generated
# on a developer machine and only applied here.
COPY drizzle ./drizzle

USER node
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/index.js"]
