import { Role } from "../../../../../prisma/generated/client/enums.js";

import type { Response } from "express";

import { logger } from "../../lib/logger.js";

import { memoryQueue } from "../../queue/memory.queue.js";

import {
  getRandomInjectionReply,
  isPromptInjection,
} from "../../security/prompt-injection.js";

import { createMessage, getRecentMessages } from "./chat.repository.js";

import { buildConversationContext } from "./chat.memory.js";

import { generateAIResponse } from "./chat.ai.js";

import { getLongTermMemories } from "../memory/memory.repository.js";

import { buildUserProfileContext } from "../memory/memory.context.js";

import { searchRelevantMemories } from "../memory/memory.vector.js";

import { buildSemanticMemoryContext } from "../memory/memory.semantic.js";

import { executeAgent } from "../agents/agent.service.js";

import { AgentAction } from "../agents/agent.types.js";

//! Core chat service handling chat + agents 🗣️🤖
export async function chatService(
  data: {
    userId: string;

    content: string;
  },

  res: Response,
) {
  logger.info(`🗣️ Processing message for user: ${data.userId}`);

  //===========================================================
  // 1️⃣ Security Check 🚨
  //===========================================================

  if (isPromptInjection(data.content)) {
    logger.warn("⚠️ Prompt injection detected");

    res.write(
      `data: ${JSON.stringify({
        reply: getRandomInjectionReply(),
      })}\n\n`,
    );

    res.write("data: [DONE]\n\n");

    res.end();

    return;
  }

  //===========================================================
  // 2️⃣ Save User Message 💾
  //===========================================================

  await createMessage({
    userId: data.userId,

    content: data.content,

    role: Role.user,
  });

  //===========================================================
  // 3️⃣ Agent Planner 🤖
  //===========================================================

  const agentResult = await executeAgent(
    data.userId,

    data.content,
  );

  //===========================================================
  // 4️⃣ Worker Action Detected ⚡
  //===========================================================

  if (agentResult.action !== AgentAction.CHAT) {
    logger.info(`🤖 Agent Action: ${agentResult.action}`);

    res.write(
      `data: ${JSON.stringify({
        reply: agentResult.reply,
      })}\n\n`,
    );

    res.write("data: [DONE]\n\n");

    res.end();

    return;
  }

  //===========================================================
  // 5️⃣ Load Context In Parallel 🧠
  //===========================================================

  const [recentMessages, memories, semanticMemories] = await Promise.all([
    getRecentMessages(data.userId),

    getLongTermMemories(data.userId),

    searchRelevantMemories(
      data.content,

      data.userId,
    ),
  ]);

  //===========================================================
  // 6️⃣ Build AI Context 🧩
  //===========================================================

  const context = buildConversationContext(recentMessages);

  const userProfile = buildUserProfileContext(memories);

  const semanticContext = buildSemanticMemoryContext(semanticMemories);

  logger.info("🧠 Context ready");

  //===========================================================
  // 7️⃣ Generate Streaming Response ✨
  //===========================================================

  const stream = await generateAIResponse(
    context,

    userProfile,

    semanticContext,
  );

  let accumulatedReply = "";

  //===========================================================
  // 8️⃣ Stream Chunks Live 🚀
  //===========================================================

  for await (const chunk of stream) {
    const text = chunk.choices[0]?.delta?.content || "";

    if (!text) {
      continue;
    }

    accumulatedReply += text;

    res.write(
      `data: ${JSON.stringify({
        reply: text,
      })}\n\n`,
    );
  }

  //===========================================================
  // 9️⃣ End Stream ✅
  //===========================================================

  res.write("data: [DONE]\n\n");

  res.end();

  logger.info("✅ Stream complete");

  //===========================================================
  // 🔟 Save Assistant Reply 💾
  //===========================================================

  createMessage({
    userId: data.userId,

    content: accumulatedReply,

    role: Role.assistant,
  }).catch((error) =>
    logger.error(
      "❌ Failed to save assistant reply",

      error,
    ),
  );

  //===========================================================
  // 1️⃣1️⃣ Queue Memory Processing 🧠
  //===========================================================

  memoryQueue
    .add(
      "process-memory",

      {
        userId: data.userId,

        message: data.content,
      },
    )
    .catch((error) =>
      logger.error(
        "❌ Failed to queue memory",

        error,
      ),
    );
}
