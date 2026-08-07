import { HomeSkeleton } from '@/components/Skeleton';

export default function Loading() {
  return (
    <div className="pt-24">
      <div className="route-progress" aria-hidden="true" />
      <div className="max-w-5xl mx-auto px-4">
        <HomeSkeleton />
      </div>
    </div>
  );
}
