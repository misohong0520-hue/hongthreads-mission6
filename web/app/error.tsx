'use client';
export default function ErrorPage({ reset }: { reset: () => void }) { return <section className="center-state panel"><span className="state-icon">!</span><h1>화면을 불러오지 못했습니다.</h1><p>잠시 후 다시 시도해 주세요.</p><button className="button primary" onClick={reset}>다시 불러오기</button></section>; }
