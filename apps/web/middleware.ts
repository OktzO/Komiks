// Edge middleware: protect /admin/** routes.
// Edge runtime can't read Worker KV sessions, so this is a cookie-presence
// check only. Real role authz happens at the API layer (requireAdminSession)
// and page-level (fetchMe → role guard). No cookie → redirect to /.
// This prevents a flash of the admin shell for unauthenticated visitors.
import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

export function middleware(req: NextRequest) {
  const session = req.cookies.get('session')?.value;
  if (!session) {
    const url = req.nextUrl.clone();
    url.pathname = '/';
    url.search = '';
    return NextResponse.redirect(url);
  }
  return NextResponse.next();
}

export const config = {
  matcher: ['/admin/:path*'],
};
