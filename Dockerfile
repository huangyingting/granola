FROM node:24-bookworm-slim
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.json tsconfig.base.json ./
COPY packages ./packages
COPY apps ./apps
COPY tools ./tools
RUN pnpm install --frozen-lockfile --filter windows-ai-notes --filter @windows-ai-notes/api... --filter @windows-ai-notes/worker... --filter @windows-ai-notes/azure-probe... && pnpm exec tsc -b apps/api apps/worker tools/azure-probe
ENV NODE_ENV=production HOST=0.0.0.0 PORT=4411 AUTH_MODE=oidc
USER node
EXPOSE 4411
CMD ["node", "apps/api/dist/main.js"]
