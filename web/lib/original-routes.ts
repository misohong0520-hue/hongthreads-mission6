import { notFound, redirect } from 'next/navigation';

const resourceDestinations: Record<string, string> = {
  benchmarks: '/dashboard/benchmark',
  folders: '/dashboard/benchmark',
  drafts: '/dashboard/threads',
  personas: '/dashboard/personas',
  templates: '/multi-write',
  sessions: '/multi-write',
  revenue: '/dashboard/revenue',
  generations: '/write',
};
const destinations = new Set(['/dashboard/insights', '/__live/', ...Object.values(resourceDestinations)]);

export function redirectOriginal(path: string): never {
  if (!destinations.has(path)) notFound();
  // Next prefixes root-relative redirects with /workspace. An absolute URL
  // leaves that retired UI and returns to the original application's routes.
  const origin = new URL(process.env.PUBLIC_ORIGIN || 'http://127.0.0.1:9251');
  redirect(new URL(path, origin.origin).href);
}

export function redirectOriginalResource(resource: string): never {
  const path = Object.hasOwn(resourceDestinations, resource) ? resourceDestinations[resource] : undefined;
  if (!path) notFound();
  redirectOriginal(path);
}
