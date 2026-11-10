'use client';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import { errorMessage, formatDate, mutate, request } from '@/lib/api';
import type { RecordData, ResourceConfig } from '@/lib/resources';

export default function ResourceDetail({ config, id }: { config: ResourceConfig; id: string }) {
  const router = useRouter(), params = useSearchParams();
  const [item, setItem] = useState<RecordData | null>(null), [loading, setLoading] = useState(true), [error, setError] = useState(''), [confirm, setConfirm] = useState(false), [deleting, setDeleting] = useState(false);
  useEffect(() => { void request<{ data: RecordData }>(`v1/${config.name}/${id}`).then(r => setItem(r.data)).catch(cause => setError(errorMessage(cause))).finally(() => setLoading(false)); }, [config.name, id]);
  const remove = async () => { setDeleting(true); setError(''); try { await mutate(`v1/${config.name}/${id}`, 'DELETE'); router.push(`/${config.name}?deleted=1`); router.refresh(); } catch (cause) { setError(errorMessage(cause)); setConfirm(false); } finally { setDeleting(false); } };
  if (loading) return <div className="page-loading" role="status"><span className="spinner" />자료를 불러오는 중입니다.</div>;
  if (!item) return <section className="panel center-state" role="alert"><span className="state-icon error">!</span><h1>자료를 찾을 수 없습니다.</h1><p>{error || '삭제됐거나 접근할 수 없는 자료입니다.'}</p><Link className="button secondary" href={`/${config.name}`}>목록으로 돌아가기</Link></section>;
  return <>
    <Link className="back-link" href={`/${config.name}`}>← {config.label}</Link>
    {params.get('saved') && <div className="success-notice" role="status"><span>✓</span>자료가 저장되었습니다.</div>}
    <article className="panel detail-panel">
      <div className="detail-heading"><div><span className="resource-type">{config.icon} {config.single}</span><h1>{item.title || '제목 없는 자료'}</h1><div className="detail-meta"><span>등록 {formatDate(item.created_at)}</span><span>수정 {formatDate(item.updated_at)}</span>{item.status && <span className="status-chip">{item.status}</span>}</div></div>{!config.readonly && <div className="detail-actions"><Link className="button secondary" href={`/${config.name}/${id}/edit`}>수정</Link><button className="button danger-subtle" onClick={() => setConfirm(true)}>삭제</button></div>}</div>
      {error && <div className="error-notice" role="alert">{error}</div>}
      <div className="detail-content">{item.content || <span className="muted">등록된 내용이 없습니다.</span>}</div>
      {item.source_url && <section className="detail-section"><h2>참고 링크</h2><a className="source-link" href={item.source_url} target="_blank" rel="noopener noreferrer"><span aria-hidden="true">↗</span>{item.source_url}</a></section>}
      {Boolean(item.assets?.length) && <section className="detail-section"><h2>첨부파일 <span className="count-badge">{item.assets.length}</span></h2><div className="media-grid">{item.assets.map(asset => <figure key={asset.id}>{asset.url && asset.mime_type?.startsWith('image/') ? <a href={asset.url} target="_blank" rel="noopener noreferrer"><img src={asset.url} alt={asset.name} /></a> : asset.url && asset.mime_type?.startsWith('video/') ? <video src={asset.url} controls preload="metadata" /> : <div className="file-preview">▤</div>}<figcaption><span>{asset.name}</span>{asset.url && <a href={asset.url} target="_blank" rel="noopener noreferrer" aria-label={`${asset.name} 열기`}>열기 ↗</a>}</figcaption></figure>)}</div></section>}
      <div className="detail-bottom"><Link className="button secondary" href={`/${config.name}`}>목록으로</Link></div>
    </article>
    {confirm && <div className="modal-backdrop" onClick={() => !deleting && setConfirm(false)}><section className="dialog" role="dialog" aria-modal="true" aria-labelledby="delete-title" aria-describedby="delete-description" onClick={e => e.stopPropagation()}><div className="delete-symbol" aria-hidden="true">×</div><h2 id="delete-title">이 자료를 삭제할까요?</h2><p id="delete-description">‘{item.title}’ 자료를 삭제합니다.<br />삭제한 자료는 복구할 수 없습니다.</p><div className="dialog-actions"><button className="button secondary" onClick={() => setConfirm(false)} disabled={deleting}>취소</button><button className="button danger" onClick={() => void remove()} disabled={deleting}>{deleting ? '삭제하는 중…' : '삭제하기'}</button></div></section></div>}
  </>;
}
