FROM node:22-bookworm-slim AS build

WORKDIR /app

# Dependencies first so an edit to src/ does not re-download the tree.
COPY package.json package-lock.json* ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# --- runtime ---------------------------------------------------------------
FROM node:22-bookworm-slim

ENV NODE_ENV=production

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=build /app/dist ./dist

# node:22 ships a non-root `node` user; the config mount is read-only anyway,
# but there is no reason for this process to run as root.
USER node

EXPOSE 4000

# The healthcheck reports degraded (503) while ARI or AMI is down, which is
# exactly when compose should not consider this container ready.
HEALTHCHECK --interval=15s --timeout=5s --start-period=30s --retries=4 \
    CMD node -e "fetch('http://127.0.0.1:4000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/index.js"]
