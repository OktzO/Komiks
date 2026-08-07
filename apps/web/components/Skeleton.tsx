// Skeleton building blocks — shimmer placeholders for loading states.

export function Skeleton({ className = '' }: { className?: string }) {
  return <div className={`skeleton ${className}`} aria-hidden="true" />;
}

// Manga detail page skeleton: cover + title bars + synopsis lines + chapter rows.
export function DetailSkeleton() {
  return (
    <div className="max-w-3xl mx-auto px-4 py-6" aria-busy="true">
      <div className="flex flex-col items-center mb-6">
        <Skeleton className="w-36 h-52 rounded-xl" />
        <Skeleton className="h-6 w-48 mt-4" />
        <Skeleton className="h-3 w-24 mt-2" />
      </div>
      <Skeleton className="h-4 w-full mb-2" />
      <Skeleton className="h-4 w-11/12 mb-2" />
      <Skeleton className="h-4 w-3/4 mb-6" />
      {Array.from({ length: 8 }).map((_, i) => (
        <Skeleton key={i} className="h-11 w-full mb-2" />
      ))}
    </div>
  );
}

// Chapter reader skeleton: toolbar + a few page slots.
export function ReaderSkeleton({ pageCount = 3 }: { pageCount?: number }) {
  return (
    <div aria-busy="true">
      <Skeleton className="h-10 w-full mb-4" />
      {Array.from({ length: pageCount }).map((_, i) => (
        <div key={i} className="flex justify-center mb-1">
          <Skeleton className="w-full max-w-xl aspect-[3/4]" />
        </div>
      ))}
    </div>
  );
}

// Home page skeleton: hero + carousel + grid rows.
export function HomeSkeleton() {
  return (
    <div aria-busy="true">
      <Skeleton className="h-40 w-full max-w-2xl mx-auto mb-8" />
      <Skeleton className="h-6 w-40 mb-4" />
      <div className="flex gap-3 overflow-hidden mb-8">
        {Array.from({ length: 5 }).map((_, i) => (
          <Skeleton key={i} className="h-52 w-36 shrink-0" />
        ))}
      </div>
      <Skeleton className="h-6 w-40 mb-4" />
      <div className="grid grid-cols-3 md:grid-cols-5 gap-3">
        {Array.from({ length: 10 }).map((_, i) => (
          <Skeleton key={i} className="aspect-[3/4] w-full" />
        ))}
      </div>
    </div>
  );
}