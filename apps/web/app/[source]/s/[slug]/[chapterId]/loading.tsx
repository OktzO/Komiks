import { ReaderSkeleton } from '@/components/Skeleton';

export default function Loading() {
  return (
    <div className="max-w-3xl mx-auto px-4 py-6">
      <ReaderSkeleton pageCount={2} />
    </div>
  );
}
