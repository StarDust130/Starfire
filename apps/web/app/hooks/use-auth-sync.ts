"use client";

import { useEffect } from "react";

import { useUser } from "@clerk/nextjs";

import axios from "axios";

// 🔄 Sync Clerk user with backend
export function useAuthSync() {
  const { user } = useUser();

  useEffect(() => {
    if (!user) {
      return;
    }

    const sync = async () => {
      try {
        const response = await axios.post(
          "http://localhost:8080/api/v1/auth/sync",

          {
            clerkId: user.id,

            name: user.fullName || "User",

            email: user.primaryEmailAddress?.emailAddress,
          },
        );

        // 💾 Save backend UUID
        localStorage.setItem(
          "userId",

          response.data.userId,
        );
      } catch (error) {
        console.error(error);
      }
    };

    sync();
  }, [user]);
}
