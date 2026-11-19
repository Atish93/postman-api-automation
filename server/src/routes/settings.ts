// Settings: the Postman connection.
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { setSetting, type DB } from "../db.ts";
import { keyHint, postman, postmanKey } from "../postman.ts";

export function settingsRoutes(app: FastifyInstance, db: DB) {
  app.get("/api/settings", async () => {
    const key = postmanKey(db);
    return { postman: { connected: !!key, key_hint: keyHint(key) } };
  });

  // Save (or, with null, forget) the Postman API key. It is checked against Postman before it is saved.
  app.put("/api/settings/postman", async (req) => {
    const { api_key } = z.object({ api_key: z.string().trim().min(1).nullable() }).parse(req.body);
    if (api_key === null) {
      setSetting(db, "postman_api_key", null);
      return { postman: { connected: !!postmanKey(db), key_hint: keyHint(postmanKey(db)) } };
    }
    setSetting(db, "postman_api_key", api_key);
    try {
      const me = await postman(db, "/me");
      return { postman: { connected: true, key_hint: keyHint(api_key), user: me.user?.username ?? null } };
    } catch (e) {
      setSetting(db, "postman_api_key", null);
      throw e;
    }
  });
}
