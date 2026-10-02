// Helper murni untuk proxy BFF (src/pages/api/[...path].ts).
//
// Dipisah dari endpoint supaya bisa diuji tanpa runtime Astro: file ini tidak
// mengimpor apa pun, jadi aturan allowlist dan pemotongan header bisa
// diverifikasi langsung tanpa menjalankan worker.
//
// Tiga aturan di sini yang menentukan apakah penguncian API benar-benar berarti
// atau hanyaturnstile di atas kertas:
//
//   1. Token dari client SELALU dibuang. Kalau diteruskan, siapa pun bisa
//      menyamar sebagai manga-web — dan seluruh TOKEN_ONLY gate di worker API
//      kehilangan artinya.
//   2. Allowlist path dihitung per-segmen. Naive startsWith('/api/user') ikut
//      mencerna '/api/usersecret', dan tanpa proxy yang sebenarnya jadi jalan
//      BARU ke /api/_internal/* (yang punya key sendiri).
//   3. Semua Set-Cookie diteruskan. OAuth callback mengembalikan 302 + cookie
//      dalam satu respons; kehilangan satu di antaranya merusak login.

// Prefix API yang boleh lewat proxy. Dicocokkan dengan batas slash: '/api/user'
// TIDAK boleh cocok dengan '/api/users' atau '/api/userstuff'.
export const ALLOWED_PREFIXES: readonly string[] = [
  '/api/health',
  '/api/origins',
  '/api/auth',
  '/api/user',
  '/api/admin',
  '/api/series',
  '/api/search',
  '/api/homepage',
  '/api/reader',
  '/api/manga',
  '/api/novel',
  '/api/resolve',
  '/api/identify',
  '/api/source-status',
];

// Segmen yang punya credential sendiri dan tidak boleh boleh lewat proxy
// publik. Dipisah dari ALLOWED_PREFIXES supaya reviewer bisa melihatnya
// eksplisit, bukan harus menyimpulkan dari absennya.
const NEVER_VIA_PROXY: readonly string[] = ['/api/_internal', '/api/scrape'];

export const isProxyAllowed = (path: string): boolean => {
  if (!path.startsWith('/api/')) return false;
  for (const denied of NEVER_VIA_PROXY) {
    if (path === denied || path.startsWith(denied + '/')) return false;
  }
  return ALLOWED_PREFIXES.some((p) => path === p || path.startsWith(p + '/'));
};

// Header request milik koneksi atau identitas pengirim. Tidak boleh pindah ke
// worker: worker harus melihat request yang datang dari manga-web, bukan dari
// browser yang menyamar-nyamar lewat proxy.
const STRIPPED_REQUEST_HEADERS: ReadonlySet<string> = new Set([
  'host',
  'origin',
  'referer',
  'cf-connecting-ip',
  'cf-ipcountry',
  'cf-ray',
  'cf-visitor',
  'x-forwarded-for',
  'x-forwarded-proto',
  'x-service-token',
]);

export const buildUpstreamHeaders = (req: Request, token: string): Headers => {
  const out = new Headers();
  for (const [key, value] of req.headers) {
    const lower = key.toLowerCase();
    if (STRIPPED_REQUEST_HEADERS.has(lower)) continue;
    out.set(lower, value);
  }
  // Diset TERAKHIR supaya token worker pasti menang atas apa pun yang dikirim
  // client — bukan "kecuali kalau client tidak mengirim".
  out.set('x-service-token', token);
  return out;
};

// Header response yang tidak boleh keluar ke browser. x-service-token terutama:
// gateway kita tidak pernah mengirim token, jadi kalau worker membalikannya
// berarti ada kebocoran di sisi worker dan browser tidak boleh ikut mengetahuinya.
const STRIPPED_RESPONSE_HEADERS: ReadonlySet<string> = new Set([
  'x-service-token',
  'cf-ray',
  'set-cookie',
  'access-control-allow-origin',
  'access-control-allow-credentials',
]);

export const relayHeaders = (upstream: Headers): Headers => {
  const out = new Headers();
  for (const [key, value] of upstream) {
    const lower = key.toLowerCase();
    if (STRIPPED_RESPONSE_HEADERS.has(lower)) continue;
    out.set(lower, value);
  }
  // Set-Cookie di-set manual di bawah — iteration di atas tidak melihatnya.
  for (const cookie of upstream.getSetCookie()) out.append('set-cookie', cookie);
  return out;
};
