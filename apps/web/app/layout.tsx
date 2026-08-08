import type { Metadata } from 'next';
import { Navbar } from '../components/Navbar';
import './globals.css';

export const metadata: Metadata = {
  title: 'Manga - Baca Komik Bahasa Indonesia',
  description: 'Baca manga, manhwa, dan manhua terjemahan Indonesia dari 4 sumber sekaligus. Gratis, rapi, dan cepat.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="id" className="dark">
      <body className="min-h-screen bg-base text-primary antialiased">
        <Navbar />
        <div className="pt-24">{children}</div>
      </body>
    </html>
  );
}
