'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { getSession } from '@/lib/api';
import { resources, type SessionInfo } from '@/lib/resources';

type SessionContext = { session: SessionInfo | null; refresh: () => Promise<void> };
const SessionContext = createContext<SessionContext>({ session: null, refresh: async () => {} });
export const useSession = () => useContext(SessionContext);
const original = [
  ['/smart-multi-write', '✦', '스마트 멀티에디터'], ['/write', '+', '스마트 에디터 작성'], ['/multi-write', 'ϟ', '멀티 에디터 작성'],
  ['/dashboard/insights', '▥', '트렌드 & 인사이트'], ['/dashboard/benchmark', '▣', '벤치마킹 보관함'], ['/dashboard/threads', '▤', '내 게시물 보관함'],
  ['/dashboard/personas', '♧', '페르소나 관리'], ['/dashboard/threads-manage', '◉', '내 쓰레드 관리'], ['/dashboard/videos', '▷', '영상 아카이브'], ['/dashboard/revenue', '↗', '수익 인증 라운지'],
];
export default function Shell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const [session, setSession] = useState<SessionInfo | null>(null);
  const [open, setOpen] = useState(false);
  const refresh = async () => { try { setSession(await getSession()); } catch { setSession(null); } };
  useEffect(() => { void refresh(); }, []);
  useEffect(() => { setOpen(false); }, [pathname]);
  const selected = resources.find(resource => pathname.split('/').includes(resource.name));
  return <SessionContext.Provider value={{ session, refresh }}>
    <a href="#main" className="skip-link">본문 바로가기</a>
    {open && <button className="sidebar-shade" aria-label="메뉴 닫기" onClick={() => setOpen(false)} />}
    <aside className={`sidebar ${open ? 'is-open' : ''}`} aria-label="주 메뉴">
      <a className="brand" href="/dashboard/insights" aria-label="인사이트로 이동"><img src="/workspace/h-logo.png" alt="H 로고" width="70" height="70" /></a>
      <div className="sidebar-scroll">
        <div className="nav-section-label">자료 관리</div>
        <nav>{resources.map(resource => <Link key={resource.name} href={`/${resource.name}`} className={`nav-item ${selected?.name === resource.name ? 'active' : ''}`} aria-current={selected?.name === resource.name ? 'page' : undefined}><span className="nav-icon" aria-hidden="true">{resource.icon}</span>{resource.label}</Link>)}</nav>
        <div className="nav-section-label">원본 DRT 기능</div>
        <nav>{original.map(([href, icon, label]) => <a key={href} href={href} className="nav-item original-link"><span className="nav-icon" aria-hidden="true">{icon}</span>{label}<span className="nav-arrow" aria-hidden="true">↗</span></a>)}</nav>
      </div>
      <div className="sidebar-bottom"><a href="/onboarding/coupang">쿠팡</a><a href="/onboarding/toss">토스</a><a href="/mypage">마이페이지 ↗</a></div>
    </aside>
    <div className="main-shell">
      <header className="topbar"><div className="topbar-left"><button className="menu-toggle" onClick={() => setOpen(true)} aria-label="메뉴 열기"><span /><span /><span /></button><span className="section-mark" aria-hidden="true" /><span>{pathname.includes('/connect') ? '원본 계정 연결' : selected?.label || '자료 관리'}</span></div><Link href="/connect" className={`connection-pill ${session?.connected ? 'connected' : ''}`}><i />{session?.connected ? '원본 계정 연결됨' : '원본 계정 연결'}<span aria-hidden="true">↗</span></Link></header>
      <main id="main" tabIndex={-1}>{children}</main>
      <footer className="page-footer"><span>H · 나만의 콘텐츠 작업 공간</span><span>{session?.workspace.kind === 'guest' ? '체험 보관함' : session?.connected ? '개인 보관함' : '자료 관리'}</span></footer>
    </div>
  </SessionContext.Provider>;
}
