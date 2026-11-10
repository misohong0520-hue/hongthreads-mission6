import { notFound } from 'next/navigation';
import { Suspense } from 'react';
import { getResource } from '@/lib/resources';
import ResourceDetail from '@/components/ResourceDetail';
export const dynamic = 'force-dynamic';
export default async function DetailPage({ params }: { params: Promise<{ resource: string; id: string }> }) { const { resource, id } = await params; const config = getResource(resource); if (!config) notFound(); return <Suspense><ResourceDetail config={config} id={id} /></Suspense>; }
