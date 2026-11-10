'use client';
import { useState, type FormEvent } from 'react';
import Link from 'next/link';
import { errorMessage, mutate } from '@/lib/api';
import { useSession } from '@/components/Shell';

export default function Connect() {
  const { session, refresh } = useSession();
  const [name, setName] = useState('next-auth.session-token'), [token, setToken] = useState(''), [pending, setPending] = useState(false), [error, setError] = useState(''), [success, setSuccess] = useState('');
  const connect = async (event: FormEvent) => { event.preventDefault(); setError(''); setSuccess(''); if (!token.trim()) { setError('원본 계정의 세션 값을 입력해 주세요.'); return; } setPending(true); try { await mutate('connection', 'POST', { cookieName: name, cookieValue: token.trim() }); setSuccess('원본 계정이 연결되었습니다. 이제 해당 계정의 기능을 사용할 수 있습니다.'); await refresh(); } catch (cause) { setError(errorMessage(cause)); } finally { setToken(''); setPending(false); } };
  const disconnect = async () => { setError(''); setSuccess(''); setPending(true); try { await mutate('connection', 'DELETE'); await refresh(); setSuccess('이 브라우저의 원본 계정 연결이 해제되었습니다.'); } catch (cause) { setError(errorMessage(cause)); } finally { setPending(false); } };
  return <>
    <div className="page-heading"><div><div className="eyebrow">CONNECT YOUR ACCOUNT</div><h1>원본 계정 연결</h1><p>사용 중인 DRT 계정을 연결하고 기존 작업을 이어가세요.</p></div></div>
    <div className="connect-layout"><section className="panel connect-panel"><div className="connect-state"><span className={`connection-orb ${session?.connected ? 'on' : ''}`}>↗</span><div><h2>{session?.connected ? '원본 계정이 연결되어 있어요' : '원본 계정을 연결해 주세요'}</h2><p>{session?.connected ? '연결된 계정의 원본 기능을 사용할 수 있습니다.' : '보관함은 연결 없이 체험할 수 있고, 원본 기능은 계정 연결 후 이용할 수 있어요.'}</p></div></div>
      {success && <div className="success-notice" role="status">✓ {success}</div>}{error && <div className="error-notice" role="alert">{error}</div>}
      <form onSubmit={connect} autoComplete="off"><div className="form-field"><label htmlFor="cookie-name">세션 쿠키 이름</label><select id="cookie-name" value={name} onChange={e => setName(e.target.value)} disabled={pending}><option value="next-auth.session-token">next-auth.session-token</option><option value="__Secure-next-auth.session-token">__Secure-next-auth.session-token</option><option value="authjs.session-token">authjs.session-token</option><option value="__Secure-authjs.session-token">__Secure-authjs.session-token</option></select></div><div className="form-field"><label htmlFor="cookie-value">세션 값</label><textarea id="cookie-value" rows={5} value={token} onChange={e => setToken(e.target.value)} placeholder="원본 계정의 세션 값을 붙여 넣어 주세요" autoComplete="off" autoCapitalize="none" spellCheck={false} disabled={pending} /></div><p className="connection-help">세션은 연결 확인에 사용하며, 제출 후 입력란에서 지웁니다. 다른 사람과 공유하지 마세요.</p><div className="form-actions">{session?.connected && <button className="button danger-subtle" type="button" onClick={() => void disconnect()} disabled={pending}>연결 해제</button>}<button className="button primary" type="submit" disabled={pending}>{pending ? '연결을 확인하는 중…' : session?.connected ? '다른 계정으로 연결' : '계정 연결하기'}</button></div></form>
    </section><aside className="panel connect-guide"><span className="guide-mark">i</span><h2>어디서 확인하나요?</h2><ol><li><a href="https://drt.agczero.com/dashboard/insights" target="_blank" rel="noopener noreferrer">원본 DRT</a>에 본인 계정으로 로그인합니다.</li><li>브라우저 개발자 도구의 Application → Cookies에서 원본 사이트를 선택합니다.</li><li>세션 쿠키의 이름과 값을 확인해 왼쪽에 입력합니다.</li></ol><p>만료된 세션은 원본 사이트에서 다시 로그인한 뒤 연결해 주세요.</p><Link href="/benchmarks">먼저 보관함 둘러보기 →</Link></aside></div>
  </>;
}
