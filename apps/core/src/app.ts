import express from "express";
import type { Express } from "express";
import cors from "cors";
import helmet from "helmet";
import { errorMiddleware } from "./middleware/error.middleware.js";

import  healthRouter  from "./modules/health/health.route.js";
import  chatRouter  from "./modules/chat/chat.route.js";
import { queueMonitorRouter } from "./lib/queue-monitor.js";

import { resumeRouter } from "./modules/resume/resume.route.js";
import { emailRouter } from "./modules/email/email.route.js";
import { jobRouter } from "./modules/jobs/jobs.route.js";
import { telegramRouter } from "./modules/telegram/telegram.route.js";
import authRouter from "./modules/auth/auth.route.js";

export const app: Express = express();

app.use(
  cors({
    origin: process.env.FRONTEND_URL,
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
  }),
);
app.use(helmet());
app.use(express.json());

//! Routers 🪼📍
app.use("/api/v1/health", healthRouter);
app.use("/api/v1/chat", chatRouter);
// 🔐 Auth routes
app.use(
  "/api/v1/auth", authRouter);

// Worker routes 🍼
app.use("/api/email", emailRouter);
app.use("/api/resume", resumeRouter);
app.use("/api/job",jobRouter,);

// Telegram routes 🤖
app.use("/api/telegram",telegramRouter,);

// ⚡ Queue Monitor Dashboard
app.use("/admin/queues", queueMonitorRouter );

app.use(errorMiddleware);

export default app;
