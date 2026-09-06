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

// Home page skeleton: bento grid + carousel + list rows.
export function HomeSkeleton() {
  return (
    <div aria-busy="true" className="space-y-12">
      {/* Bento Grid Skeleton */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-4">
        <div className="lg:col-span-7 h-[360px]">
          <Skeleton className="h-full w-full rounded-xl" />
        </div>
        <div className="lg:col-span-5 grid grid-cols-2 gap-3.5">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-40 w-full rounded-xl" />
          ))}
        </div>
      </div>

      {/* Horizontal Carousel Skeleton */}
      <div>
        <Skeleton className="h-6 w-48 mb-4" />
        <div className="flex gap-4 overflow-hidden">
          {Array.from({ length: 6 }).map((_, i) => (
            <Skeleton key={i} className="h-56 w-36 sm:w-40 shrink-0 rounded-lg" />
          ))}
        </div>
      </div>

      {/* 2-col Update Rows Skeleton */}
      <div>
        <Skeleton className="h-6 w-48 mb-4" />
        <div className="grid md:grid-cols-2 gap-4">
          {Array.from({ length: 6 }).map((_, i) => (
            <Skeleton key={i} className="h-20 w-full rounded-lg" />
          ))}
        </div>
      </div>
    </div>
  );
}
