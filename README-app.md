# Watchpup App (Electron 셸)

watchpup-core(헤드리스 백엔드)를 Electron에 임베드한 데스크톱 앱. 항상 떠 있는 투명 펫 창 + 멘션/조언/답장 승인용 패널 창 + 트레이로 구성된다.

## 1. 설치 & 실행

git clone 없이 바로 실행하려면:

```bash
npx github:jaden680/Watchpup
```

설치 시 `prepare` 스크립트가 자동으로 esbuild 번들을 만든다. 설정·데이터는 실행 위치와 무관하게 `~/.watchpup/`에 저장된다 (저장소 안에서 아래처럼 실행할 때는 현재 디렉토리 기준 `./watchpup.config.yaml`, `./data`를 그대로 쓴다 — `WATCHPUP_CONFIG`/`WATCHPUP_DATA_DIR`/`WATCHPUP_WORK_DIR` 환경변수로 둘 다 오버라이드 가능).

저장소를 직접 받아 실행하려면:

```bash
npm install
npm run app        # 개발 실행: esbuild 번들 + electron 기동
```

배포용 `.dmg`가 필요하면:

```bash
npm run dist        # esbuild 번들 + electron-builder → out/*.dmg
```

서명(codesign)/공인 인증서가 없는 환경에서는 `dist` 단계에서 서명 관련 경고가 날 수 있다. 로컬 테스트 목적이면 무시해도 된다.

## 2. 최초 설정 — Slack 토큰

토큰은 앱이 직접 다루지 않고 macOS Keychain에 저장된 값을 core가 읽는다. 다음 중 하나로 저장한다.

```bash
npm run setup       # CLI: SLACK_BOT_TOKEN(xoxb-...), SLACK_APP_TOKEN(xapp-...) 입력받아 Keychain에 저장
```

또는 패널의 **설정** 탭에서 직접 입력해도 저장된다 — `npx`로 실행해 저장소가 없는 환경에서는 이쪽만 가능하다.

앱을 처음 실행했을 때 토큰이 없으면 터미널/콘솔에 경고만 남기고 Slack 연동 없이 창은 뜬다. 토큰 저장 후 앱을 재시작하면 연동이 시작된다.

## 3. 설정값 — mySlackUserId / Obsidian / 모델

패널 창의 **설정** 탭에서 다음을 저장할 수 있다(저장 후 앱 재시작 필요):

- **내 Slack User ID** (`mySlackUserId`) — 필수. 이 사용자를 향한 멘션만 감지한다.
- **후속 스레드 추적** (`followThreads`) — 내가 참여한 스레드의 후속 메시지도 감지할지.
- **펫 크기** (`petSizePercent`) — 이모지·커스텀 이미지·Codex Pet 표시 크기(50~200%, 저장 즉시 반영).
- **Obsidian** — `enabled`/`vaultPath`/`folder`. 활성화 시 멘션마다 노트가 생성된다.
- **모델** (`model`) — claude 분석에 사용할 모델 이름(기본 `opus`).

같은 값들은 `watchpup.config.yaml`(없으면 최초 저장 시 생성)로도 직접 편집 가능하다 — 저장소 안에서 실행할 때는 프로젝트 루트, `npx`로 실행할 때는 `~/.watchpup/watchpup.config.yaml`.

## 4. 전제 조건

- 로컬에 `claude` CLI가 설치되어 있고 인증이 완료되어 있어야 한다(core가 `claude -p`로 분석/대화를 수행).
- Slack App에 Socket Mode(`xapp-` 토큰)와 Bot 토큰(`xoxb-`)이 발급되어 있어야 한다.

## 5. 사용법

1. `npm run app` 실행 → 화면 우하단에 펫이 뜨고, 메뉴바 트레이에 🐾 아이콘이 나타난다.
2. Slack에서 다른 계정으로 나를 멘션하면 펫이 `thinking` → `ready`로 바뀌고 배지가 올라간다.
3. 펫을 클릭하면 패널이 열리고, 멘션 카드를 선택하면 요약/조언/todo/답장 초안이 표시된다.
4. todo 체크박스를 토글하면 core가 상태를 저장한다(Obsidian 연동 시 노트에도 반영).
5. 답장 초안이 있으면 **승인** 버튼으로 실제 스레드에 게시하거나 **복사** 버튼으로 클립보드에 복사한다. Watchpup가 채널에 자동 게시하는 경우는 없다 — 승인해야만 게시된다.
6. 패널 하단 "의견 더 구하기" 입력창에 질문을 보내면 스트리밍으로 응답이 온다.

## 6. 자동 업데이트

패키징된(`app.isPackaged`) 빌드에서만 시작 시 `electron-updater`로 업데이트를 확인한다. `publish` 피드가 설정되어 있지 않으면 조용히 무시된다(개발 실행에는 영향 없음).

## 7. 트러블슈팅

- 펫/패널이 안 뜬다 → 터미널 로그 확인(`npm run app`은 콘솔 출력을 그대로 보여준다).
- Slack 연동이 안 된다 → `npm run setup`으로 토큰 저장 여부, 설정 탭의 `mySlackUserId` 확인 후 앱 재시작.
- 분석이 멈춘다 → `claude` CLI 인증 상태 확인.
