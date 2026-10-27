import { Skeleton } from "@/components/ui/skeleton";

export default function CvTemplatesLoading() {
  return <div className="mx-auto max-w-7xl px-4 py-6 sm:px-6" aria-label="Loading CV templates">
    <Skeleton className="h-9 w-64 max-w-full" />
    <Skeleton className="mt-4 h-4 w-96 max-w-full" />
    <div className="mt-8 grid gap-6 lg:grid-cols-2">
      <Skeleton className="h-[60vh] rounded-2xl" />
      <Skeleton className="h-[60vh] rounded-2xl" />
    </div>
  </div>;
}
