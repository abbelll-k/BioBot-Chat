import { NextResponse, type NextRequest } from 'next/server';
import { getToken } from 'next-auth/jwt';
import { guestRegex, isDevelopmentEnvironment } from './lib/constants';

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // Allow Playwright “/ping” check
  if (pathname.startsWith('/ping')) {
    return new Response('pong', { status: 200 });
  }

  // Don’t enforce auth on NextAuth routes
  if (pathname.startsWith('/api/auth')) {
    return NextResponse.next();
  }

  // Grab the JWT (must use NEXTAUTH_SECRET or SECRET)
  const token = await getToken({
    req: request,
    secret: process.env.NEXTAUTH_SECRET || process.env.SECRET,
    secureCookie: !isDevelopmentEnvironment,
  });

  // If no token, force “guest” sign-in
  if (!token) {
    const redirectUrl = encodeURIComponent(request.url);
    return NextResponse.redirect(
      new URL(`/api/auth/guest?redirectUrl=${redirectUrl}`, request.url)
    );
  }

  // If a real user is signed in, block access to /login & /register
  const isGuest = guestRegex.test(token.email ?? '');
  if (token && !isGuest && ['/login', '/register'].includes(pathname)) {
    return NextResponse.redirect(new URL('/', request.url));
  }

  return NextResponse.next();
}

export const config = {
  matcher: [
    '/',
    '/chat/:id',
    '/api/:path*',
    '/login',
    '/register',
    '/((?!_next/static|_next/image|favicon.ico|sitemap.xml|robots.txt).*)',
  ],
};
