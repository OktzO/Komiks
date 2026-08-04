import type { Metadata } from 'next';
import Link from 'next/link';
import './globals.css';

export const metadata: Metadata = {
  title: 'Manga Reader',
  description: 'Baca manga/manhwa/manhua bahasa Indonesia',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="id">
      <body className="min-h-screen bg-base text-primary antialiased">
        <nav className="border-b border-subtle bg-elevated">
          <div className="max-w-6xl mx-auto px-4 h-12 flex items-center gap-6">
            <Link href="/" className="font-semibold text-primary hover:text-accent">Manga Reader</Link>
            <Link href="/search" className="text-sm text-secondary hover:text-accent">Cari</Link>
            <Link href="/bookmark" className="text-sm text-secondary hover:text-accent">Bookmark</Link>
            <Link href="/history" className="text-sm text-secondary hover:text-accent">Riwayat</Link>
            <Link href="/login" className="text-sm text-secondary hover:text-accent ml-auto">Masuk</Link>
          </div>
        </nav>
        {children}
      </body>
    </html>
  );
}
