# Bubble / Session HUD Size Design QA

- reference: 사용자가 제공한 세션 HUD 캡처 (`codex-clipboard-080046d2-668f-4134-9f51-136355b54777.png`)
- implementation: 로컬 Electron의 `watchpup pet` 창, 말풍선 80% · HUD 70%
- comparison: `.design-qa/comparison-size-controls.png` (레퍼런스와 구현을 한 이미지로 결합, Git 제외)
- viewport: 구현 창 401 x 222

## 확인 결과

- P0: 없음. 축소 후에도 Claude/Codex 실제 앱 아이콘과 세션 데이터가 정상 표시됨.
- P1: 없음. 70% HUD에서 제목, 상태, 컨텍스트 비율, 경과 시간이 창 밖으로 잘리지 않음.
- P2: 없음. 배경, 테두리, 모서리, 행 높이, 아이콘, 텍스트, 상태 pill이 같은 비율로 축소됨.
- interaction: 설정 > 펫에서 `말풍선 크기`와 `세션 HUD 크기`를 60~140% 범위로 각각 조절하고 저장할 수 있음.
- persistence: 말풍선 80%와 HUD 70%를 저장한 뒤 앱을 재실행해 값과 화면 크기가 유지되는 것을 확인함.
- regression: HUD가 없으면 기존 340px 펫 창 폭으로 복귀하고, HUD가 있으면 설정 비율에 맞춰 창 폭도 함께 변경됨.
- visibility: `세션 HUD 표시`를 끄면 HUD 크기 슬라이더가 비활성화되고 펫만 남음 (`.design-qa/hud-hidden.jpeg`).
- visibility persistence: 숨김 상태로 앱을 재실행해도 세션 수집은 계속되고 340 x 164 펫 창에서 HUD가 다시 나타나지 않음을 확인함.
- message integration: HUD가 켜져 있으면 기존 말풍선 내용이 HUD 최상단의 최대 2줄 상태 영역에 표시되고, 별도 말풍선은 중복 노출되지 않음.
- message fallback: HUD를 숨기면 같은 내용이 기존 말풍선으로 자동 복귀하며, 두 표면 모두 클릭 시 동일한 스레드/패널을 엶.

final result: passed
