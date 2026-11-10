# HongThreads — 미션 6

현재 DRT 화면과 원본 서비스 연결을 유지하면서 Next.js App Router, Supabase Database·Storage, 사용자별 연결을 추가한 웹 서비스입니다. 공개 주소는 **https://hongthreads.hongsik.blog**입니다. 사용자 지시에 따라 **추가 배포는 승인 후에만 진행**합니다. 현재 공개된 최초 버전과 로컬 수정본은 다르며, 실제 상태와 제한은 [구현 보고서](MISSION6-IMPLEMENTATION-REPORT.ko.html)를 따릅니다.

## 기능과 데이터

- 사용자 화면은 원본 DRT 그대로입니다. `/dashboard/insights`, `/dashboard/benchmark`, 기존 에디터·원고·페르소나·분석·제휴·마이페이지를 사용합니다. 별도 대시보드·자료 관리 메뉴·연결 배너는 제거했습니다.
- 이전 `/workspace` HTML 주소는 해당 원본 화면으로 돌아갑니다. `/workspace/api/`는 저장·세션 API 호환용으로 유지하며 제품 메뉴에 표시하지 않습니다.
- 기존 13개 DRT 화면: 편집기·트렌드·계정 분석·아카이브·제휴·마이페이지 흐름을 유지합니다. 원본 조회와 처리 결과는 개인 workspace에 동기화합니다.
- 원본 계정은 방문자마다 연결합니다. 연결 전에는 개인 브라우저의 guest 보관함을 사용합니다. 원본 계정 연결 시 검증된 사용자에게 속한 보관함으로 전환하며 체험 자료를 자동 혼합하지 않습니다.
- 원본 서비스의 권한과 실제 게시·예약·상품 조회는 원본 API를 따릅니다. DB 사본으로 외부 처리 성공을 대신하지 않습니다.
- 원본 ID가 있는 자료는 기존 화면에서 수정하며, 원본 응답 성공 후 사본을 갱신합니다. 서버 재시작 후에는 원본 계정을 재연결해야 합니다. 앱 쿠키에 연결된 보관함 자료는 유지됩니다.
- 세션은 기존 개발용 `/__live/`에서 연결하고 원본 화면에 새 메뉴를 붙이지 않습니다. 확장 키는 기존 벤치마킹의 ‘익스텐션 키’를 사용합니다. 새 `extension-cloud`는 기존 `extension-local`과 별도 설치됩니다.
- 사용자 요청으로 전체 페이지의 사용법 버튼(PC·모바일), API 연동 말풍선·연결 상태 패널, 멤버십·무료 오픈채팅 안내 카드를 숨깁니다. 공통 `replay/ui-visibility.css`를 두 로컬 실행판에 적용하며 계정·AI·제휴 설정과 실제 처리 API는 유지합니다. 13개 페이지 × 2개 실행판 × PC/모바일, 총52회 화면 검사에서 사용법 버튼56개가 모두 숨겨졌고 JavaScript 오류는0건입니다.

## 구성

Next.js 16.4.6와 React 19.3.1, Node.js 24, 서버 REST 접근의 Supabase 저장 계층을 사용합니다. Next.js는 `/workspace` basePath와 9250 포트, 연결 서버는 9251 포트입니다. 모든 DB 작업은 서버에서 workspace 소유권을 검사합니다. DB·Storage의 익명 직접 접근은 닫혀 있습니다.

AI는 기존 EC2 WIF worker와 `gemini-3.8-flash`를 사용합니다. Windows는 기존 SSH 경로를, AWS는 기존 worker를 로컬 subprocess로 호출합니다. 원본 세션은 연결 서버 메모리에만 있고 업무 DB에는 원본 세션·제휴 비밀키를 저장하지 않습니다.

## 로컬 실행

```powershell
npm ci --omit=dev --ignore-scripts
npm --prefix web ci
npm --prefix web run build
node mission6/start.mjs
```

기본 접속은 `http://127.0.0.1:9251/dashboard/insights`입니다. 기존 Windows 개발 서버 9248은 별도로 유지됩니다. 설정 파일은 `MISSION6_ENV_FILE`로 지정하거나 Windows의 `%LOCALAPPDATA%/HongThreads/secrets/mission6.env`에서 읽습니다.

필수 설정은 `SUPABASE_URL`, `SUPABASE_SECRET_KEY`, `SESSION_SIGNING_SECRET`입니다. AWS에서는 `PUBLIC_ORIGIN=https://hongthreads.hongsik.blog`, `VERTEX_TRANSPORT=local`, `VERTEX_NODE_PATH`, `VERTEX_WORKER_PATH`도 설정합니다. `deploy/runtime.env.example`을 참고하고 실제 비밀값은 GitHub나 클라이언트 코드에 넣지 않습니다.

## 데이터·migration

`supabase/migrations/`는 테이블, RLS, 서버 전용 함수·권한 및 비공개 `drt-assets` 버킷을 정의합니다. 관리 테이블은 workspace, 앱 세션 해시, 원고, 세션, 페르소나, 댓글 양식, 폴더·스크랩, 첨부, 분석 스냅샷, 제휴 데이터, 발행·수익·AI·동기화 이력입니다. 폴더와 자료는 외래키로 연결되며 변경 버전으로 충돌을 검사합니다.

임시 로컬 파일 드라이버는 독립 테스트용입니다. 프로덕션에서는 `DATA_BACKEND=supabase`를 사용합니다.

## 검증

```powershell
node --test mission6/server.test.mjs mission6/mirror.test.mjs mission6/runtime/vertex-worker.test.mjs
npm --prefix web run build
```

필수 수동 QA는 빈 입력/잘못된 URL, 등록→목록→상세→수정→새로고침 유지→삭제, 파일 업로드·미리보기·삭제, 존재하지 않는 상세, A/B 브라우저의 자료 격리, 원본 연결·전환·만료, PC/모바일 및 배포 URL에서의 실제 저장입니다. 실제 원본 게시·예약·댓글은 지정 테스트 계정과 승인된 내용으로 확인합니다.

## AWS 배포와 복구

GitHub Actions는 Linux 빌드·격리 테스트 후 standalone 릴리스 artifact를 생성합니다. 기존 EC2에 release 디렉터리로 설치하고 `current` 링크로 전환합니다. Nginx vhost와 두 systemd 서비스는 `deploy/`에 있습니다. 기존 WordPress·DB·WIF worker는 교체하지 않습니다. 실패하면 직전 release로 `current`를 되돌리고 서비스만 재시작합니다. Supabase 자료를 삭제해 롤백하지 않습니다.

GitHub 저장소에는 실제 원본 API 응답과 세션·키가 포함되지 않으며, 서버용 HTML shell의 이전 계정 SessionProvider 값은 guest 값으로 정리한 배포 사본만 포함합니다.

## 현재 검증 범위

원본 회귀와 새 검사 110개, Next 빌드·타입 검사, 실제 Supabase의 6개 자료 유형 CRUD·사용자 격리를 확인했습니다. 원본 UI 복구 후에는 기존 등록창에서 본문·파일을 저장하고 카드 표시·새로고침·작성 기준 수정·폴더 생성/수정/삭제·자료와 첨부 삭제까지 실제 클릭으로 확인했습니다. 원본13개 화면 모두200, JavaScript 오류0, 추가 UI0이며 같은 계정의 기존 개발판과 사이드바 메뉴·폭도 일치합니다.

추가 점검에서 같은 계정의 3종 병렬 생성을 1개로 제한하던 오류를 수정했습니다. 실제 WIF 동시 요청3개가 모두200·STOP으로 끝나고 완료 이력3건이 저장됐습니다. 원본 요청의 query ID·sessionId·templateId, 일괄 삭제, 발행/예약·제휴 링크 응답 분류와 서로 다른 링크의 보존을 검사했습니다. 이전 잘못된 키로 생성된 편집 세션 사본34건도 원본17개에 맞게17건으로 정리했으며 원본 서버에는 변경을 보내지 않았습니다. 사용법 영상 iframe은 원본이 사용하는 www.youtube.com만 허용해 HTTP200/CSP 오류0을 확인했고, 작은 합성 MP4의 실제 WIF 분석과 바이너리를 제외한 이력 저장도 통과했습니다. 근거는 mission6/verification/의 remaining-contract-regression.tap, parallel-wif-live.json, session-reconcile-live.json, tutorial-frame-live.json, video-wif-live.json입니다.

전체 기능 동일 검증은 아직 완료로 판정하지 않습니다. 실제 게시·예약·댓글·결제·외부 계정 변경, 확장의 실제 Chrome 설치 수집, 모든 제휴 조합과 원본 아카이브에서 시작하는 전체 영상 분석·대용량 재생은 실행하지 않았습니다. 작은 합성 영상의 서버 분석과 사용법 iframe 로드는 해당 범위의 검사입니다. 원본 외부 미디어 전체를 Supabase로 복사하지 않았고, 일반 동기화 대기 자동 재조정과 장기 미참조 파일 정리는 추가 운영 과제입니다. 현재 수정본의 Linux CI와 공개 도메인 재검증은 승인 후 진행합니다.
