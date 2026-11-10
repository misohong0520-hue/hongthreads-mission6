import { redirectOriginalResource } from '@/lib/original-routes';
export const dynamic = 'force-dynamic';
export default async function EditPage({ params }: { params: Promise<{ resource: string; id: string }> }) {
  redirectOriginalResource((await params).resource);
}
