import { notFound } from 'next/navigation';
import { Suspense } from 'react';
import { getResource } from '@/lib/resources';
import ResourceList from '@/components/ResourceList';
export const dynamic = 'force-dynamic';
export default async function ListPage({ params }: { params: Promise<{ resource: string }> }) { const { resource } = await params; const config = getResource(resource); if (!config) notFound(); return <Suspense><ResourceList config={config} /></Suspense>; }
