'use client';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { errorMessage, formatDate, request } from '@/lib/api';
import { type ListData, type RecordData, type ResourceConfig } from '@/lib/resources';
import { useSession } from './Shell';

export default function ResourceList({ config }: { config: ResourceConfig }) {
  const router = useRouter(), params = useSearchParams(), { session } = useSession();
  const search = params.get('search') || '', folder = params.get('folder_id') || '', sort = params.get('sort') || 'updated_at', page = Math.max(1, Number(params.get('page')) || 1);
  const [input, setInput] = useState(search), [folderInput, setFolderInput] = useState(folder), [sortInput, setSortInput] = useState(sort);
  const [data, setData] = useState<ListData | null>(null), [folders, setFolders] = useState<RecordData[]>([]), [loading, setLoading] = useState(true), [error, setError] = useState('');
  const load = useCallback(async () => {
    setLoading(true); setError('');
    const query = new URLSearchParams({ page: String(page), limit: '15', sort });
    if (search) query.set('search', search); if (folder) query.set('folder_id', folder);
    try { setData(await request<ListData>(`v1/${config.name}?${query}`)); }
    catch (cause) { setError(errorMessage(cause)); }
    finally { setLoading(false); }
  }, [config.name, page, search, folder, sort]);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => { setInput(search); setFolderInput(folder); setSortInput(sort); }, [search, folder, sort]);
  useEffect(() => { if (config.name === 'benchmarks') void request<ListData>('v1/folders?limit=100').then(r => setFolders(r.data)).catch(() => setFolders([])); }, [config.name]);
  const change = (next: { page?: number; search?: string; folder?: string; sort?: string }) => {
    const query = new URLSearchParams(); const nextSearch = next.search ?? search, nextFolder = next.folder ?? folder, nextSort = next.sort ?? sort;
    if (nextSearch) query.set('search', nextSearch); if (nextFolder) query.set('folder_id', nextFolder); if (nextSort !== 'updated_at') query.set('sort', nextSort); if ((next.page || 1) > 1) query.set('page', String(next.page));
    router.push(`/${config.name}${query.size ? `?${query}` : ''}`);
  };
  const submit = (event: FormEvent) => { event.preventDefault(); change({ page: 1, search: input.trim(), folder: folderInput, sort: sortInput }); };
  const total = data?.total || 0, pages = Math.max(1, Math.ceil(total / (data?.limit || 15))), rows = data?.data || [];
  return <>
    <div className="page-heading"><div><div className="eyebrow">MY WORKSPACE</div><h1>{config.label}</h1><p>{config.description}</p></div>{!config.readonly && <Link className="button primary" href={`/${config.name}/new`}><span aria-hidden="true">＋</span>{config.single} 등록</Link>}</div>
    {session?.workspace.kind === 'guest' && <div className="workspace-note"><span className="note-dot" /><span>지금은 <strong>체험 보관함</strong>을 사용하고 있어요. 실제 계정의 작업은 원본 계정을 연결해 이용하세요.</span><Link href="/connect">계정 연결 ↗</Link></div>}
    <section className="panel library-panel" aria-label={`${config.label} 목록`}>
      <div className="library-top"><div><h2>내 자료 <span className="count-badge">{loading && !data ? '—' : total.toLocaleString()}</span></h2><p className="muted">새로운 아이디어를 놓치지 않도록, 차곡차곡 기록해 두세요.</p></div><button className="button subtle" onClick={() => void load()} disabled={loading}><span aria-hidden="true" className={loading ? 'refresh-spin' : ''}>↻</span>새로고침</button></div>
      <form className="filter-bar" onSubmit={submit} role="search"><div className="search-field"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden="true"><circle cx="10.8" cy="10.8" r="6.5" /><path d="m16 16 4.5 4.5" /></svg><input aria-label="자료 검색" value={input} onChange={e => setInput(e.target.value)} placeholder="제목 또는 내용으로 검색하세요" /></div>{config.name === 'benchmarks' && <select aria-label="폴더 필터" value={folderInput} onChange={e => setFolderInput(e.target.value)}><option value="">모든 폴더</option>{folders.map(item => <option key={item.id} value={item.id}>{item.title}</option>)}</select>}<select aria-label="정렬" value={sortInput} onChange={e => setSortInput(e.target.value)}><option value="updated_at">최근 수정순</option><option value="created_at">최근 등록순</option><option value="title">제목순</option></select><button className="button dark" type="submit">검색</button></form>
      {(search || folder) && <div className="filter-summary"><span>{search && <>‘{search}’ 검색 결과</>}{folder && <> · {folders.find(f => f.id === folder)?.title || '선택한 폴더'}</>}</span><button onClick={() => change({ search: '', folder: '', page: 1 })}>필터 초기화 ×</button></div>}
      {error ? <div className="center-state" role="alert"><span className="state-icon error">!</span><h3>자료를 불러오지 못했습니다.</h3><p>{error}</p><button className="button secondary" onClick={() => void load()}>다시 시도</button></div> : loading ? <div className="resource-grid" aria-busy="true" aria-label="자료를 불러오는 중">{[1, 2, 3, 4, 5, 6].map(i => <div className="resource-card skeleton" key={i}><div /><div /><div /></div>)}</div> : !rows.length ? <div className="center-state empty-state"><div className="empty-illustration" aria-hidden="true"><svg viewBox="0 0 84 72" fill="none"><path d="M12 19a7 7 0 0 1 7-7h16l8 8h24a6 6 0 0 1 6 6v28a7 7 0 0 1-7 7H19a7 7 0 0 1-7-7V19Z" fill="#e4f7ec" stroke="#a3dabc" strokeWidth="2" /><path d="M12 29h61" stroke="#a3dabc" strokeWidth="2" /><path d="M42 37v15m-7.5-7.5h15" stroke="#1a9f5c" strokeWidth="2.5" strokeLinecap="round" /></svg></div><h3>{search || folder ? '조건에 맞는 자료가 없어요.' : `아직 저장한 ${config.single}${config.name === 'personas' ? '가' : '가'} 없어요.`}</h3><p>{search || folder ? '다른 검색어나 폴더로 다시 찾아보세요.' : config.readonly ? '작업을 시작하면 기록이 여기에 표시됩니다.' : '첫 번째 자료를 등록하고 나만의 보관함을 채워 보세요.'}</p>{!config.readonly && !(search || folder) && <Link className="button primary" href={`/${config.name}/new`}>＋ 첫 자료 등록하기</Link>}</div> : <div className="resource-grid">{rows.map(item => <Link href={`/${config.name}/${item.id}`} key={item.id} className="resource-card"><div className="card-topline"><span className="resource-type">{config.icon} {config.single}</span><span className="card-arrow" aria-hidden="true">↗</span></div>{item.assets?.find(a => a.url && a.mime_type?.startsWith('image/'))?.url && <img className="card-cover" src={item.assets.find(a => a.url && a.mime_type?.startsWith('image/'))!.url} alt="첨부 이미지" />}<h3>{item.title || '제목 없는 자료'}</h3><p className="card-excerpt">{item.content || '내용을 열어 확인해 보세요.'}</p><div className="card-footer"><time dateTime={item.updated_at}>{formatDate(item.updated_at)}</time><div>{Boolean(item.assets?.length) && <span className="attachment-count">↳ 파일 {item.assets.length}</span>}{item.status && <span className="status-chip">{item.status}</span>}</div></div></Link>)}</div>}
      {!error && !loading && total > 0 && <nav className="pagination" aria-label="페이지 이동"><span className="pagination-count">전체 {total.toLocaleString()}개 · {page} / {pages}페이지</span><div><button className="page-button" disabled={page <= 1} onClick={() => change({ page: page - 1 })} aria-label="이전 페이지">‹</button>{Array.from({ length: Math.min(5, pages) }, (_, i) => Math.max(1, Math.min(page - 2, pages - 4)) + i).map(number => <button className={`page-button ${number === page ? 'current' : ''}`} key={number} aria-label={`${number}페이지`} aria-current={number === page ? 'page' : undefined} onClick={() => change({ page: number })}>{number}</button>)}<button className="page-button" disabled={page >= pages} onClick={() => change({ page: page + 1 })} aria-label="다음 페이지">›</button></div></nav>}
    </section>
  </>;
}
