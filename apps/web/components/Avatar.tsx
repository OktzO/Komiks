import type { AuthUser } from '@/lib/api';

interface AvatarProps {
  user: Pick<AuthUser, 'display_name' | 'avatar_url' | 'email'> | null;
  size?: 'sm' | 'md' | 'lg';
  className?: string;
}

const DIMS = { sm: 'h-8 w-8', md: 'h-10 w-10', lg: 'h-14 w-14' };
const FONT = { sm: 'text-xs', md: 'text-sm', lg: 'text-xl' };

export function Avatar({ user, size = 'md', className }: AvatarProps) {
  const dim = `${DIMS[size]} ${className ?? ''}`;
  const font = FONT[size];

  if (user?.avatar_url) {
    return (
      <span className={`${dim} inline-block shrink-0 overflow-hidden rounded-full ring-1 ring-border-default bg-bg-secondary`}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={user.avatar_url} alt="" className="h-full w-full object-cover" loading="lazy" />
      </span>
    );
  }

  const initial = getInitial(user);
  const hue = stringToHue((user?.display_name ?? user?.email ?? '').toLowerCase());
  const bg = `hsl(${hue}, 22%, 22%)`;

  return (
    <span
      aria-label={initial}
      className={`${dim} inline-flex items-center justify-center rounded-full text-primary font-medium ${font} ring-1 ring-border-default select-none`}
      style={{ backgroundColor: bg }}
    >
      {initial}
    </span>
  );
}

function getInitial(user: AvatarProps['user']): string {
  if (!user) return '?';
  const d = user.display_name?.trim();
  const e = user.email?.trim();
  const src = d || e || '?';
  return src.charAt(0).toUpperCase();
}

function stringToHue(str: string): number {
  let h = 0;
  for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) % 360;
  return h;
}
