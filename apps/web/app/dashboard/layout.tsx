"use client";
import { useState } from "react";
import { Sidebar, MobileHeader } from "../components/Sidebar";
import AIChatWidget from "./chat/AIChatWidget";
import { ChatDrawerProvider, useChatDrawer } from "./chat/ChatDrawerContext";
import { useAuthSync } from "../hooks/use-auth-sync";


export default function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const [mobileOpen, setMobileOpen] = useState(false);

  return (
    <ChatDrawerProvider>
      <DashboardLayoutContent
        mobileOpen={mobileOpen}
        setMobileOpen={setMobileOpen}
      >
        {children}
      </DashboardLayoutContent>
    </ChatDrawerProvider>
  );
}

function DashboardLayoutContent({
  children,
  mobileOpen,
  setMobileOpen,
}: {
  children: React.ReactNode;
  mobileOpen: boolean;
  setMobileOpen: (open: boolean) => void;
}) {
  const { isOpen: chatOpen } = useChatDrawer();

  return (
    <div className="flex h-screen bg-black text-white overflow-hidden font-sans selection:bg-white/30">
      <Sidebar mobileOpen={mobileOpen} setMobileOpen={setMobileOpen} />

      {/* Main Content Area */}
      <main className="flex-1 relative overflow-hidden bg-black flex flex-col min-w-0">
        {!chatOpen && <MobileHeader setMobileOpen={setMobileOpen} />}

        {/* Ambient Tech Grid & Glow */}
        <div className="absolute inset-0 bg-[linear-gradient(to_right,rgba(255,255,255,0.03)_1px,transparent_1px),linear-gradient(to_bottom,rgba(255,255,255,0.03)_1px,transparent_1px)] bg-[size:4rem_4rem] [mask-image:radial-gradient(ellipse_60%_50%_at_50%_0%,#000_70%,transparent_100%)] opacity-50 pointer-events-none" />
        <div className="absolute top-0 right-0 w-[500px] h-[500px] bg-white/5 rounded-full blur-[100px] pointer-events-none -z-10" />
        <div className="absolute bottom-0 left-0 w-[500px] h-[500px] bg-white/5 rounded-full blur-[100px] pointer-events-none -z-10" />

        <div className="flex-1 overflow-y-auto overflow-x-hidden relative custom-scrollbar z-0">
          <div className="p-4 md:p-8 lg:p-10 w-full mx-auto min-h-max max-w-[1600px]">
            <AuthProvider />
            {children}
            <AIChatWidget />
          </div>
        </div>
      </main>
    </div>
  );
}

function AuthProvider() {
  useAuthSync();

  return null;
}