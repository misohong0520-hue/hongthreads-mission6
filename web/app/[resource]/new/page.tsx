import { notFound } from 'next/navigation';
import { getResource } from '@/lib/resources';
import ResourceForm from '@/components/ResourceForm';
export default async function NewPage({ params }: { params: Promise<{ resource: string }> }) { const { resource } = await params; const config = getResource(resource); if (!config || config.readonly) notFound(); return <ResourceForm config={config} />; }
