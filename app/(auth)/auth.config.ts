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
        // Must include `type` to satisfy NextAuth's User type
        return {
          id: "guest",
          name: "Guest",
          type: "credentials",
        };
      },
    }),
  ],
  session: {
    strategy: "jwt",
  },
  secret: process.env.NEXTAUTH_SECRET || process.env.SECRET,
  callbacks: {},
} satisfies NextAuthConfig;
