import { Router, type Router as ExpressRouter } from "express";


import { chatController } from "./chat.controller.js";

import { validate } from "../../middleware/validate.middleware.js";

import { chatSchema } from "./chat.schema.js";



const router: ExpressRouter = Router();


// 💬 Chat route
router.post(
  "/",

  validate(chatSchema),

  chatController
);



export default router;
