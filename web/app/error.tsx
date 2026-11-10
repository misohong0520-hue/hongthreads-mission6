'use client';
import { useEffect } from 'react';
export default function ErrorPage() {
  useEffect(() => { const target = new URL('/dashboard/insights', location.origin); if (['localhost', '127.0.0.1'].includes(target.hostname) && target.port === '9250') target.port = '9251'; location.replace(target.href); }, []);
  return null;
}
