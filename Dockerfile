ARG TARGETARCH
FROM node:24-bookworm-slim AS base
WORKDIR /app
ENV PNPM_HOME=/opt/pnpm
ENV PATH="${PNPM_HOME}:${PATH}"

FROM base AS pnpm-amd64
ADD --checksum=sha256:9705e5704b4679fb503c963a18d1ac4f105e39aafafca8a2ed346facdf820cd0 https://github.com/pnpm/pnpm/releases/download/v12.3.4/pnpm-linux-x64.tar.gz /tmp/pnpm.tar.gz
RUN mkdir -p /opt/pnpm && tar -xzf /tmp/pnpm.tar.gz -C /opt/pnpm && rm /tmp/pnpm.tar.gz

FROM base AS pnpm-arm64
ADD --checksum=sha256:95e71a2a30bbc0b77511f95cf096779068dcad6ffcbbfdf0cd4dde9de2b2b97c https://github.com/pnpm/pnpm/releases/download/v12.3.4/pnpm-linux-arm64.tar.gz /tmp/pnpm.tar.gz
RUN mkdir -p /opt/pnpm && tar -xzf /tmp/pnpm.tar.gz -C /opt/pnpm && rm /tmp/pnpm.tar.gz

FROM pnpm-${TARGETARCH} AS server
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.json tsconfig.base.json ./
COPY packages ./packages
COPY apps ./apps
COPY tools ./tools
RUN node -e 'if (require("./package.json").packageManager !== "pnpm@12.3.4") throw new Error("Update the Docker pnpm release pins with packageManager.")' \
    && pnpm install --frozen-lockfile --filter windows-ai-notes --filter @windows-ai-notes/api... --filter @windows-ai-notes/worker... --filter @windows-ai-notes/azure-probe... \
    && pnpm exec tsc -b apps/api apps/worker tools/azure-probe
RUN chmod -R go=rX /app /opt/pnpm
ENV NODE_ENV=production HOST=0.0.0.0 PORT=4411 AUTH_MODE=oidc
USER node
EXPOSE 4411
CMD ["node", "apps/api/dist/main.js"]
