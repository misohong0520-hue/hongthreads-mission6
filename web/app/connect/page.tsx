import { redirectOriginal } from '@/lib/original-routes';
export const dynamic = 'force-dynamic';
export default function Connect() { redirectOriginal('/__live/'); }
