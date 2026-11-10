(() => {
  if (!window.__REA_REPLAY__?.liveTrends || location.pathname !== '/dashboard/insights') return;
  const start = () => {
    if(window.dreathsDesktop)return;
    const panel = document.createElement('div');
    panel.setAttribute('aria-label','원본 데이터 연결 상태');
    panel.style.cssText='position:fixed;right:16px;bottom:16px;z-index:2147483640;max-width:440px;background:#fff;border:1px solid #ddd;border-radius:12px;box-shadow:0 4px 20px #0002;padding:12px 16px;font:13px/1.5 system-ui;color:#222';
    const label = document.createElement('div');
    label.setAttribute('role','status');
    const settings = document.createElement('a');
    settings.href='/__live/'; settings.textContent='세션 연결 설정'; settings.style.cssText='color:#5140bd;margin-right:16px';
    const refresh = document.createElement('button');
    refresh.textContent='지금 새로 조회'; refresh.style.cssText='cursor:pointer;border:0;background:#eee;padding:4px 8px;border-radius:5px';
    let connected=false;
    refresh.addEventListener('click',()=>{if(connected)window.dispatchEvent(new Event('rea:refresh-trends'))});
    panel.append(label,settings,refresh); document.body.append(panel);
    const update = async () => {
      try {
        const response = await fetch('/__live/status',{cache:'no-store'});
        if (!response.ok) throw new Error('status_unavailable');
        const status = await response.json();
        connected=status.configured && status.state==='connected'; refresh.disabled=!connected;
        const states={'awaiting-session':'원본 데이터 연결을 위해 세션을 입력해 주세요.','connecting':'원본 서버 연결 확인 중',
          'session-expired':'세션이 만료되었습니다. 다시 연결해 주세요.','access-denied':'원본 서버에서 조회 권한을 거부했습니다.',
          'upstream-error':'원본 서버 조회 실패 · 연결 상태를 확인해 주세요.'};
        label.textContent=connected ? '원본 API 연결 · 60초마다 조회 · '+new Date(status.lastSuccessAt).toLocaleTimeString('ko-KR')
          : states[status.state] ?? '원본 데이터 연결 확인 필요';
      } catch { connected=false;refresh.disabled=true;label.textContent='로컬 연결 상태 확인 필요'; }
    };
    void update();
    setInterval(()=>{if(!document.hidden)void update()},5000);
  };
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',start,{once:true});else start();
})();
