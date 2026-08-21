import type { Metadata } from 'next';
import { Geist, Geist_Mono } from 'next/font/google';
import { Navbar } from '../components/Navbar';
import './globals.css';

const SITE = process.env.NEXT_PUBLIC_SITE_URL ?? 'https://oktzz.xyz';

const geistSans = Geist({ subsets: ['latin'], variable: '--font-geist-sans', display: 'swap' });
const geistMono = Geist_Mono({ subsets: ['latin'], variable: '--font-geist-mono', display: 'swap' });

const SITE_NAME = 'Manga - Baca Komik Bahasa Indonesia';
const SITE_DESC = 'Baca manga, manhwa, dan manhua terjemahan Bahasa Indonesia. Gratis, rapi, dan cepat.';

export const metadata: Metadata = {
  metadataBase: new URL(SITE),
  title: { default: SITE_NAME, template: `%s - Manga` },
  description: SITE_DESC,
  alternates: { canonical: '/' },
  openGraph: {
    title: SITE_NAME,
    description: SITE_DESC,
    type: 'website',
    locale: 'id_ID',
    siteName: 'Manga',
    url: SITE,
    images: [{ url: '/og.png', width: 1200, height: 630, alt: 'Manga - Baca Komik Bahasa Indonesia' }],
  },
  twitter: {
    card: 'summary_large_image',
    title: SITE_NAME,
    description: SITE_DESC,
    images: ['/og.png'],
  },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="id" className={`dark ${geistSans.variable} ${geistMono.variable}`}>
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
