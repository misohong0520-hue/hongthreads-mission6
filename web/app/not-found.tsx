import Link from 'next/link';
export default function NotFound() { return <section className="center-state panel"><span className="state-icon">?</span><h1>요청한 페이지를 찾을 수 없습니다.</h1><p>주소가 바뀌었거나 삭제된 자료일 수 있습니다.</p><Link className="button primary" href="/benchmarks">보관함으로 돌아가기</Link></section>; }
