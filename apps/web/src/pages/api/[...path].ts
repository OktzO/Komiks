import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { getOrigins } from '@/lib/api';
import { buildUpstreamHeaders, isProxyAllowed, relayHeaders, rotateOrigins } from '@/lib/bff-proxy';

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

// Dibaca langsung dari binding worker, bukan lewat globalThis yang diisi
// middleware: middleware tidak dijamin jalan sebelum endpoint dievaluasi pada
// modul yang sama, dan globalThis di isolate Workers tidak bisa jadi kontrak
// antar-modul.
const serviceTokenOf = (): string => {
  const rt = env as { SERVICE_TOKEN?: string };
  return (rt.SERVICE_TOKEN ?? '').trim();
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
  // Rotasi wajib, dan ini yang hilang ketika round-robin pindah dari client ke
  // server. getOrigins() selalu mengurutkan berdasarkan priority, jadi tanpa
  // rotasi SELURUH traffic proxy mendarat di satu worker — di sini
  // manga-api (akun1), yang tidak punya GOOGLE_CLIENT_ID sehingga /api/auth/*
  // balas 'google oauth not configured' dan 3 worker lain menganggur. Load
  // balancingacross 4 akun bukan hiasan: ini yang membagi beban dan Damit
  // satu worker jadi titik gagal tunggal.
  //
  // Rotasi acak per request, bukan kursor: proxy stateless (satu isolate bisa
  // melayani banyak request bersamaan), jadi tidak ada tempat storing kursor
  // tanpa jadi sumber kontensi.
  const originList = rotateOrigins(await getOrigins());
  for (const origin of originList) {
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
