import { groq } from "../../lib/ai.js";

import { AgentAction } from "./agent.types.js";

// 🧠 Decide which worker should handle the task
export async function determineAction(message: string): Promise<AgentAction> {
  const completion = await groq.chat.completions.create({
    model: "llama-3.1-8b-instant",

    temperature: 0,

    messages: [
      {
        role: "system",

        content: `
You are an AI planner.

Return ONLY one value:

chat
job_finder
resume_optimizer
email_drafter

Examples:

"hello"
→ chat

"find AI jobs"
→ job_finder

"optimize my resume"
→ resume_optimizer

"write recruiter email"
→ email_drafter
`,
      },

      {
        role: "user",

        content: message,
      },
    ],
  });

  const action = completion.choices[0]?.message?.content?.trim()?.toLowerCase();

  switch (action) {
    case AgentAction.JOB_FINDER:
      return AgentAction.JOB_FINDER;

    case AgentAction.RESUME_OPTIMIZER:
      return AgentAction.RESUME_OPTIMIZER;

    case AgentAction.EMAIL_DRAFTER:
      return AgentAction.EMAIL_DRAFTER;

    default:
      return AgentAction.CHAT;
  }
}
