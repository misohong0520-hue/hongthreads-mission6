import { redirectOriginalResource } from '@/lib/original-routes';
export const dynamic = 'force-dynamic';
export default async function ListPage({ params }: { params: Promise<{ resource: string }> }) {
  redirectOriginalResource((await params).resource);
}
