'use client';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { ApiError, errorMessage, mutate, request, upload } from '@/lib/api';
import { type Asset, type ListData, type RecordData, type ResourceConfig } from '@/lib/resources';

const maxBytes = 50 * 1024 * 1024;
const accepted = ['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'video/mp4', 'video/webm', 'video/quicktime'];
export default function ResourceForm({ config, id }: { config: ResourceConfig; id?: string }) {
  const router = useRouter(), fileInput = useRef<HTMLInputElement>(null);
  const [title, setTitle] = useState(''), [content, setContent] = useState(''), [source, setSource] = useState(''), [folder, setFolder] = useState('');
  const [assets, setAssets] = useState<Asset[]>([]), [folders, setFolders] = useState<RecordData[]>([]), [version, setVersion] = useState<number | undefined>();
  const [loading, setLoading] = useState(Boolean(id)), [loadError, setLoadError] = useState(''), [saving, setSaving] = useState(false), [uploading, setUploading] = useState(false), [error, setError] = useState(''), [fields, setFields] = useState<Record<string, string>>({});
  useEffect(() => {
    if (config.name === 'benchmarks') void request<ListData>('v1/folders?limit=100').then(r => setFolders(r.data)).catch(() => setFolders([]));
    if (id) void request<{ data: RecordData }>(`v1/${config.name}/${id}`).then(({ data }) => { setTitle(data.title || ''); setContent(data.content || ''); setSource(data.source_url || ''); setFolder(data.folder_id || ''); setAssets(data.assets || []); setVersion(data.version); }).catch(cause => setLoadError(errorMessage(cause))).finally(() => setLoading(false));
  }, [config.name, id]);
  const attach = async (files: FileList | null) => {
    if (!files?.length) return;
    setError('');
    const selected = Array.from(files);
    if (assets.length + selected.length > 9) { setError('첨부파일은 최대 9개까지 등록할 수 있습니다.'); return; }
    if (selected.some(file => file.size > maxBytes)) { setError('파일 한 개의 크기는 50MB 이하여야 합니다.'); return; }
    if (selected.some(file => !accepted.includes(file.type))) { setError('JPG, PNG, WEBP, GIF 이미지 또는 MP4, WEBM, MOV 영상을 선택해 주세요.'); return; }
    setUploading(true);
    for (const file of selected) {
      try { const result = await upload(file); setAssets(current => [...current, result.data]); }
      catch (cause) { setError(`${file.name}: ${errorMessage(cause)}`); break; }
    }
    setUploading(false); if (fileInput.current) fileInput.current.value = '';
  };
  const submit = async (event: FormEvent) => {
    event.preventDefault(); setError('');
    const errors: Record<string, string> = {};
    if (!title.trim()) errors.title = '제목을 입력해 주세요.';
    else if (title.trim().length > 200) errors.title = '제목은 200자 이내로 입력해 주세요.';
    if (content.length > 50000) errors.content = '내용은 50,000자 이내로 입력해 주세요.';
    if (source.trim()) { try { const url = new URL(source); if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error(); } catch { errors.source_url = 'http 또는 https로 시작하는 올바른 주소를 입력해 주세요.'; } }
    setFields(errors); if (Object.keys(errors).length) return;
    setSaving(true);
    try {
      const body = { title: title.trim(), content, source_url: source.trim(), folder_id: folder || null, assets: assets.map(asset => ({ id: asset.id })), ...(version === undefined ? {} : { version }) };
      const { data } = await mutate<{ data: RecordData }>(`v1/${config.name}${id ? `/${id}` : ''}`, id ? 'PATCH' : 'POST', body);
      router.push(`/${config.name}/${data.id}?saved=1`); router.refresh();
    } catch (cause) { setError(errorMessage(cause)); if (cause instanceof ApiError) setFields(cause.fields); }
    finally { setSaving(false); }
  };
  if (loading) return <div className="page-loading" role="status"><span className="spinner" />자료를 불러오는 중입니다.</div>;
  if (loadError) return <section className="panel center-state" role="alert"><span className="state-icon error">!</span><h1>자료를 열 수 없습니다.</h1><p>{loadError}</p><Link className="button secondary" href={`/${config.name}`}>목록으로 돌아가기</Link></section>;
  return <>
    <Link className="back-link" href={`/${config.name}`}>← {config.label}</Link>
    <div className="page-heading"><div><div className="eyebrow">{id ? 'EDIT CONTENT' : 'NEW CONTENT'}</div><h1>{config.single} {id ? '수정' : '등록'}</h1><p>{id ? '변경할 내용을 확인한 뒤 저장해 주세요.' : '내용과 첨부파일을 함께 기록해 두세요.'}</p></div></div>
    <form className="panel editor-panel" onSubmit={submit} noValidate>
      {error && <div className="error-notice" role="alert"><span>!</span><div>{error}</div></div>}
      <div className="form-field"><label htmlFor="title">제목 <span className="required">*</span></label><input id="title" value={title} maxLength={201} onChange={e => setTitle(e.target.value)} placeholder={`${config.single}의 제목을 입력해 주세요`} aria-invalid={Boolean(fields.title)} aria-describedby={fields.title ? 'title-error' : undefined} disabled={saving} /><div className="field-bottom">{fields.title ? <span id="title-error" className="field-error">{fields.title}</span> : <span>나중에 다시 찾기 쉬운 제목을 붙여 주세요.</span>}<span>{title.length}/200</span></div></div>
      {config.name === 'benchmarks' && <div className="form-field"><label htmlFor="folder">폴더</label><select id="folder" value={folder} onChange={e => setFolder(e.target.value)} disabled={saving}><option value="">미분류</option>{folders.map(item => <option key={item.id} value={item.id}>{item.title}</option>)}</select>{fields.folder_id && <span className="field-error">{fields.folder_id}</span>}</div>}
      <div className="form-field"><label htmlFor="content">{config.name === 'personas' ? '페르소나 설정' : '내용'}</label><textarea id="content" value={content} onChange={e => setContent(e.target.value)} rows={12} placeholder={config.placeholder} aria-invalid={Boolean(fields.content)} disabled={saving} /><div className="field-bottom">{fields.content ? <span className="field-error">{fields.content}</span> : <span>입력한 내용은 저장 후에도 수정할 수 있습니다.</span>}<span>{content.length.toLocaleString()}/50,000</span></div></div>
      {config.name !== 'folders' && <><div className="form-field"><label htmlFor="source">참고 링크 <span className="optional">선택</span></label><input id="source" type="url" value={source} onChange={e => setSource(e.target.value)} placeholder="https://" aria-invalid={Boolean(fields.source_url)} disabled={saving} />{fields.source_url && <span className="field-error">{fields.source_url}</span>}</div>
      <div className="form-field"><div className="field-title"><label>첨부파일 <span className="optional">{assets.length}/9</span></label><span className="muted small">이미지·영상 · 파일당 최대 50MB</span></div><input className="visually-hidden" type="file" id="attachment" ref={fileInput} multiple accept={accepted.join(',')} onChange={e => void attach(e.target.files)} disabled={uploading || saving} /><button type="button" className="upload-zone" onClick={() => fileInput.current?.click()} disabled={uploading || saving || assets.length >= 9}><span className="upload-icon" aria-hidden="true">{uploading ? <span className="spinner" /> : '↥'}</span><strong>{uploading ? '파일을 업로드하고 있습니다…' : '클릭해서 파일을 선택하세요'}</strong><span>이미지나 영상을 내용과 함께 보관할 수 있어요.</span></button>
      {assets.length > 0 && <ul className="attachment-list">{assets.map(asset => <li key={asset.id}><div className="file-thumbnail">{asset.url && asset.mime_type?.startsWith('image/') ? <img src={asset.url} alt={asset.name} /> : <span aria-hidden="true">{asset.mime_type?.startsWith('video/') ? '▷' : '▤'}</span>}</div><div className="file-info"><strong>{asset.name}</strong><span>{asset.size ? `${(asset.size / 1024 / 1024).toFixed(1)} MB` : '첨부 완료'}</span></div><button className="icon-button" type="button" aria-label={`${asset.name} 첨부 제거`} onClick={() => setAssets(current => current.filter(item => item.id !== asset.id))} disabled={saving}>×</button></li>)}</ul>}{fields.assets && <span className="field-error">{fields.assets}</span>}</div></>}
      <div className="form-actions"><Link className="button secondary" href={id ? `/${config.name}/${id}` : `/${config.name}`}>취소</Link><button className="button primary" type="submit" disabled={saving || uploading}>{saving && <span className="spinner" />}{saving ? '저장하는 중…' : id ? '변경 내용 저장' : '등록하기'}</button></div>
    </form>
  </>;
}
