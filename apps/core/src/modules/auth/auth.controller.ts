import type { Request, Response } from "express";

import { authSync } from "./auth.service.js";

// 🔄 Sync user
export async function authSyncController(req: Request, res: Response) {
  const user = await authSync(req.body);

  return res.json({
    success: true,

    userId: user.id,
  });
}
