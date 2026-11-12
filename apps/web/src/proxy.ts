import { NextResponse, type NextRequest } from 'next/server';

/**
 * Fast redirect for page requests without a session cookie. This is a convenience
 * only: server layouts and every /v1 handler validate the session in the database.
 */
export function proxy(request: NextRequest) {
  const hasCookie = request.cookies.has('tp_session') || request.cookies.has('__Host-tp_session');
  if (!hasCookie) return NextResponse.redirect(new URL('/sign-in', request.url));
  return NextResponse.next();
}

export const config = {
  matcher: ['/((?!v1/|sign-in|account/|dev/|_next/|favicon.ico|icon.jpeg|.*\\.png$).*)']
};
