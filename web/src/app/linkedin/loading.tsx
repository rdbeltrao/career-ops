import { Skeleton } from "@/components/ui/skeleton";

export default function LinkedInLoading() {
  return (
    <div className="mx-auto max-w-3xl px-6 py-8" aria-label="Loading LinkedIn">
      <div className="flex items-center gap-3">
        <Skeleton className="size-6 rounded-full" />
        <Skeleton className="h-8 w-32" />
      </div>
      <Skeleton className="mt-3 h-4 w-full max-w-xl" />
      <Skeleton className="mt-6 h-28 w-full rounded-xl" />
      <Skeleton className="mt-6 h-6 w-40" />
      <Skeleton className="mt-3 h-16 w-full rounded-xl" />
      <Skeleton className="mt-2 h-16 w-full rounded-xl" />
    </div>
  );
}
