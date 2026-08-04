import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Manga Reader',
  description: 'Baca manga/manhwa/manhua bahasa Indonesia',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="id">
      <body className="min-h-screen bg-base text-primary antialiased">{children}</body>
    </html>
  );
}
