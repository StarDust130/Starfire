import { AgentAction } from "./agent.types.js";

import { determineAction } from "./agent.ai.js";
import { jobQueue } from "../../queue/job.queue.js";
import { resumeQueue } from "../../queue/resume.queue.js";
import { emailQueue } from "../../queue/email.queue.js";



// 🤖 Agent planner
export async function executeAgent(
  userId: string,

  message: string,
) {
  // 1️⃣ Ask planner what to do
  const action = await determineAction(message);

  // 2️⃣ Route task
  switch (action) {
    case AgentAction.JOB_FINDER:
      await jobQueue.add(
        "find-jobs",

        {
          userId,

          query: message,
        },
      );

      return {
        action,

        reply: "🔍 Job search started...",
      };

    case AgentAction.RESUME_OPTIMIZER:
      await resumeQueue.add(
        "optimize-resume",

        {
          userId,

          resume: message,
        },
      );

      return {
        action,

        reply: "📄 Resume optimization started...",
      };

    case AgentAction.EMAIL_DRAFTER:
      await emailQueue.add(
        "draft-email",

        {
          userId,

          prompt: message,
        },
      );

      return {
        action,

        reply: "✉️ Email drafting started...",
      };

    default:
      return {
        action: AgentAction.CHAT,
      };
  }
}
