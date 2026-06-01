"use client";

import { useEffect, useCallback, useState } from "react";
import { StopCircle, ArrowUp, Plus, Expand, Shrink, Mic } from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";

interface ChatInputProps {
  input: string;
  isLoading: boolean;
  textareaRef: React.RefObject<HTMLTextAreaElement | null>;
  onChange: (e: React.ChangeEvent<HTMLTextAreaElement>) => void;
  onSubmit: (e?: React.FormEvent | React.KeyboardEvent) => void;
  onStop: () => void;
  setInput: (value: string) => void;
}

const DRAFT_KEY = "starfire_draft";

export function ChatInput({
  input,
  isLoading,
  textareaRef,
  onChange,
  onSubmit,
  onStop,
  setInput,
}: ChatInputProps) {
  const [isExpanded, setIsExpanded] = useState(false);

  // Smart logic: Only show expand if text is long or has line breaks
  const showExpand = input.length > 150 || input.includes("\n") || isExpanded;

  // 1. Hydrate draft on mount
  useEffect(() => {
    const savedDraft = localStorage.getItem(DRAFT_KEY);
    if (savedDraft) {
      setInput(savedDraft);
      if (textareaRef.current) {
        setTimeout(() => {
          if (textareaRef.current) {
            textareaRef.current.style.height = "auto";
            textareaRef.current.style.height =
              Math.min(textareaRef.current.scrollHeight, 300) + "px";
          }
        }, 10);
      }
    }
  }, [setInput, textareaRef]);

  // 2. Auto-save draft on change
  useEffect(() => {
    if (input.trim() === "") {
      localStorage.removeItem(DRAFT_KEY);
    } else {
      localStorage.setItem(DRAFT_KEY, input);
    }
  }, [input]);

  // 3. Wrapper for submit to clear the draft immediately
  const handleWrapperSubmit = useCallback(
    (e?: React.FormEvent | React.KeyboardEvent) => {
      if (e) e.preventDefault();
      if (!input.trim() || isLoading) return;

      localStorage.removeItem(DRAFT_KEY);
      setIsExpanded(false);
      onSubmit(e);
    },
    [input, isLoading, onSubmit],
  );

  return (
    <div className="shrink-0 px-4 pt-2 pb-6 relative z-20 bg-gradient-to-t from-[var(--color-bg)] via-[var(--color-bg)] to-transparent">
      {/* FIX 1: Removed 'group' from the form to stop global tooltip triggering */}
      <form
        onSubmit={handleWrapperSubmit}
        className="max-w-3xl mx-auto relative"
      >
        {/* FIX 2: Removed 'overflow-hidden' so tooltips can float above the border */}
        <div className="relative flex flex-col rounded-[26px] border bg-[var(--color-card)] border-zinc-700/50 focus-within:border-zinc-400 focus-within:bg-[var(--color-card)] focus-within:ring-4 focus-within:ring-zinc-500/10 transition-all duration-200 shadow-sm p-1.5">
          {/* Top Section: Text Area & Expand Button */}
          <div className="relative w-full">
            <textarea
              ref={textareaRef}
              value={input}
              onChange={onChange}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  handleWrapperSubmit(e);
                }
              }}
              placeholder="Message StarFire..."
              rows={1}
              className={`w-full bg-transparent pt-3.5 pb-2 pl-4 pr-12 outline-none text-[15px] leading-relaxed text-[var(--color-foreground)] placeholder-[var(--color-muted)] resize-none overflow-y-auto custom-scrollbar transition-all duration-300 ease-[cubic-bezier(0.23,1,0.32,1)] ${
                isExpanded
                  ? "max-h-[60vh] min-h-[40vh]"
                  : "max-h-[180px] min-h-[24px]"
              }`}
            />

            {/* Expand / Shrink Button */}
            <AnimatePresence>
              {showExpand && (
                <motion.button
                  initial={{ opacity: 0, scale: 0.8 }}
                  animate={{ opacity: 1, scale: 1 }}
                  exit={{ opacity: 0, scale: 0.8 }}
                  transition={{ duration: 0.2 }}
                  type="button"
                  onClick={() => {
                    setIsExpanded(!isExpanded);
                    if (textareaRef.current) textareaRef.current.focus();
                  }}
                  className="absolute top-2 right-2 w-8 h-8 flex items-center justify-center rounded-lg text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800/80 transition-colors z-10 outline-none"
                  title={isExpanded ? "Minimize" : "Expand"}
                >
                  {isExpanded ? (
                    <Shrink className="w-[15px] h-[15px]" strokeWidth={2} />
                  ) : (
                    <Expand className="w-[15px] h-[15px]" strokeWidth={2} />
                  )}
                </motion.button>
              )}
            </AnimatePresence>
          </div>

          {/* Bottom Section: Action Bar */}
          <div className="flex items-center justify-between pl-2 pr-1 pb-1 pt-1">
            {/* Left: Plus & Mic Buttons */}
            <div className="flex items-center gap-1 relative z-30">
              
                <button
                  type="button"
                  title="Coming Soon"
                  disabled
                  className="w-9 h-9 flex items-center justify-center rounded-full text-zinc-500 hover:text-zinc-400 hover:bg-zinc-800/50 transition-colors disabled:cursor-not-allowed outline-none"
                  aria-label="Attach File"
                >
                  <Plus className="w-5 h-5 stroke-[2px]" />
                </button>
              
              
                <button
                  type="button"
                  disabled
                  title="Coming Soon"
                  className="w-9 h-9 flex items-center justify-center rounded-full text-zinc-500 hover:text-zinc-400 hover:bg-zinc-800/50 transition-colors disabled:cursor-not-allowed outline-none"
                  aria-label="Voice Input"
                >
                  <Mic className="w-4 h-4 stroke-[2px]" />
                </button>
                          </div>

            {/* Right: Send / Stop Buttons */}
            <div className="shrink-0 relative z-30">
              <AnimatePresence mode="wait">
                {isLoading ? (
                  <motion.button
                    key="stop"
                    initial={{ scale: 0.8, opacity: 0 }}
                    animate={{ scale: 1, opacity: 1 }}
                    exit={{ scale: 0.8, opacity: 0 }}
                    transition={{ duration: 0.15 }}
                    type="button"
                    onClick={onStop}
                    className="w-10 h-10 rounded-full flex items-center justify-center text-zinc-400 hover:text-red-400 hover:bg-red-500/10 transition-colors outline-none cursor-pointer"
                    title="Halt Generation"
                  >
                    <StopCircle className="w-6 h-6" strokeWidth={1.5} />
                  </motion.button>
                ) : (
                  <motion.button
                    key="send"
                    initial={{ scale: 0.8, opacity: 0 }}
                    animate={{ scale: 1, opacity: 1 }}
                    exit={{ scale: 0.8, opacity: 0 }}
                    transition={{ duration: 0.15 }}
                    type="submit"
                    disabled={!input.trim()}
                    className="w-10 h-10 rounded-full flex items-center justify-center transition-all duration-200 disabled:opacity-30 disabled:cursor-not-allowed bg-zinc-100 text-zinc-900 disabled:bg-zinc-800 disabled:text-zinc-600 hover:bg-white active:scale-95 shadow-sm outline-none cursor-pointer"
                  >
                    <ArrowUp className="w-5 h-5 stroke-[2.5px]" />
                  </motion.button>
                )}
              </AnimatePresence>
            </div>
          </div>
        </div>
      </form>
    </div>
  );
}
