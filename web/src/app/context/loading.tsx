import { Skeleton } from "@/components/ui/skeleton";

export default function ContextLoading() {
  return <div className="mx-auto w-full max-w-[1500px] px-4 py-6 sm:px-6" aria-label="Loading career workspace"><Skeleton className="mb-6 h-10 w-64" /><div className="grid gap-6 lg:grid-cols-[240px_minmax(0,1fr)]"><Skeleton className="hidden h-[60vh] rounded-2xl lg:block" /><Skeleton className="h-[60vh] rounded-2xl" /></div></div>;
}
