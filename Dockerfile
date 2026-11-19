# The QA dashboard in one image: the web app, the API server and the agent team.
#   docker compose up -d --build        (see docs/DEPLOYMENT.md)
# Everything worth keeping is in one volume at /app/server/data: the database, the encryption key,
# backups, run files, and what the agents learned (known issues and the search index).

# ---- Build the web app ----
FROM node:22-bookworm-slim AS web
WORKDIR /app/web
COPY web/package.json web/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY web/ ./
RUN npm run build

# ---- The server and the agents ----
FROM node:22-bookworm-slim
ENV NODE_ENV=production HOST=0.0.0.0 PORT=4000 npm_config_update_notifier=false NODE_OPTIONS=--disable-warning=ExperimentalWarning
WORKDIR /app

COPY agent/package.json agent/package-lock.json agent/
RUN cd agent && npm ci --no-audit --no-fund
COPY server/package.json server/package-lock.json server/
RUN cd server && npm ci --no-audit --no-fund

COPY agent/ agent/
COPY server/ server/
COPY --from=web /app/web/dist web/dist
COPY deploy/entrypoint.sh /usr/local/bin/qa-entrypoint

# What the agents learn is written to these two files; they're links into the data volume,
# and the copies shipped with the code seed it on first start.
RUN mkdir -p /app/agent-seed server/data agent/runs \
 && mv agent/rag/index.json agent/knowledge/known-issues.md /app/agent-seed/ \
 && ln -s /app/server/data/agent/index.json agent/rag/index.json \
 && ln -s /app/server/data/agent/known-issues.md agent/knowledge/known-issues.md \
 && chmod +x /usr/local/bin/qa-entrypoint \
 && chown -R node:node server/data agent/runs /app/agent-seed \
 && chmod 700 server/data

USER node
# So `docker compose exec qa npm run backup` (and restore, reset-password) run in the server folder.
WORKDIR /app/server
VOLUME /app/server/data
EXPOSE 4000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||4000)+'/api/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
ENTRYPOINT ["qa-entrypoint"]
