# ToS / Acceptable Use Policy Review (WAJIB sebelum production live)

> Arsitektur pakai banyak akun Cloudflare untuk menggandakan kuota free tier.
> Review kebijakan resmi Cloudflare terkini sebelum production live — proses
> review manual, bukan otomatis.

- [ ] Review Acceptable Use Policy Cloudflare terkini:
      https://www.cloudflare.com/terms/ + https://www.cloudflare.com/trust-hub/
- [ ] Multi-account untuk melipatgandakan free tier — pastikan sesuai
      kebijakan penggunaan yang wajar; verifikasi ulang tiap ToS berubah
- [ ] Rehost gambar Komiku — keputusan user (MangaDex tetap proxy; ToS
      MangaDex melarang rehost, sumber Komiku tidak memiliki ToS API ketat)
- [ ] Storage terkendali: lifecycle 30 hari mencegah penumpukan (10GB/akun
      free tier R2)
- [ ] Catat tanggal review + hasil di bawah ini:

  Tanggal: ___
  Hasil: ___

## Referensi dokumentasi (diakses 2026-08-07)

- R2 free tier: 10GB-month/akun, Class A 1M/bulan, Class B 10M/bulan,
  egress gratis
- Lifecycle rule: hanya berbasis umur (`Expiration.Days`), bukan last-access
- KV Free: 1.000 writes/day, eventually consistent → tidak cocok untuk
  counter presisi (desain: quota di D1)
- Workers Free: 100k req/day, CPU 10ms/req → kompresi gambar via WASM tidak
  feasible; upload asli (stream)