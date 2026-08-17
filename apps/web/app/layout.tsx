import type { Metadata } from 'next';
import { Navbar } from '../components/Navbar';
import './globals.css';

const SITE = process.env.NEXT_PUBLIC_SITE_URL ?? 'https://manga-web-d32.pages.dev';

export const metadata: Metadata = {
  metadataBase: new URL(SITE),
  title: 'Manga - Baca Komik Bahasa Indonesia',
  description: 'Baca manga, manhwa, dan manhua terjemahan Bahasa Indonesia. Gratis, rapi, dan cepat.',
  alternates: { canonical: '/' },
  openGraph: {
    title: 'Manga - Baca Komik Bahasa Indonesia',
    description: 'Baca manga, manhwa, dan manhua terjemahan Bahasa Indonesia. Gratis, rapi, dan cepat.',
    type: 'website',
    locale: 'id_ID',
    siteName: 'Manga',
  },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="id" className="dark">
      <head>
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{
            __html: JSON.stringify({
              '@context': 'https://schema.org',
              '@type': 'WebSite',
              name: 'Manga',
              url: SITE,
              potentialAction: {
                '@type': 'SearchAction',
                target: `${SITE}/search?q={search_term_string}`,
                'query-input': 'required name=search_term_string',
              },
            }).replaceAll('<', '\\u003c'),
          }}
        />
      </head>
      <body className="min-h-screen bg-base text-primary antialiased">
        <Navbar />
        <div className="pt-24">{children}</div>
      </body>
    </html>
  );
}
