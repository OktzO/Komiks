'use client';
import Link from 'next/link';

export function AdminSection() {
  return (
    <section id="admin" className="mb-8 scroll-mt-20">
      <h2 className="text-lg font-semibold text-primary mb-1">Admin</h2>
      <p className="text-sm text-muted mb-4">Akses cepat ke panel administrasi.</p>
      <div className="rounded-xl border border-accent/20 bg-accent/5 p-4 max-w-md">
        <p className="text-sm text-secondary">
          Pengaturan Load Balancing (akun 1 + akun 2, auto-provision, origin pool) ada di
          menu hamburger <span className="text-primary font-medium">Load Balancing</span>, atau klik tombol di bawah.
        </p>
        <Link
          href="/admin/load-balancing"
          className="mt-3 inline-block px-4 py-2 text-sm font-medium text-accent border border-accent/30 rounded-lg hover:bg-accent/10 transition-colors"
        >
          Buka Load Balancing
        </Link>
      </div>
    </section>
  );
}
