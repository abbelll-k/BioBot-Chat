// app/(auth)/auth.config.ts
import type { NextAuthConfig } from "next-auth";
import CredentialsProvider from "next-auth/providers/credentials";

export const authConfig: NextAuthConfig = {
  // 1) tell NextAuth where to redirect for sign-in
  pages: {
    signIn: "/login",
    newUser: "/",  
  },

  // 2) wire up the guest credentials provider
  providers: [
    CredentialsProvider({
      name: "Guest",
      credentials: {},    // no form fields
      async authorize() {
        // every visitor becomes a "guest"
        return { id: "guest", name: "Guest" };
      },
    }),
  ],

  // 3) store sessions as JWTs
  session: {
    strategy: "jwt",
  },

  // 4) your secret must match your Vercel NEXTAUTH_SECRET or SECRET var
  secret: process.env.NEXTAUTH_SECRET || process.env.SECRET,

  callbacks: {
    // you can add JWT or session callbacks here if needed
  },
} satisfies NextAuthConfig;
