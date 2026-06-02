import { prisma } from "../../lib/prisma.js";

// 🔄 Find or create user
export async function authSync(data: {
  clerkId: string;

  name: string;

  email?: string;
}) {
  // 1️⃣ Find existing user
  const existingUser = await prisma.user.findUnique({
    where: {
      clerkId: data.clerkId,
    },
  });

  // 2️⃣ Return if exists
  if (existingUser) {
    return existingUser;
  }

  // 3️⃣ Create new user
  return prisma.user.create({
    data: {
      clerkId: data.clerkId,

      name: data.name,

      // Prisma expects string | null for optional string fields when
      // exactOptionalPropertyTypes is enabled.
      email: data.email ?? null,
    },
  });
}
