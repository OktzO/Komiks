import type { APIRoute } from 'astro';
import { getOrigins } from '@/lib/api';
import { buildUpstreamHeaders, isProxyAllowed, relayHeaders } from '@/lib/bff-proxy';

// BFF proxy: satu-satunya pintu masuk ke worker API.
//
// Semua trafik browser melewati sini, dan di sinilah SERVICE_TOKEN disisipkan.
// Worker API menolak apa pun yang tidak membawa token itu (serviceGate
// token-only), jadi proxy inilah yang membuat penguncian itu mungkin tanpa
// membocorkan token ke browser — token hanya hidup di memori worker dan tidak
// pernah sampai ke client.
//
// Aturan allowlist dan pemotongan header ada di src/lib/bff-proxy.ts supaya bisa
// diuji tanpa runtime Astro.
export const prerender = false;

const json = (body: unknown, status: number): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });

// Diisi middleware.ts (src/middleware.ts) dari binding SERVICE_TOKEN worker,
// dibaca lewat cloudflare:workers karena Astro>=6 tidak menyediakan
// locals.runtime.env.
const serviceTokenOf = (): string => {
  const g = globalThis as { __SERVICE_TOKEN__?: string };
  return (g.__SERVICE_TOKEN__ ?? '').trim();
};

export const ALL: APIRoute = async ({ request, params }) => {
  const path = `/api/${params.path ?? ''}`;
  if (!isProxyAllowed(path)) return json({ error: 'not found' }, 404);

  const token = serviceTokenOf();
  if (!token) {
    // Fail-closed. Tanpa token, worker API akan menolak semua request juga —
    // jadi kegagalan diam-diam cuma mengubah 403 jadi halaman kosong. Error
    // yang jelas lebih murah didiagnosis.
    return json({ error: 'proxy not configured' }, 503);
  }

  const url = new URL(request.url);
  const upstream = `${path}${url.search}`;
  const headers = buildUpstreamHeaders(request, token);

  const hasBody = request.method !== 'GET' && request.method !== 'HEAD';
  const body = hasBody ? await request.arrayBuffer() : undefined;

  let lastError = 'no origin';
  for (const origin of await getOrigins()) {
    try {
      const res = await fetch(`${origin.url}${upstream}`, {
        method: request.method,
        headers,
        body,
        // redirect: 'manual' wajib. OAuth callback mengembalikan 302 +
        // Set-Cookie dalam satu respons; kalau fetch mengikuti redirect-nya,
        // cookie-nya hilang dan login tidak akan pernah selesai.
        redirect: 'manual',
        signal: AbortSignal.timeout(15000),
      });
      const relayed = relayHeaders(res.headers);
      // Response per-user tidak boleh nyangkut di cache edge manga-web.
      if (!relayed.has('cache-control')) relayed.set('Cache-Control', 'no-store');
      return new Response(res.body, { status: res.status, headers: relayed });
    } catch (e) {
      lastError = e instanceof Error ? e.message : String(e);
    }
  }
  return json({ error: 'upstream unavailable', detail: lastError }, 502);
};
