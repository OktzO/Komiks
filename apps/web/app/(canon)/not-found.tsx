import Link from 'next/link';

export default function NotFound() {
  return (
    <main className="max-w-2xl mx-auto px-4 py-16 text-center">
      <p className="font-mono text-[11px] uppercase tracking-[0.22em] text-muted">HTTP 404</p>
      <h1 className="mt-2 text-2xl font-semibold text-primary">Judul tidak ditemukan</h1>
      <p className="mt-2 text-sm text-secondary">Slug ini tidak cocok dengan judul mana pun di katalog.</p>
      <Link
        href="/"
        prefetch={false}
        className="mt-6 inline-flex h-11 items-center rounded-full bg-accent px-6 text-sm font-semibold text-zinc-950 hover:opacity-90"
      >
        Kembali ke Beranda
      </Link>
    </main>
  );
}
