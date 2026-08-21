'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';

type IconProps = { className?: string };

function GridIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className={className}>
      <rect x="3" y="3" width="7" height="7" rx="1.5" />
      <rect x="14" y="3" width="7" height="7" rx="1.5" />
      <rect x="3" y="14" width="7" height="7" rx="1.5" />
      <rect x="14" y="14" width="7" height="7" rx="1.5" />
    </svg>
  );
}

function ActivityIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className={className}>
      <path d="M22 12h-4l-3 9L9 3l-3 9H2" />
    </svg>
  );
}

function UsersIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className={className}>
      <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
      <circle cx="9" cy="7" r="4" />
      <path d="M23 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75" />
    </svg>
  );
}

function MergeIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className={className}>
      <circle cx="18" cy="18" r="3" />
      <circle cx="6" cy="6" r="3" />
      <path d="M6 21V9a9 9 0 0 0 9 9" />
    </svg>
  );
}

function SlidersIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className={className}>
      <path d="M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1 14h6M9 8h6M17 16h6" />
    </svg>
  );
}

function BookIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className={className}>
      <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" />
      <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" />
    </svg>
  );
}

function HomeIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className={className}>
      <path d="m3 9 9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
      <path d="M9 22V12h6v10" />
    </svg>
  );
}

const NAV = [
  { href: '/admin', label: 'Dashboard', icon: GridIcon },
  { href: '/admin/monitoring', label: 'Monitoring', icon: ActivityIcon },
  { href: '/admin/users', label: 'Users', icon: UsersIcon },
  { href: '/admin/merge', label: 'Merge Queue', icon: MergeIcon },
  { href: '/admin/settings', label: 'Settings', icon: SlidersIcon },
];

export default function AdminLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const isActive = (href: string) =>
    href === '/admin' ? pathname === href : pathname === href || pathname.startsWith(href + '/');

  return (
    <div className="bg-base text-primary min-h-screen">
      <aside className="hidden md:flex fixed left-0 top-0 bottom-0 w-20 z-30 flex-col items-center gap-1.5 border-r border-border-subtle bg-elevated py-6">
        <Link
          href="/admin"
          className="w-11 h-11 mb-6 flex items-center justify-center rounded-2xl border border-border-subtle text-accent bg-base/60 transition-all duration-200 hover:border-border-default"
          aria-label="Admin home"
        >
          <BookIcon className="w-5 h-5" />
        </Link>
        <nav className="flex flex-col items-center gap-1.5">
          {NAV.map(({ href, label, icon: Icon }) => (
            <Link
              key={href}
              href={href}
              title={label}
              aria-label={label}
              className={`w-11 h-11 flex items-center justify-center rounded-xl transition-all duration-200 ${
                isActive(href)
                  ? 'bg-accent text-base shadow-lg shadow-black/30'
                  : 'text-secondary hover:text-primary hover:bg-bg-secondary'
              }`}
            >
              <Icon className="w-5 h-5" />
            </Link>
          ))}
        </nav>
        <div className="flex-1" />
        <Link
          href="/"
          title="Ke situs"
          aria-label="Ke situs"
          className="w-11 h-11 flex items-center justify-center rounded-xl text-secondary hover:text-primary hover:bg-bg-secondary transition-all duration-200"
        >
          <HomeIcon className="w-5 h-5" />
        </Link>
      </aside>
      <div className="md:ml-20 p-4 md:p-8">{children}</div>
    </div>
  );
}
