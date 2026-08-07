#!/usr/bin/env node
// Setup akun R2 baru untuk multi-account storage.
// Jalankan: node scripts/setup-r2-account.mjs
// Output: langkah manual + JSON snippet untuk R2_ACCOUNTS + NEXT_PUBLIC_R2_DOMAINS.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = fileURLToPath(new URL('.', import.meta.url));
const envFile = process.argv[2] || '.dev.vars';
console.log(`[setup-r2-account] membaca akun existing dari apps/api-cf/${envFile} ...`);

let existing = [];
try {
  const raw = readFileSync(path.resolve(here, `../apps/api-cf/${envFile}`), 'utf8');
  const m = raw.match(/R2_ACCOUNTS=(\{.*)/s);
  if (m) existing = JSON.parse(m[1]);
} catch { /* belum ada — akun pertama */ }

const index = existing.length + 1; // 1-based untuk penamaan domain
const domain = `cdn${index}.example.com`; // ← GANTI ke domain milikmu

console.log(`
== LANGKAH SETUP AKUN R2 #${index} ==

1. Dashboard akun Cloudflare baru → R2 → buat bucket "manga-images"
2. Buat R2 API token (Access Key ID + Secret Access Key):
   R2 → Manage R2 API Tokens → Create API token
   - Permission: Object Read & Write (SKIP Admin — cukup read/write object)
   - Scope: bucket manga-images
   - Simpan kredensial segera (secret hanya tampil sekali!)
3. Hubungkan custom domain:
   bucket → Settings → Custom Domains → Add → ${domain}
   (butuh zone ${domain.split('.').slice(-2).join('.')} terdaftar di akun tsb)
4. Lifecycle rule (dari akun tsb, wrangler login akun tsb):
   npx wrangler r2 bucket lifecycle set manga-images --file - <<'EOF'
   { "Rules": [ { "ID": "evict-komiku", "Status": "Enabled",
       "Filter": { "Prefix": "komiku/" },
       "Expiration": { "Days": 30 } } ] }
   EOF
   (ganti Days sesuai R2_EVICTION_DAYS)

5. Tambahkan entry ke secret Worker (primary account):
   echo -n '<R2_ACCOUNTS-lengkap-JSON>' | npx wrangler secret put R2_ACCOUNTS --config apps/api-cf/wrangler.toml
6. Tambahkan domain ke frontend env (apps/web/.env.production):
   NEXT_PUBLIC_R2_DOMAINS='${[...existing.map((a) => a.public_domain), domain].join(',')}'
7. Verifikasi: curl -I https://${domain}/komiku/test-obj → 200
8. Remap report (migrasi otomatis via cache-aside):
   node -e "import('./packages/shared/src/r2-routing.ts').then(m => {
     const oldA = ${JSON.stringify(existing.map((a) => a.public_domain))};
     const newA = [...oldA, '${domain}'];
     const keys = ['naruto','one-piece','boruto'];  // ganti: list slug asli dari D1
     console.log(m.generateRemapReport(keys, oldA, newA, 32));
   })"
   Monga yang pindah akun otomatis di-re-fetch saat user baca (cache-aside). Tak perlu aksi.

Entry JSON untuk R2_ACCOUNTS (untuk ditambahkan ke array existing):
  {"account_id": "<ACCOUNT_ID>", "access_key_id": "<ACCESS_KEY_ID>", "secret_access_key": "<SECRET>", "public_domain": "${domain}"}
`);