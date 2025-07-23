// app/(auth)/auth.config.ts
import type { NextAuthConfig } from "next-auth";
import CredentialsProvider from "next-auth/providers/credentials";

export const authConfig: NextAuthConfig = {
  pages: {
    signIn: "/login",
    newUser: "/",
  },

  providers: [
    CredentialsProvider({
      name: "Guest",
      credentials: {},

      async authorize() {
        // Note: `type` must be a valid UserType, so we use "user" here
        return {
          id: "guest",
          name: "Guest",
          type: "user",
        };
      },
    }),
  ],

  session: {
    strategy: "jwt",
  },

  // picks up either NEXTAUTH_SECRET or the alias SECRET
  secret: process.env.NEXTAUTH_SECRET || process.env.SECRET,
  
  callbacks: {
    // (you can leave this empty for now)
  },
} satisfies NextAuthConfig;
