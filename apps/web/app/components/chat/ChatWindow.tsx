"use client";

import { useState, useRef, useEffect, useCallback } from "react";
import axios from "axios";
import { motion, AnimatePresence } from "framer-motion";
import { ChatInput } from "./ChatInput";
import { MessageBubble, Message } from "./MessageBubble";
import { ArrowDown } from "lucide-react";
import Image from "next/image";

export function ChatWindow() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [isThinking, setIsThinking] = useState(false);

  // FIXED: State declaration restored
  const [hasStarted, setHasStarted] = useState(false);

  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [showScrollBtn, setShowScrollBtn] = useState(false);
  const [isMounted, setIsMounted] = useState(false);

  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const abortControllerRef = useRef<AbortController | null>(null);

  const STORAGE_KEY = "starfire_chat_history";
  const TTL_MS = 24 * 60 * 60 * 1000;

  // Listen for the 'New Chat' signal from the Widget Header
  useEffect(() => {
    const handleClearChat = () => {
      setMessages([]); 
      setHasStarted(false); // <-- CRITICAL: Reset the greeting state
    };

    window.addEventListener("clear-starfire-chat", handleClearChat);
    return () => window.removeEventListener("clear-starfire-chat", handleClearChat);
  }, []);

  // Load from Storage
  useEffect(() => {
    setIsMounted(true);
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved) {
      try {
        const parsed = JSON.parse(saved);
        if (Date.now() - parsed.timestamp < TTL_MS) {
          const hydrated = parsed.messages.map((m: any) => ({
            ...m,
            timestamp: new Date(m.timestamp),
          }));
          setMessages(hydrated);
          if (hydrated.length > 0) setHasStarted(true);
        }
      } catch (e) {
        localStorage.removeItem(STORAGE_KEY);
      }
    }
  }, []);

  // Save to Storage
  useEffect(() => {
    if (isMounted && messages.length > 0) {
      localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({ messages, timestamp: Date.now() }),
      );
    }
  }, [messages, isMounted]);

  const adjustHeight = (el: HTMLTextAreaElement | null) => {
    if (!el) return;
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight, 180) + "px";
  };

  const handleInputChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setInput(e.target.value);
    adjustHeight(e.target);
  };

  const executePipeline = async (userText: string) => {
    const userMsg: Message = {
      id: Date.now().toString(),
      role: "user",
      content: userText.trim(),
    };

    setMessages((prev) => [...prev.filter((m) => !m.isError), userMsg]);
    setInput("");
    setIsLoading(true);
    setIsThinking(true);
    setHasStarted(true);

    if (textareaRef.current) textareaRef.current.style.height = "auto";
    abortControllerRef.current = new AbortController();

    try {
      const endpoint =
        `${process.env.NEXT_PUBLIC_BACKEND_API_URL}/api/v1/chat` ||
        "http://localhost:8080/api/v1/chat";

      const response = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
           userId: localStorage.getItem("userId"),
          content: userText,
        }),
        signal: abortControllerRef.current.signal,
      });

      // CRITICAL GUARD: Stop immediately if the backend returns an error (like a 404 HTML page)
      if (!response.ok) {
        throw new Error(
          `Backend Error: ${response.status} ${response.statusText}`,
        );
      }

      if (!response.body) throw new Error("No stream");
      const reader = response.body.getReader();
      const decoder = new TextDecoder();

      const botMsgId = Date.now().toString() + "_ai";
      let accumulatedText = "";
      let firstChunkReceived = false;
      let buffer = "";

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;

        if (!firstChunkReceived) {
          setIsThinking(false);
          firstChunkReceived = true;
        }

        // Add new incoming data to our buffer
        buffer += decoder.decode(value, { stream: true });

        // Split by newline. Streams often send multiple JSON objects separated by \n
        const lines = buffer.split("\n");

        // The last line might be incomplete (cut off mid-network transfer), so we keep it in the buffer
        buffer = lines.pop() || "";

        for (const line of lines) {
          const trimmedLine = line.trim();
          if (!trimmedLine) continue;

          // Strip "data: " prefix if your backend uses Server-Sent Events
          const jsonStr = trimmedLine.startsWith("data: ")
            ? trimmedLine.slice(6)
            : trimmedLine;

          if (jsonStr === "[DONE]") break;

          try {
            // Parse the JSON exactly as you specified: {"reply": " today"}
            const parsed = JSON.parse(jsonStr);

            if (parsed.reply !== undefined) {
              accumulatedText += parsed.reply;

              setMessages((prev) => {
                const exists = prev.find((m) => m.id === botMsgId);
                if (exists) {
                  return prev.map((m) =>
                    m.id === botMsgId ? { ...m, content: accumulatedText } : m,
                  );
                }
                return [
                  ...prev,
                  { id: botMsgId, role: "assistant", content: accumulatedText },
                ];
              });
            }
          } catch (e) {
            console.error("Failed to parse chunk:", trimmedLine);
          }
        }
      }
    } catch (err: any) {
      if (err.name !== "AbortError") {
        console.error("Pipeline failure:", err);
        setMessages((prev) => [
          ...prev,
          {
            id: Date.now().toString(),
            role: "assistant",
            content:
              "Connection failed. Please check if the backend is running.",
            isError: true,
          },
        ]);
      }
    } finally {
      setIsLoading(false);
      setIsThinking(false);
    }
  };

  const handleSubmit = (e?: React.FormEvent | React.KeyboardEvent) => {
    if (e) e.preventDefault();
    if (!input.trim() || isLoading) return;
    executePipeline(input);
  };

  const scrollToBottom = useCallback(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
    setShowScrollBtn(false);
  }, []);

  useEffect(() => {
    if (messages.length > 0) {
      const t = setTimeout(scrollToBottom, 50);
      return () => clearTimeout(t);
    }
  }, [messages, scrollToBottom]);

  const handleScroll = useCallback(() => {
    if (!scrollContainerRef.current) return;
    const { scrollTop, scrollHeight, clientHeight } =
      scrollContainerRef.current;
    setShowScrollBtn(scrollHeight - scrollTop - clientHeight > 100);
  }, []);

  const handleCopy = async (text: string, id: string) => {
    await navigator.clipboard.writeText(text);
    setCopiedId(id);
    setTimeout(() => setCopiedId(null), 2000);
  };

  return (
    <div className="flex flex-col h-full relative">
      <div
        ref={scrollContainerRef}
        onScroll={handleScroll}
        className="flex-1 overflow-y-auto px-5 py-6 custom-scrollbar"
      >
        <div className="max-w-3xl mx-auto space-y-8">
          {!hasStarted && (
            <motion.div
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              className="flex flex-col items-center justify-center h-full text-center mt-32 px-4"
            >
              <div className="mb-5">
                <Image
                  src="/starfire-2.png"
                  alt="StarFire"
                  width={170}
                  height={170}
                  priority
                  className="object-contain select-none"
                />
              </div>
              <h1 className="text-2xl md:text-3xl font-medium text-[var(--color-foreground)] tracking-tight">
                How can I help you today?
              </h1>
            </motion.div>
          )}

          <AnimatePresence mode="popLayout">
            {messages.map((msg) => (
              <MessageBubble
                key={msg.id}
                msg={msg}
                copiedId={copiedId}
                onCopy={handleCopy}
                onRetry={() => executePipeline(msg.content)}
              />
            ))}
          </AnimatePresence>

          {isThinking && (
            <div className="flex w-full justify-start items-center h-8">
              <div className="flex gap-1.5 items-center px-2">
                <motion.div
                  animate={{ opacity: [0.3, 1, 0.3] }}
                  transition={{ duration: 1, repeat: Infinity, delay: 0 }}
                  className="w-2 h-2 rounded-full bg-[var(--color-primary)]"
                />
                <motion.div
                  animate={{ opacity: [0.3, 1, 0.3] }}
                  transition={{ duration: 1, repeat: Infinity, delay: 0.2 }}
                  className="w-2 h-2 rounded-full bg-[var(--color-primary)]"
                />
                <motion.div
                  animate={{ opacity: [0.3, 1, 0.3] }}
                  transition={{ duration: 1, repeat: Infinity, delay: 0.4 }}
                  className="w-2 h-2 rounded-full bg-[var(--color-primary)]"
                />
              </div>
            </div>
          )}
          <div ref={messagesEndRef} className="h-4" />
        </div>
      </div>

      <AnimatePresence>
        {showScrollBtn && (
          <motion.button
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 10 }}
            onClick={scrollToBottom}
            className="absolute bottom-28 left-1/2 -translate-x-1/2 p-2.5 rounded-full bg-[var(--color-card)] border border-[var(--color-border)] text-[var(--color-foreground)] shadow-xl z-30 hover:bg-[var(--color-panel)] transition-colors"
          >
            <ArrowDown className="w-5 h-5" />
          </motion.button>
        )}
      </AnimatePresence>

   <ChatInput
        input={input}
        isLoading={isLoading}
        textareaRef={textareaRef}
        onChange={handleInputChange}
        onSubmit={handleSubmit}
        onStop={() => abortControllerRef.current?.abort()}
        setInput={setInput} 
      />
    </div>
  );
}
