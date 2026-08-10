// Edge middleware: /admin/** protection.
// Edge runtime cannot read Worker KV sessions, and the session cookie is
// scoped to the API domain (manga-api.oktz.workers.dev), not the frontend
// domain (oktzz.xyz). So this middleware does NOT gate on cookie presence —
// page-level fetchMe() handles the role check client-side after loading.
//
// Why not cookie-check here: the session cookie lives on the API origin, not
// the frontend origin. req.cookies on oktzz.xyz won't see it. Attempting to
// gate here would redirect even logged-in admins (the cookie never appears
// on the frontend domain). Page guard is the reliable gate.
//
// This file exists as a placeholder for future same-domain deployments
// where cookie-presence check would work. Currently a no-op pass-through.
import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

export function middleware(_req: NextRequest) {
  return NextResponse.next();
}

export const config = {
  matcher: ['/admin/:path*'],
};
