#!/bin/sh
# Starts the dashboard in the container. On first start, seeds what the agents learn into the data volume.
set -e
mkdir -p /app/server/data/agent
for f in index.json known-issues.md; do
  [ -f "/app/server/data/agent/$f" ] || cp "/app/agent-seed/$f" "/app/server/data/agent/$f"
done
cd /app/server
# Commands such as `docker compose exec qa npm run backup` run next to this; with no arguments, start the server.
if [ "$#" -gt 0 ]; then exec "$@"; fi
exec node --import tsx src/index.ts
