import type { Metadata } from 'next';
import Shell from '@/components/Shell';
import './globals.css';
import './library.css';
export const metadata: Metadata = { title: { default: '자료 관리 · H', template: '%s · H' }, description: '콘텐츠와 아이디어, 원고와 첨부파일을 한곳에서 관리하는 개인 작업 공간', icons: { icon: '/workspace/h-logo.png' } };
export default function RootLayout({ children }: { children: React.ReactNode }) { return <html lang="ko"><body><Shell>{children}</Shell></body></html>; }
