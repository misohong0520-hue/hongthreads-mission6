(() => {
  'use strict';

  const elements = Object.fromEntries([
    'session-form', 'cookie-name', 'cookie-value', 'connect-button', 'disconnect-button',
    'connection-status', 'status-title', 'status-description', 'last-success',
    'refresh-interval', 'form-message', 'open-insights'
  ].map(id => [id, document.getElementById(id)]));
  const states = {
    disabled: ['실시간 연결 꺼짐', '서버를 실시간 연결 모드로 시작해야 세션을 연결할 수 있습니다.'],
    'awaiting-session': ['세션 입력 대기', '원본 사이트에서 로그인한 세션 쿠키를 입력해 주세요.'],
    connecting: ['원본 서버 연결 중', '세션으로 원본 데이터를 조회하고 있습니다.'],
    connected: ['원본 서버 연결됨', '연결한 세션으로 원본 API의 데이터를 조회할 수 있습니다.'],
    'session-expired': ['세션 확인 필요', '세션이 만료됐거나 로그인 정보가 올바르지 않습니다. 원본 사이트에서 로그인한 뒤 새 값을 입력해 주세요.'],
    'access-denied': ['조회 권한 확인 필요', '원본 서버가 이 세션의 조회 요청을 거부했습니다. 원본 사이트에서 계정의 접근 권한을 확인해 주세요.'],
    'upstream-error': ['원본 데이터 수신 실패', '원본 서버의 응답을 받지 못했습니다. 잠시 후 상태를 다시 확인해 주세요.']
  };
  let current = null;
  let busy = false;
  let polling = false;

  const controls = () => {
    const enabled = Boolean(current?.enabled && current?.setupToken);
    elements['cookie-name'].disabled = busy || !enabled;
    elements['cookie-value'].disabled = busy || !enabled;
    elements['connect-button'].disabled = busy || !enabled;
    elements['disconnect-button'].disabled = busy || !enabled || !current?.configured;
    elements['connect-button'].textContent = busy ? '연결 처리 중…' : '세션 연결';
    elements['open-insights'].setAttribute('aria-disabled', String(!current?.enabled || current?.state !== 'connected'));
  };
  const dateText = value => {
    if (!value) return '아직 없음';
    const date = new Date(value);
    return Number.isFinite(date.getTime())
      ? new Intl.DateTimeFormat('ko-KR', { dateStyle: 'medium', timeStyle: 'medium', timeZone: 'Asia/Seoul' }).format(date)
      : '아직 없음';
  };
  const render = status => {
    current = status;
    const state = !status.enabled ? 'disabled' : Object.hasOwn(states, status.state) ? status.state : 'upstream-error';
    const [title, description] = states[state];
    elements['connection-status'].dataset.state = state;
    elements['status-title'].textContent = title;
    elements['status-description'].textContent = description;
    elements['last-success'].textContent = dateText(status.lastSuccessAt);
    const seconds = Number(status.refreshSeconds);
    elements['refresh-interval'].textContent = Number.isFinite(seconds) && seconds > 0 ? `${seconds}초` : '자동 갱신 없음';
    controls();
  };
  const loadStatus = async () => {
    if (polling) return;
    polling = true;
    try {
      const response = await fetch('/__live/status', { credentials: 'same-origin', cache: 'no-store', redirect: 'error' });
      if (!response.ok) throw new Error('status-unavailable');
      render(await response.json());
    } catch {
      current = null;
      elements['connection-status'].dataset.state = 'upstream-error';
      elements['status-title'].textContent = '로컬 서버 연결 확인 필요';
      elements['status-description'].textContent = '로컬 서버에 연결할 수 없습니다. 서버 실행 상태를 확인한 뒤 이 화면을 새로고침해 주세요.';
      controls();
    } finally {
      polling = false;
    }
  };
  const changeSession = async (method, value) => {
    if (!current?.enabled || !current?.setupToken || busy) return;
    busy = true;
    elements['form-message'].textContent = '';
    controls();
    try {
      const response = await fetch('/__live/session', {
        method,
        credentials: 'same-origin',
        cache: 'no-store',
        redirect: 'error',
        headers: { 'Content-Type': 'application/json', 'X-Rea-Setup-Token': current.setupToken },
        body: method === 'POST' ? JSON.stringify(value) : undefined
      });
      if (!response.ok) {
        elements['form-message'].textContent = response.status === 403
          ? '설정 화면을 새로고침한 뒤 다시 입력해 주세요.'
          : response.status === 400 || response.status === 413
            ? '쿠키 이름과 값의 형식을 확인한 뒤 다시 입력해 주세요.'
            : '세션 연결을 처리하지 못했습니다. 연결 상태를 확인해 주세요.';
      } else {
        elements['form-message'].textContent = method === 'DELETE'
          ? '연결을 해제하고 서버에 보관한 세션 값을 지웠습니다.'
          : '세션을 전달했습니다. 위 연결 상태를 확인해 주세요.';
      }
    } catch {
      elements['form-message'].textContent = '로컬 서버에 연결할 수 없습니다. 서버 실행 상태를 확인해 주세요.';
    } finally {
      busy = false;
      controls();
      await loadStatus();
    }
  };

  elements['session-form'].addEventListener('submit', event => {
    event.preventDefault();
    const cookieValue = elements['cookie-value'].value.trim();
    elements['cookie-value'].value = '';
    if (!cookieValue) {
      elements['form-message'].textContent = '세션 쿠키 값을 입력해 주세요.';
      return;
    }
    void changeSession('POST', { cookieName: elements['cookie-name'].value, cookieValue });
  });
  elements['disconnect-button'].addEventListener('click', () => {
    elements['cookie-value'].value = '';
    void changeSession('DELETE');
  });
  elements['open-insights'].addEventListener('click', event => {
    if (!current?.enabled || current?.state !== 'connected') event.preventDefault();
  });
  document.addEventListener('visibilitychange', () => { if (!document.hidden) void loadStatus(); });
  void loadStatus();
  setInterval(() => { if (!document.hidden) void loadStatus(); }, 5000);
})();
