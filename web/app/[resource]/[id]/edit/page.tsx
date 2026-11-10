import { notFound } from 'next/navigation';
import { getResource } from '@/lib/resources';
import ResourceForm from '@/components/ResourceForm';
export default async function EditPage({ params }: { params: Promise<{ resource: string; id: string }> }) { const { resource, id } = await params; const config = getResource(resource); if (!config || config.readonly) notFound(); return <ResourceForm config={config} id={id} />; }
