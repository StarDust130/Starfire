import { Router } from "express";

import { authSyncController } from "./auth.controller.js";

const router: Router = Router();

// 🔄 Sync Clerk user with backend
router.post(
  "/sync",

  authSyncController,
);

export default router;
