// Settings: the Postman connection.
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { setSetting, type DB } from "../db.ts";
import type { RunManager } from "../runs/manager.ts";
import { secretsInfo, setSecretSetting } from "../secrets.ts";
import { keyHint, postman, postmanKey } from "../postman.ts";

export function settingsRoutes(app: FastifyInstance, db: DB, runs?: RunManager) {
  app.get("/api/settings", async () => {
    const key = postmanKey(db);
    const s = secretsInfo();
    // Where the encryption key for saved secrets lives (shown so it can be backed up).
    return {
      postman: { connected: !!key, key_hint: keyHint(key) },
      secrets: { key_source: s.kind, key_file: s.file ?? null },
      runs: runs ? { max_parallel: runs.maxParallel(), running: runs.status().running.length, queued: runs.status().queued.length } : null,
    };
  });

  // Save (or, with null, forget) the Postman API key. It is checked against Postman before it is saved.
  app.put("/api/settings/postman", async (req) => {
    const { api_key } = z.object({ api_key: z.string().trim().min(1).nullable() }).parse(req.body);
    if (api_key === null) {
      setSecretSetting(db, "postman_api_key", null);
      return { postman: { connected: !!postmanKey(db), key_hint: keyHint(postmanKey(db)) } };
    }
    setSecretSetting(db, "postman_api_key", api_key);
    try {
      const me = await postman(db, "/me");
      return { postman: { connected: true, key_hint: keyHint(api_key), user: me.user?.username ?? null } };
    } catch (e) {
      setSecretSetting(db, "postman_api_key", null);
      throw e;
    }
  });

  // How many runs may run at the same time (1 to 8).
  app.put("/api/settings/runs", async (req) => {
    const { max_parallel } = z.object({ max_parallel: z.number().int().min(1).max(8) }).parse(req.body);
    setSetting(db, "max_parallel_runs", String(max_parallel));
    return { max_parallel };
  });
}
