// Astro server-render pass-through → attr harus lowercase HTML-valid (React TS tidak
// mengenalnya; spread tanpa cast lolos excess-property check).
const NO_REF = { referrerpolicy: "no-referrer" };
export function CoverImage({
  src,
  alt,
  title,
  className = '',
  zoom = false,
  priority = false,
  fit = 'contain',
}: {
  src: string | null;
  alt: string;
  title?: string;
  className?: string;
  zoom?: boolean;
  priority?: boolean;
  fit?: 'contain' | 'cover';
}) {
  if (!src) return <div className={`flex items-center justify-center bg-card p-2 text-center ${className}`}>{title ?? alt}</div>;
  // object-contain shows the full image without cropping (no zoom/cut-off).
  // object-cover fills the container, cropping edges — used only when caller
  // explicitly opts in (e.g. hero backgrounds where fill is desired).
  const objectClass = fit === 'cover' ? 'object-cover' : 'object-contain';
  return (
    <div className={`relative flex items-center justify-center overflow-hidden bg-card ${className}`}>
      <span className="absolute inset-0 flex items-center justify-center p-2 text-center text-[10px] leading-tight text-muted pointer-events-none">{title ?? alt}</span>
      <img
        src={src}
        alt={alt}
        loading={priority ? 'eager' : 'lazy'} {...NO_REF}
        fetchPriority={priority ? 'high' : 'auto'}
        decoding="async"
        className={`relative h-full w-full ${objectClass} ${zoom ? 'transition-transform duration-300 group-hover:scale-[1.03]' : ''}`}
      />
    </div>
  );
}

export default CoverImage;
