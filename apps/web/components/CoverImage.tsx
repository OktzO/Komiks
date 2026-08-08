'use client';

export function CoverImage({
  src,
  alt,
  title,
  className = '',
  zoom = false,
}: {
  src: string | null;
  alt: string;
  title?: string;
  className?: string;
  zoom?: boolean;
}) {
  if (!src) return <div className={`flex items-center justify-center bg-card p-2 text-center ${className}`}>{title ?? alt}</div>;
  return (
    <div className={`relative flex items-center justify-center overflow-hidden bg-card ${className}`}>
      <span className="absolute inset-0 flex items-center justify-center p-2 text-center text-[10px] leading-tight text-muted">{title ?? alt}</span>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={src}
        alt={alt}
        loading="lazy"
        className={`relative h-full w-full object-cover ${zoom ? 'transition-transform duration-300 group-hover:scale-[1.03]' : ''}`}
        onError={(e) => {
          e.currentTarget.style.display = 'none';
        }}
      />
    </div>
  );
}