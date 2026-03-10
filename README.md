# Lanstar TalkTalk Assistant

네이버 톡톡 상담 자동화용 웹 콘솔입니다. 현재 구조는 `Render 배포 + OpenAI 답변 보강 + Playwright 브라우저 자동화` 기준으로 맞춰져 있습니다.

## 핵심 기능

- 상품 Q&A 4,077건과 실제 상담 이력 2,406건 검색
- 환불, 배송지 변경, AS, 배송 문의에 대한 정책 우선 처리
- 기존 이력이 없거나 약할 때 OpenAI로 답변 보강
- `검토 후 전송` / `자동 전송` 모드 전환
- 같은 네이버 로그인 안의 톡톡 채널 2개 선택 운영
- 네이버 톡톡 브라우저 자동화

## 로컬 실행

```bash
npm install
npm run dev
```

접속 주소: `http://127.0.0.1:4321`

## OpenAI 설정

기본 LLM은 OpenAI 기준으로 맞춰져 있습니다. `OPENAI_API_KEY` 만 넣어도 기본 모델은 `gpt-4.1-mini` 로 동작합니다.

```bash
OPENAI_API_KEY=your_api_key npm run dev
```

필요하면 아래도 함께 지정할 수 있습니다.

- `LLM_PROVIDER=openai`
- `LLM_MODEL=gpt-4.1-mini`
- `OPENAI_MODEL=gpt-4.1-mini`
- `LLM_BASE_URL=https://api.openai.com/v1`
- `LLM_TIMEOUT_MS=25000`
- `LLM_TEMPERATURE=0.2`
- `LLM_MAX_TOKENS=700`

## Render 배포

프로젝트에는 [render.yaml](/Users/lanstar/Documents/New project/render.yaml) 과 [Dockerfile](/Users/lanstar/Documents/New project/Dockerfile) 이 포함되어 있습니다.

배포 기준:

1. Render에서 Blueprint 또는 Docker 기반 Web Service로 배포
2. Persistent Disk를 `/opt/render/project/src/storage` 에 마운트
3. `OPENAI_API_KEY` 시크릿 등록
4. `healthCheckPath` 는 `/healthz`

기본 Render 환경값:

- `HOST=0.0.0.0`
- `PLAYWRIGHT_HEADLESS=true`
- `LLM_PROVIDER=openai`
- `LLM_MODEL=gpt-4.1-mini`
- `TALKTALK_STORAGE_STATE_PATH=/opt/render/project/src/storage/talktalk-account-1.state.json`
- `ADMIN_UPLOAD_TOKEN` (세션 파일 업로드용 관리자 토큰)

## 톡톡 로그인 세션 준비

Render 서버는 GUI 로그인이 불편하므로, 로컬에서 한 번 로그인한 뒤 `storageState` 파일을 만들어 서버 디스크에 올리는 방식을 권장합니다.

```bash
npm run export-storage-state
```

브라우저가 열리면 톡톡 파트너센터에 로그인하고 Enter를 누르면 세션 파일이 저장됩니다.

기본 저장 경로:

- 로컬: `storage/talktalk-account-1.state.json`
- Render: `/opt/render/project/src/storage/talktalk-account-1.state.json`

필요하면 환경변수로 경로를 바꿀 수 있습니다.

- `TALKTALK_STORAGE_STATE_PATH`
- `PLAYWRIGHT_BROWSER_CHANNEL`

Render 디스크 업로드가 필요하면 관리자 토큰을 설정한 뒤 아래 API를 사용할 수 있습니다.

- `POST /api/admin/storage-state`
- `GET /api/admin/storage-state-status`

## DOM 셀렉터 점검

실제 톡톡 파트너센터 DOM은 [config/talktalk.selectors.sample.json](/Users/lanstar/Documents/New project/config/talktalk.selectors.sample.json) 에 정리합니다. 현재는 아래 경로까지 실측 완료 상태입니다.

1. `https://partner.talk.naver.com/`
2. 상단 `내 계정`
3. `https://partner.talk.naver.com/web/accounts/list`

확보된 범위:

- 상단 `내 계정` 버튼
- `상담` 메뉴
- 계정 목록 카드
- 계정명
- `채팅창` 공개 URL
- `계정 홈 바로가기`
- 상태 드롭다운
- 연결된 스마트스토어 채널 링크

직접 다시 점검하려면 아래를 사용합니다.

```bash
npm run inspect-talktalk-dom
```

선택 클릭까지 포함하려면 예:

```bash
TALKTALK_INSPECT_URL=https://partner.talk.naver.com \
TALKTALK_CLICK_SELECTOR="a[href='/web/accounts/list'][class*='Gnb-module__control']" \
npm run inspect-talktalk-dom
```

산출물은 `tmp/talktalk-inspect/` 아래에 저장됩니다.

## 운영 흐름

1. 좌측 상단에서 톡톡 채널을 선택
2. 자동화 시작
3. 현재 열려 있는 톡톡 대화에서 메시지 수집
4. `정책 + 검색` 으로 기본 답변 생성
5. 답변이 약하거나 이력이 부족하면 OpenAI가 보강
6. 사람이 검토 후 전송하거나, 조건 충족 시 자동 전송

## 주요 파일

- [src/server.js](/Users/lanstar/Documents/New project/src/server.js): 웹 서버, API, 헬스체크
- [src/lib/reply-engine.js](/Users/lanstar/Documents/New project/src/lib/reply-engine.js): 정책 + 검색 + LLM 하이브리드 엔진
- [src/lib/llm-client.js](/Users/lanstar/Documents/New project/src/lib/llm-client.js): OpenAI 호출
- [src/automation/talktalk-worker.js](/Users/lanstar/Documents/New project/src/automation/talktalk-worker.js): Playwright 워커
- [src/lib/settings.js](/Users/lanstar/Documents/New project/src/lib/settings.js): 채널 / LLM / 브라우저 설정
- [scripts/export-storage-state.js](/Users/lanstar/Documents/New project/scripts/export-storage-state.js): 세션 파일 추출

## 한계

- 네이버 톡톡 DOM 셀렉터는 실제 운영 화면에서 한 번 더 보정이 필요합니다.
- Render에서 실제 전송까지 쓰려면 storageState 파일 유지와 세션 만료 대응이 필요합니다.
- 정책성 문의는 의도적으로 LLM이 덮어쓰지 않도록 제한되어 있습니다.
