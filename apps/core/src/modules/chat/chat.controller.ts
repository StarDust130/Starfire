import type { Request, Response } from "express";
import { chatService } from "./chat.service.js";
import { asyncHandler } from "../../utils/async-handler.js";

// chat.controller.js
export const chatController = asyncHandler(
  async (req: Request, res: Response) => {
    console.log("📡 [Controller] Request received");

    // SSE Headers
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    
    // CRITICAL: Force Express to establish the connection instantly
    res.flushHeaders(); 

    try {
      await chatService(req.body, res);
    } catch (error) {
      console.error("Chat stream failed", error);

      if (!res.writableEnded) {
        res.write(
          `data: ${JSON.stringify({
            reply: "Sorry, the chat service hit an error. Please try again.",
          })}\n\n`,
        );

        res.write("data: [DONE]\n\n");
        res.end();
      }
    }
  },
);
