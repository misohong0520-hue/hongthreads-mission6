# HongThreads — 미션 6

HongThreads는 Threads 콘텐츠 작성, 트렌드 확인, 벤치마킹 자료 관리와 AI 활용을 한곳에서 제공하는 웹 프로젝트입니다. Next.js 기반 서버 구성, Supabase 데이터·파일 저장, Vertex AI WIF 연동과 AWS 배포 환경을 구현했습니다.

- 서비스: **https://hongthreads.hongsik.blog**
- GitHub: **https://github.com/misohong0520-hue/hongthreads-mission6**
- 문서: [구현 보고서](MISSION6-IMPLEMENTATION-REPORT.ko.html) · [구현 계획서](MISSION6-FINAL-PLAN.ko.html) · [QA 체크리스트](QA-CHECKLIST.ko.html)

## 핵심 기능 명세

| 기능 | 주요 동작 | 데이터 처리 |
| --- | --- | --- |
| 벤치마킹 보관함 | 자료 등록, 목록·상세 확인, 본문 수정, 삭제, 폴더 분류 | Supabase Database의 `scraps`, `scrap_folders` |
| 콘텐츠 관리 | 원고, 편집 세션, 페르소나, 댓글 양식 관리 | `drafts`, `editor_sessions`, `personas`, `comment_templates` |
| 첨부파일 | 이미지·영상 업로드, 미리보기, 첨부 해제·삭제 | 비공개 Storage와 `assets`, 자료별 첨부 참조 |
| 트렌드·인사이트 | 트렌드·검색 자료와 계정 분석 확인 | 조회 결과와 확인 시각 저장 |
| AI | 콘텐츠 생성·재작성과 분석 | Vertex AI WIF, 생성 작업·결과 이력 |
| 제휴 설정 | 쿠팡·토스·브랜드커넥트 관련 설정과 자료 관리 | 상품·링크 메타데이터 관리 |
| 계정·세션 | 연결 상태 확인, 브라우저별 요청 검증 | 앱 세션 해시, 서버 연결 관리 |

## 서비스 구성

브라우저 → Nginx HTTPS → Node.js 연결 서버·Next.js → Supabase Database·Storage / Vertex AI.

서버는 입력값, 자료 소유 단위(workspace), 첨부 참조, 수정 버전을 검사합니다. DB와 Storage의 익명 직접 접근을 차단하고 서버를 통해 처리합니다. 브라우저에는 HttpOnly·Secure·SameSite 앱 쿠키를 사용하며 변경 요청에는 Origin·CSRF 검사를 적용합니다.

공개 검토 환경은 별도 로그인·비밀번호·쿠키 입력 없이 연결된 화면으로 진입합니다. 이 환경의 방문자는 같은 검토용 자료를 봅니다. 브라우저별 CSRF 토큰은 분리합니다. 연결 정보는 서버의 암호화 파일로 관리하며 GitHub에 포함하지 않습니다. 연결 계정의 세션 유효기간이 끝나면 갱신이 필요합니다.

## 테이블 구조

SQL 정의: [초기 migration](supabase/migrations/20261110083159_mission6_initial.sql). 총 19개 테이블을 사용합니다.

| 테이블 | 역할 | 주요 필드·관계 |
| --- | --- | --- |
| `workspaces` | 자료 소유 단위 | `id` PK, `kind`, `upstream_user_id` UNIQUE |
| `app_sessions` | 앱 접속 세션 | `token_hash` UNIQUE, `workspace_id` FK, `expires_at` |
| `scrap_folders` | 벤치마킹 폴더 | 공통 필드, 폴더 이름·순서 |
| `scraps` | 벤치마킹 자료 | 공통 필드, `folder_id`, 본문·링크·첨부 |
| `drafts` | 작성 원고 | 공통 필드, 본문·상태 |
| `editor_sessions` | 편집 세션 | 공통 필드, 편집 상태 |
| `personas` | 페르소나 | 공통 필드, 프롬프트·설정 |
| `comment_templates` | 댓글 양식 | 공통 필드, 양식 본문 |
| `accounts` | 연결 계정 참조 | 공통 필드, 식별 참조·확인 상태 |
| `assets` | 첨부파일 정보 | 공통 필드, MIME·크기·해시·Storage 경로 |
| `insight_snapshots` | 분석 스냅샷 | 공통 필드, 조회 결과·확인 시각 |
| `affiliate_items` | 제휴 상품 | 공통 필드, 상품 참조·메타데이터 |
| `affiliate_links` | 제휴 링크 | 공통 필드, 링크·관련 자료 참조 |
| `publish_jobs` | 발행 작업 기록 | 공통 필드, 요청·처리 상태 |
| `revenue_entries` | 수익 자료 | 공통 필드, 내용·첨부 |
| `generation_jobs` | AI 작업 | 공통 필드, 모델·입출력·작업 상태 |
| `sync_events` | 동기화·정리 기록 | 공통 필드, 처리 상태·오류 코드 |
| `api_cache` | 조회 자료 보관 | 공통 필드, 응답·확인 시각 |
| `extension_keys` | 확장 연결 | 공통 필드, 키 해시·만료·폐기 상태 |

17개 업무 테이블의 공통 필드는 다음과 같습니다.

| 필드 | 타입 | 의미 |
| --- | --- | --- |
| `id` | UUID | 기본키 |
| `workspace_id` | UUID | `workspaces.id` 외래키 |
| `title`, `content`, `source_url` | TEXT | 제목·본문·자료 주소 |
| `folder_id` | UUID, nullable | 같은 workspace의 폴더 참조 |
| `assets` | JSONB 배열 | 첨부파일 ID 목록, 최대 9개 |
| `metadata` | JSONB 객체 | 기능별 추가 정보 |
| `upstream_id` | TEXT, nullable | 연동 자료의 식별 참조 |
| `status`, `version` | TEXT, INTEGER | 처리 상태·수정 충돌 검사 |
| `created_at`, `updated_at` | TIMESTAMPTZ | 생성·수정 시각 |

자료의 `(workspace_id, folder_id)`는 폴더의 `(workspace_id, id)`를 참조합니다. 폴더 삭제 시 자료의 폴더 참조는 해제합니다. 첨부 참조는 JSONB로 관리하며 서버가 소유권과 사용 여부를 검사합니다. 수정 시 버전·수정 시각을 갱신하고 오래된 버전의 저장은 HTTP 409로 거절합니다. 모든 테이블은 RLS를 적용하고 서버 전용 권한으로 접근합니다.

## 로컬 실행

Node.js 24 환경에서 실행합니다.

```powershell
npm ci --omit=dev --ignore-scripts
npm --prefix web ci
npm --prefix web run build
node mission6/start.mjs
```

접속: `http://127.0.0.1:9251/dashboard/insights`. Next.js는 내부 9250, 연결 서버는 9251 포트를 사용합니다. 환경 파일은 `MISSION6_ENV_FILE`로 지정합니다. Windows 기본 위치는 `%LOCALAPPDATA%/HongThreads/secrets/mission6.env`입니다.

## 환경변수

이 표에는 **변수 이름과 용도만** 기록합니다. 실제 값·세션·비밀 키는 저장소와 문서에 기록하지 않습니다.

| 이름 | 용도 |
| --- | --- |
| `SUPABASE_URL` | 데이터·Storage 프로젝트 주소 |
| `SUPABASE_SECRET_KEY` | 서버 전용 Supabase 접근 키 |
| `SESSION_SIGNING_SECRET` | 앱 세션 검증 키 |
| `DATA_BACKEND` | 저장소 드라이버 선택 |
| `PUBLIC_ORIGIN` | 공개 서비스의 Origin |
| `PORT`, `DRT_NEXT_URL` | 내부 연결 서버 포트·Next.js 주소 |
| `MISSION6_ENV_FILE` | 환경 파일 위치 |
| `PUBLIC_ORIGINAL_ENABLED` | 검토용 자동 연결 사용 여부 |
| `PUBLIC_ORIGINAL_SESSION_FILE` | 암호화 연결 파일 위치 |
| `ORIGINAL_CONNECTION_KEY` | 연결 파일 복호화 키 |
| `VERTEX_TRANSPORT` | AI worker 호출 방식 |
| `VERTEX_NODE_PATH`, `VERTEX_WORKER_PATH` | worker 실행 파일 위치 |
| `VERTEX_PROJECT`, `VERTEX_LOCATION`, `VERTEX_MODEL` | AI 프로젝트·위치·모델 선택 |
| `HONGTHREADS_LOG_DIR`, `HONGTHREADS_RUNTIME_DIR` | 로그·프로세스 관리 파일 위치 |

브라우저 코드에 서버 키를 넣지 않습니다. 첨부파일은 비공개 버킷에서 관리하며 접근 주소는 필요한 기간만 서명합니다.

## QA 결과

2026-11-11 공개 HTTPS 환경에서 임시 점검용 자료·폴더·파일로 직접 점검했습니다. 점검 후 임시 자료는 삭제했습니다.

| 시나리오 | 확인 결과 | 판정 |
| --- | --- | --- |
| 빈 값 제출 | 필수 제목 공백 입력 → HTTP 400, 필드 오류 | 통과 |
| 잘못된 형식 제출 | 허용하지 않는 URL → HTTP 400 | 통과 |
| 등록 후 목록·상세 | 등록 201, 목록·상세 데이터 200, 화면 카드 표시 | 통과 |
| 새로고침 후 유지 | 재조회 후 본문·첨부 유지, 카드 표시 | 통과 |
| 수정 후 반영 | 수정 200, 새로고침 후 변경된 카드 표시 | 통과 |
| 삭제 후 반영 | 삭제 200, 카드 제거·상세 데이터 404 | 통과 |
| 존재하지 않는 상세 주소 | 상세 데이터 API → HTTP 404 | 통과 |
| 파일 없이 등록 | 첨부 없이 등록·목록·상세 조회 | 통과 |
| 업로드 파일 누락 | 파일 없는 업로드 요청 → HTTP 400 | 통과 |
| 업로드 실패 | 지원하지 않는 형식·위장 이미지 → HTTP 415 | 통과 |
| 파일 저장·미리보기·삭제 | 이미지 2개 저장·화면 표시, 첨부 해제 후 파일 404 | 통과 |
| 수정 충돌 | 이전 버전으로 수정 → HTTP 409 | 통과 |

CRUD·입력 오류 요청은 /workspace/api/v1 데이터 API로 전송하고, 보관함 화면에서 카드·이미지 표시와 새로고침 후 반영을 확인했습니다. 세부 검사 **14개 통과·실패 0개**, 브라우저 JavaScript 오류 0건, 점검 자료 정리 완료입니다. 상세는 팝업으로 표시하므로 없는 자료 검사는 상세 데이터 API 기준입니다. [QA 체크리스트](QA-CHECKLIST.ko.html)와 [실행 결과 JSON](mission6/qa/2026-11-11.json)에 방법·결과를 기록했습니다.

자동 검사 `npm test`는 **82개 통과**했습니다. 배포 빌드는 [Linux CI](https://github.com/misohong0520-hue/hongthreads-mission6/actions/runs/42853012407)에서 확인했습니다. 공개 13개 화면은 HTTP 200, JavaScript 오류·정적 파일 실패 0건을 확인했습니다. 게시·예약·결제·계정 설정 변경은 이번 CRUD QA 범위에 포함하지 않습니다.

## 권장 체크포인트

| 지점 | 검토 내용 | 결과 |
| --- | --- | --- |
| 1/3 | 핵심 기능·19개 테이블·폴더/자료/첨부 관계 검토 | 기능 명세·SQL과 대조 완료 |
| 2/3 | 실제 등록 → 목록 → 상세 데이터 흐름 | Supabase 저장과 화면 표시 확인 |
| 마감 전 | 배포 환경 CRUD·파일 업로드·새로고침 유지 재점검 | 2026-11-11, 세부 검사 14개 통과 |

## 배포와 검증 방법

배포 주소는 **https://hongthreads.hongsik.blog**입니다. AWS EC2에서 Nginx HTTPS와 두 systemd 서비스를 사용합니다. 릴리스 디렉터리와 `current` 링크로 버전을 관리하며 실패 시 직전 릴리스로 되돌립니다. GitHub Actions는 자동 검사·Next.js 빌드와 Linux 배포 파일 생성을 담당합니다.

```powershell
npm test
npm --prefix web run build
```

서비스 코드와 잠금 파일은 저장소에 포함합니다. 운영 환경 파일, 암호화 연결 파일, 실제 세션, SSH 키, 업로드 자료와 개인 응답은 포함하지 않습니다.
