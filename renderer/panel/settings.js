// 설정/워크플로우 레이어 — Slack·펫·워크플로우·저장소 설정 UI + playbook CRUD + 교훈/그룹/레포/토큰.
// panel(멘션 렌더)과의 결합은 onPlaybooksChanged 훅 하나로만 (순환 의존 제거).
import { playbooks, playbookById } from './playbooks.js'
import { lessonKeyLabel } from './format.js'
import { copyToClipboard } from './richtext.js'
import { modelOptionsWithCurrent } from './model-options.js'

// Slack 봇 생성용 앱 매니페스트 (From an app manifest 에 붙여넣기).
// scope는 코드가 실제 호출하는 API에 맞춤: conversations.replies/info, chat.postMessage,
// users.info, usergroups.list(그룹 멘션 <!subteam> 치환), search.messages(User Token, 전 채널 검색).
const SLACK_MANIFEST = `display_information:
  name: Watchpup
  description: 내 Slack 멘션을 지켜보는 데스크톱 펫
features:
  bot_user:
    display_name: Watchpup
    always_online: true
oauth_config:
  scopes:
    user:
      - search:read          # 전 채널 멘션 검색(User Token)
      - channels:history     # 공개 채널 스레드 읽기·후속 추적
      - groups:history       # 비공개 채널 스레드 읽기·후속 추적
      - im:history           # DM 스레드 읽기
      - mpim:history         # 그룹 DM 스레드 읽기
      - channels:read        # 채널 이름 해석
      - groups:read          # 비공개 채널 이름 해석
      - im:read
      - mpim:read
      - users:read           # 작성자 이름 해석
      - usergroups:read      # 내 유저그룹 검색
      - reactions:read       # 메시지 리액션 조회
      - reactions:write      # 내 계정으로 리액션 추가·취소
    bot:
      - channels:history
      - groups:history
      - im:history
      - mpim:history
      - channels:read
      - groups:read
      - im:read
      - mpim:read
      - chat:write            # 승인한 답장 게시
      - users:read
      - usergroups:read       # 그룹(@subteam) 멘션 해석
settings:
  event_subscriptions:
    bot_events:
      - message.channels
      - message.groups
      - message.im
  interactivity:
    is_enabled: false
  org_deploy_enabled: false
  socket_mode_enabled: true
  token_rotation_enabled: false
`

document.getElementById('manifest-btn')?.addEventListener('click', () => {
  const overlay = document.createElement('div')
  overlay.className = 'modal-overlay'
  const box = document.createElement('div')
  box.className = 'modal-box'
  const ta = document.createElement('textarea')
  ta.id = 'manifest-text'
  ta.readOnly = true
  ta.spellcheck = false
  ta.value = SLACK_MANIFEST
  const bar = document.createElement('div')
  bar.className = 'modal-bar'
  const copy = document.createElement('button')
  copy.type = 'button'
  copy.textContent = '복사'
  copy.className = 'primary'
  copy.addEventListener('click', () => {
    copyToClipboard(SLACK_MANIFEST)
    copy.textContent = '복사됨'
    setTimeout(() => { copy.textContent = '복사' }, 1600)
  })
  const close = document.createElement('button')
  close.type = 'button'
  close.textContent = '닫기'
  const dismiss = () => overlay.remove()
  close.addEventListener('click', dismiss)
  overlay.addEventListener('click', (e) => { if (e.target === overlay) dismiss() })
  bar.append(copy, close)
  box.append(ta, bar)
  overlay.append(box)
  document.body.appendChild(overlay)
})

// playbook 변경 시 panel이 열린 상세를 다시 그리도록 등록하는 훅
let onPlaybooksChanged = () => {}
export function setOnPlaybooksChanged(fn) { onPlaybooksChanged = fn }

async function loadPlaybooks() {
  playbooks.list = await window.watchpup.playbooksList()
  renderPlaybooksList()
}

// ---- 설정 서브탭(카테고리) 전환 ----
const settingsViewEl = document.getElementById('settings-view')
const settingsFormEl = document.getElementById('settings-form')
const playbooksPanelEl = document.getElementById('playbooks-panel')

function showSset(key) {
  document.querySelectorAll('.sset-tab').forEach((t) => t.classList.toggle('active', t.dataset.sset === key))
  document.querySelectorAll('.sset').forEach((s) => s.classList.toggle('active', s.dataset.sset === key))
  const isFlow = key === 'flow'
  settingsViewEl.classList.toggle('flow-active', isFlow)
  settingsFormEl.style.display = isFlow ? 'none' : ''
  playbooksPanelEl.style.display = isFlow ? '' : 'none'
  if (key === 'nagging') void renderNaggingLog()
}

document.querySelectorAll('.sset-tab').forEach((tab) => {
  tab.addEventListener('click', () => showSset(tab.dataset.sset))
})

showSset('detect')

// ---- 설정 ----
const settingsForm = document.getElementById('settings-form')
const settingsStatus = document.getElementById('settings-status')
const petSizeInput = settingsForm.elements['petSizePercent']
const petSizeValue = document.getElementById('pet-size-value')
const bubbleSizeInput = settingsForm.elements['bubbleSizePercent']
const bubbleSizeValue = document.getElementById('bubble-size-value')
const bubbleStackCountInput = settingsForm.elements['bubbleStackCount']
const bubbleDurationInput = settingsForm.elements['bubbleDurationSeconds']
const hudSizeInput = settingsForm.elements['hudSizePercent']
const hudSizeValue = document.getElementById('hud-size-value')
const showActivityHudInput = settingsForm.elements['showActivityHud']
const hudSizeField = document.getElementById('hud-size-field')
const hudAlignmentInput = settingsForm.elements['hudAlignment']
const hudAlignmentField = document.getElementById('hud-alignment-field')
const modelSelect = settingsForm.elements['model']
const modelRefreshButton = document.getElementById('model-refresh')
const modelHint = document.getElementById('model-hint')
const naggingEnabledInput = settingsForm.elements['naggingEnabled']
const naggingMinInput = settingsForm.elements['naggingMinMinutes']
const naggingMaxInput = settingsForm.elements['naggingMaxMinutes']
const githubPrNaggingEnabledInput = settingsForm.elements['githubPrNaggingEnabled']
const slackNewsEnabledInput = settingsForm.elements['slackNewsEnabled']
const slackNewsChannelsInput = settingsForm.elements['slackNewsChannels']
const slackNewsKeywordsInput = settingsForm.elements['slackNewsKeywords']
const buildAlertsEnabledInput = settingsForm.elements['buildAlertsEnabled']
const xcodeBuildAlertsEnabledInput = settingsForm.elements['xcodeBuildAlertsEnabled']
const androidBuildAlertsEnabledInput = settingsForm.elements['androidBuildAlertsEnabled']
const buildAlertCard = document.querySelector('.build-alert-card')
const buildAlertHint = document.getElementById('build-alert-hint')
const naggingCard = document.querySelector('.nagging-card')
const naggingHint = document.getElementById('nagging-hint')
const naggingCalendarSettings = document.getElementById('nagging-calendar-settings')
const naggingLogList = document.getElementById('nagging-log-list')
const naggingLogCount = document.getElementById('nagging-log-count')
const naggingLogRefresh = document.getElementById('nagging-log-refresh')
const naggingLogClear = document.getElementById('nagging-log-clear')

const NAGGING_KIND_LABELS = {
  calendar: '캘린더',
  agent: 'Agent',
  github: 'GitHub',
  slack: 'Slack',
  work: 'Work',
  general: '일반',
}

function naggingLogRow(entry) {
  const row = document.createElement('li')
  const meta = document.createElement('div')
  meta.className = 'nagging-log-meta'
  const kind = document.createElement('span')
  kind.className = `nagging-log-kind kind-${entry.kind || 'general'}`
  kind.textContent = NAGGING_KIND_LABELS[entry.kind] || entry.kind || '일반'
  const time = document.createElement('time')
  time.dateTime = new Date(entry.at).toISOString()
  time.textContent = new Date(entry.at).toLocaleString('ko-KR', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' })
  meta.append(kind, time)
  if (entry.context) {
    const context = document.createElement('span')
    context.className = 'nagging-log-context'
    context.textContent = entry.context
    meta.append(context)
  }
  const text = document.createElement('p')
  text.textContent = entry.text || '(빈 문구)'
  row.append(meta, text)
  return row
}

async function renderNaggingLog() {
  if (!naggingLogList) return
  try {
    const entries = await window.watchpup.naggingLogList()
    naggingLogCount.textContent = `최근 잔소리 ${entries.length}개`
    naggingLogList.replaceChildren(...entries.map(naggingLogRow))
    if (!entries.length) {
      const empty = document.createElement('li')
      empty.className = 'nagging-log-empty'
      empty.textContent = '아직 표시된 잔소리가 없어요.'
      naggingLogList.append(empty)
    }
  } catch (error) {
    naggingLogList.replaceChildren()
    const failed = document.createElement('li')
    failed.className = 'nagging-log-empty'
    failed.textContent = `로그를 불러오지 못했습니다: ${error?.message || error}`
    naggingLogList.append(failed)
  }
}

function renderModelOptions(current, available) {
  const modelState = modelOptionsWithCurrent(current, available)
  modelSelect.replaceChildren(...modelState.options.map(({ value, label, custom }) => {
    const option = document.createElement('option')
    option.value = value
    option.textContent = label
    if (custom) option.dataset.custom = 'true'
    return option
  }))
  modelSelect.value = modelState.selected
}

function modelCatalogHint(catalog) {
  if (catalog.source === 'fallback') return `CLI 조회 실패 · 기본 목록 사용${catalog.error ? ` (${catalog.error})` : ''}`
  const fetched = catalog.fetchedAt ? new Date(catalog.fetchedAt).toLocaleString('ko-KR') : ''
  const cached = catalog.cached ? '마지막 조회' : '방금 조회'
  return `${catalog.options.length}개 모델 · Claude CLI ${catalog.cliVersion} · ${cached}${fetched ? ` ${fetched}` : ''}`
}

// Work 에이전트용 Claude 모델 선택: '' = 전역 모델 따름 옵션을 앞에 붙인다
function renderWorkAgentModelOptions(current, available) {
  const select = settingsForm.elements['workAgentModel']
  if (!select) return
  const modelState = modelOptionsWithCurrent(current || 'default', available)
  const options = [{ value: '', label: '전역 모델 따름' }, ...modelState.options]
  select.replaceChildren(...options.map(({ value, label }) => {
    const option = document.createElement('option')
    option.value = value
    option.textContent = label
    return option
  }))
  select.value = current || ''
  if (select.value !== (current || '')) select.value = ''
}

async function loadModelCatalog(current, force = false) {
  if (!modelSelect) return
  modelRefreshButton.disabled = true
  modelHint.textContent = force ? 'Claude CLI에서 모델 목록 새로고침 중…' : '모델 목록 확인 중…'
  try {
    const catalog = force ? await window.watchpup.modelCatalogRefresh() : await window.watchpup.modelCatalogGet()
    renderModelOptions(modelSelect.value || current, catalog.options)
    const workAgentSelect = settingsForm.elements['workAgentModel']
    if (workAgentSelect) renderWorkAgentModelOptions(workAgentSelect.value, catalog.options)
    modelHint.textContent = modelCatalogHint(catalog)
  } catch (error) {
    modelHint.textContent = error?.message || 'Claude CLI 모델 목록을 읽지 못했습니다.'
  } finally {
    modelRefreshButton.disabled = false
  }
}

modelRefreshButton?.addEventListener('click', () => loadModelCatalog(modelSelect.value, true))

function updatePetSizeLabel() {
  if (petSizeInput && petSizeValue) petSizeValue.textContent = `${petSizeInput.value}%`
}

function updateBubbleSizeLabel() {
  if (bubbleSizeInput && bubbleSizeValue) bubbleSizeValue.textContent = `${bubbleSizeInput.value}%`
}

function boundedInteger(input, fallback, minimum, maximum) {
  const value = parseInt(input?.value || '', 10)
  return Number.isFinite(value) ? Math.max(minimum, Math.min(maximum, value)) : fallback
}

function updateHudSizeLabel() {
  if (hudSizeInput && hudSizeValue) hudSizeValue.textContent = `${hudSizeInput.value}%`
}

function updateHudControls() {
  const enabled = showActivityHudInput?.checked !== false
  if (hudSizeInput) hudSizeInput.disabled = !enabled
  if (hudAlignmentInput) hudAlignmentInput.disabled = !enabled
  if (hudSizeField) hudSizeField.classList.toggle('is-disabled', !enabled)
  if (hudAlignmentField) hudAlignmentField.classList.toggle('is-disabled', !enabled)
}

function naggingMinutes(input, fallback) {
  const value = parseInt(input?.value || '', 10)
  return Number.isFinite(value) ? Math.max(1, Math.min(120, value)) : fallback
}

function subscriptionList(value) {
  return [...new Set(String(value || '').split(/[,\n]/).map((item) => item.trim()).filter(Boolean))]
}

function updateNaggingControls() {
  const enabled = !!naggingEnabledInput?.checked
  if (naggingMinInput) naggingMinInput.disabled = !enabled
  if (naggingMaxInput) naggingMaxInput.disabled = !enabled
  if (githubPrNaggingEnabledInput) githubPrNaggingEnabledInput.disabled = !enabled
  if (slackNewsEnabledInput) slackNewsEnabledInput.disabled = !enabled
  const slackNewsEnabled = enabled && !!slackNewsEnabledInput?.checked
  const githubPrEnabled = enabled && !!githubPrNaggingEnabledInput?.checked
  if (slackNewsChannelsInput) slackNewsChannelsInput.disabled = !slackNewsEnabled
  if (slackNewsKeywordsInput) slackNewsKeywordsInput.disabled = !slackNewsEnabled
  naggingCard?.classList.toggle('is-disabled', !enabled)
  const min = naggingMinutes(naggingMinInput, 5)
  const max = Math.max(min, naggingMinutes(naggingMaxInput, 12))
  if (naggingHint) {
    naggingHint.textContent = enabled
      ? `캘린더·Agent 타이밍을 먼저 알리고, 그 외에는 ${min}~${max}분 사이에 Work${githubPrEnabled ? '·GitHub PR' : ''}${slackNewsEnabled ? '·Slack 새 소식' : ''}을 다시 꺼냅니다.`
      : '현재 꺼져 있어요. 활성화해야 잔소리가 시작됩니다.'
  }
}

function updateBuildAlertControls() {
  const enabled = !!buildAlertsEnabledInput?.checked
  if (xcodeBuildAlertsEnabledInput) xcodeBuildAlertsEnabledInput.disabled = !enabled
  if (androidBuildAlertsEnabledInput) androidBuildAlertsEnabledInput.disabled = !enabled
  buildAlertCard?.classList.toggle('is-disabled', !enabled)
  const tools = [
    xcodeBuildAlertsEnabledInput?.checked ? 'Xcode' : '',
    androidBuildAlertsEnabledInput?.checked ? 'Android Studio' : '',
  ].filter(Boolean)
  if (buildAlertHint) {
    buildAlertHint.textContent = enabled
      ? `${tools.join('·') || '선택한 IDE 없음'}의 새 빌드 완료를 약 3초 안에 알려줍니다.`
      : '현재 꺼져 있어요. 활성화 이후 완료되는 새 빌드부터 알려줍니다.'
  }
}

if (petSizeInput) petSizeInput.addEventListener('input', updatePetSizeLabel)
if (bubbleSizeInput) bubbleSizeInput.addEventListener('input', updateBubbleSizeLabel)
if (hudSizeInput) hudSizeInput.addEventListener('input', updateHudSizeLabel)
if (showActivityHudInput) showActivityHudInput.addEventListener('change', updateHudControls)
if (naggingEnabledInput) naggingEnabledInput.addEventListener('change', updateNaggingControls)
if (naggingMinInput) naggingMinInput.addEventListener('input', updateNaggingControls)
if (naggingMaxInput) naggingMaxInput.addEventListener('input', updateNaggingControls)
if (githubPrNaggingEnabledInput) githubPrNaggingEnabledInput.addEventListener('change', updateNaggingControls)
if (slackNewsEnabledInput) slackNewsEnabledInput.addEventListener('change', updateNaggingControls)
if (buildAlertsEnabledInput) buildAlertsEnabledInput.addEventListener('change', updateBuildAlertControls)
if (xcodeBuildAlertsEnabledInput) xcodeBuildAlertsEnabledInput.addEventListener('change', updateBuildAlertControls)
if (androidBuildAlertsEnabledInput) androidBuildAlertsEnabledInput.addEventListener('change', updateBuildAlertControls)
if (naggingCalendarSettings) naggingCalendarSettings.addEventListener('click', async () => {
  if (naggingCalendarSettings.dataset.openSettings === 'true') {
    window.watchpup.openCalendarPrivacy()
    return
  }
  naggingCalendarSettings.disabled = true
  naggingCalendarSettings.textContent = '연결 중…'
  try {
    const status = await window.watchpup.requestCalendarAccess()
    naggingCalendarSettings.textContent = status === 'authorized' ? '캘린더 연결됨' : '캘린더 연결'
    if (status !== 'authorized' && naggingHint) naggingHint.textContent = '캘린더 권한이 허용되지 않았어요. 시스템 설정에서 Watchpup을 허용해주세요.'
  } catch (error) {
    naggingCalendarSettings.textContent = '시스템 설정 열기'
    if (naggingHint) naggingHint.textContent = error?.message || '캘린더 권한을 확인하지 못했습니다.'
    naggingCalendarSettings.dataset.openSettings = 'true'
  } finally {
    naggingCalendarSettings.disabled = false
  }
})
if (naggingLogRefresh) naggingLogRefresh.addEventListener('click', () => renderNaggingLog())
if (naggingLogClear) naggingLogClear.addEventListener('click', async () => {
  if (!confirm('잔소리 디버그 로그를 모두 비울까요?')) return
  await window.watchpup.naggingLogClear()
  await renderNaggingLog()
})
window.watchpup.onNaggingLogChanged?.(() => renderNaggingLog())

async function loadSettings() {
  const cfg = await window.watchpup.settingsGet()
  settingsForm.elements['mySlackUserId'].value = cfg.mySlackUserId || ''
  settingsForm.elements['followThreads'].checked = !!cfg.followThreads
  settingsForm.elements['petTheme'].value = cfg.petTheme || 'paw'
  if (settingsForm.elements['petAlwaysOnTop']) settingsForm.elements['petAlwaysOnTop'].checked = cfg.petAlwaysOnTop !== false
  if (petSizeInput) petSizeInput.value = String(cfg.petSizePercent ?? 100)
  if (bubbleSizeInput) bubbleSizeInput.value = String(cfg.bubbleSizePercent ?? 100)
  if (bubbleStackCountInput) bubbleStackCountInput.value = String(cfg.bubbleStackCount ?? 3)
  if (bubbleDurationInput) bubbleDurationInput.value = String(cfg.bubbleDurationSeconds ?? 10)
  if (hudSizeInput) hudSizeInput.value = String(cfg.hudSizePercent ?? 100)
  if (hudAlignmentInput) hudAlignmentInput.value = cfg.hudAlignment === 'left' ? 'left' : 'right'
  if (showActivityHudInput) showActivityHudInput.checked = cfg.showActivityHud !== false
  if (naggingEnabledInput) naggingEnabledInput.checked = cfg.naggingEnabled === true
  if (naggingMinInput) naggingMinInput.value = String(cfg.naggingMinMinutes ?? 5)
  if (naggingMaxInput) naggingMaxInput.value = String(cfg.naggingMaxMinutes ?? 12)
  if (githubPrNaggingEnabledInput) githubPrNaggingEnabledInput.checked = cfg.githubPrNaggingEnabled !== false
  if (slackNewsEnabledInput) slackNewsEnabledInput.checked = cfg.slackNewsEnabled === true
  if (slackNewsChannelsInput) slackNewsChannelsInput.value = (cfg.slackNewsChannels || ['all_전사공유', 'all_전사공지', 'all_random']).join(', ')
  if (slackNewsKeywordsInput) slackNewsKeywordsInput.value = (cfg.slackNewsKeywords || []).join(', ')
  if (buildAlertsEnabledInput) buildAlertsEnabledInput.checked = cfg.buildAlertsEnabled === true
  if (xcodeBuildAlertsEnabledInput) xcodeBuildAlertsEnabledInput.checked = cfg.xcodeBuildAlertsEnabled !== false
  if (androidBuildAlertsEnabledInput) androidBuildAlertsEnabledInput.checked = cfg.androidBuildAlertsEnabled !== false
  updatePetSizeLabel()
  updateBubbleSizeLabel()
  updateHudSizeLabel()
  updateHudControls()
  updateNaggingControls()
  updateBuildAlertControls()
  await renderNaggingLog()
  if (settingsForm.elements['persona']) settingsForm.elements['persona'].value = cfg.persona || ''
  if (settingsForm.elements['bubbleStyle']) settingsForm.elements['bubbleStyle'].value = cfg.bubbleStyle || 'status'
  const petimgPathEl = document.getElementById('petimg-path')
  if (petimgPathEl) petimgPathEl.textContent = cfg.petImageDir ? cfg.petImageDir : '이모지 사용 중'
  await loadCodexPets(cfg.petCodexDir || '')
  settingsForm.elements['enableBot'].checked = cfg.enableBot !== false
  settingsForm.elements['enableUserSearch'].checked = !!cfg.enableUserSearch
  settingsForm.elements['searchIntervalSec'].value = cfg.searchIntervalSec || 45
  if (settingsForm.elements['ingestMaxAgeDays']) settingsForm.elements['ingestMaxAgeDays'].value = cfg.ingestMaxAgeDays ?? 7
  settingsForm.elements['obsidian.enabled'].checked = !!cfg.obsidian?.enabled
  settingsForm.elements['obsidian.vaultPath'].value = cfg.obsidian?.vaultPath || ''
  settingsForm.elements['obsidian.folder'].value = cfg.obsidian?.folder || ''
  updateObsidianHint()
  renderModelOptions(cfg.model)
  void loadModelCatalog(cfg.model)
  if (settingsForm.elements['workAgentEnabled']) {
    settingsForm.elements['workAgentEnabled'].checked = !!cfg.workAgentEnabled
    settingsForm.elements['workAgentUseOrca'].checked = cfg.workAgentUseOrca !== false
    settingsForm.elements['workAgentEnglishBranch'].checked = !!cfg.workAgentEnglishBranch
    settingsForm.elements['workAgentProvider'].value = cfg.workAgentProvider === 'codex' ? 'codex' : 'claude'
    settingsForm.elements['workAgentCodexModel'].value = cfg.workAgentCodexModel || ''
    settingsForm.elements['workAgentIntervalMinutes'].value = cfg.workAgentIntervalMinutes || 30
    renderWorkAgentModelOptions(cfg.workAgentModel || '')
  }
  await refreshTokenStatus()
  await renderGroups()
  await renderRepos()
  await renderLessons()
  await renderMcpList()
  await renderIntegrations()
}

// ---- 간편 연동 (Notion · Jira) ----
async function renderIntegrations() {
  let st = { notion: { connected: false }, jira: { connected: false, site: '', email: '' } }
  try { st = await window.watchpup.integrationStatus() } catch (e) { /* ignore */ }
  const nS = document.getElementById('integ-notion-status')
  if (nS) { nS.textContent = st.notion.connected ? '● 연결됨' : '○ 미연결'; nS.className = 'integ-status ' + (st.notion.connected ? 'on' : '') }
  const nD = document.getElementById('notion-disconnect')
  if (nD) nD.classList.toggle('hidden', !st.notion.connected)
  const jS = document.getElementById('integ-jira-status')
  if (jS) {
    const needsReconnect = st.jira.connected && st.jira.authenticated === false
    jS.textContent = needsReconnect ? '● 재연결 필요' : st.jira.connected ? '● 연결됨' : '○ 미연결'
    jS.className = 'integ-status ' + (needsReconnect ? 'warn' : st.jira.connected ? 'on' : '')
    jS.title = needsReconnect ? (st.jira.error || 'Jira API Token을 다시 입력해주세요.') : ''
  }
  const jD = document.getElementById('jira-disconnect')
  if (jD) jD.classList.toggle('hidden', !st.jira.connected)
  if (st.jira.site) document.getElementById('jira-site').value = st.jira.site
  if (st.jira.email) document.getElementById('jira-email').value = st.jira.email
}

document.getElementById('notion-connect')?.addEventListener('click', async () => {
  const msg = document.getElementById('notion-msg')
  const token = document.getElementById('notion-token').value.trim()
  const status = await window.watchpup.integrationStatus()
  if (!token && !status.notion.connected) { msg.textContent = '토큰을 입력하세요'; return }
  msg.textContent = '연결 중…'
  try {
    await window.watchpup.connectNotion(token)
    document.getElementById('notion-token').value = ''
    msg.textContent = '연결됨 (다음 분석부터 적용)'
    await renderIntegrations(); await renderMcpList()
  } catch (e) { msg.textContent = '실패: ' + (e?.message || e) }
})
document.getElementById('notion-disconnect')?.addEventListener('click', async () => {
  if (!confirm('Notion 연동을 해제할까요?')) return
  await window.watchpup.disconnectIntegration('notion')
  await renderIntegrations(); await renderMcpList()
})
document.getElementById('jira-connect')?.addEventListener('click', async () => {
  const msg = document.getElementById('jira-msg')
  const site = document.getElementById('jira-site').value.trim()
  const email = document.getElementById('jira-email').value.trim()
  const token = document.getElementById('jira-token').value.trim()
  const status = await window.watchpup.integrationStatus()
  if (!site || !email) { msg.textContent = '사이트·이메일 필수'; return }
  if (!token && (!status.jira.connected || status.jira.authenticated === false)) { msg.textContent = '새 API 토큰을 입력하세요'; return }
  msg.textContent = '연결 중…'
  try {
    await window.watchpup.connectJira({ site, email, token })
    document.getElementById('jira-token').value = ''
    await renderIntegrations(); await renderMcpList()
    const verified = await window.watchpup.integrationStatus(true)
    msg.textContent = verified.jira.authenticated ? '연결됨' : (verified.jira.error || '인증 확인 실패')
  } catch (e) { msg.textContent = '실패: ' + (e?.message || e) }
})
document.getElementById('jira-token-page')?.addEventListener('click', () => {
  window.watchpup.openExternal('https://id.atlassian.com/manage-profile/security/api-tokens')
})
document.getElementById('jira-disconnect')?.addEventListener('click', async () => {
  if (!confirm('Jira 연동을 해제할까요?')) return
  await window.watchpup.disconnectIntegration('jira')
  await renderIntegrations(); await renderMcpList()
})

// ---- 학습한 교훈 (자가발전) ----
async function renderLessons() {
  const listEl = document.getElementById('lessons-list')
  if (!listEl) return
  let byKey = {}
  try {
    byKey = (await window.watchpup.lessonsList()) || {}
  } catch (e) {
    /* ignore */
  }
  listEl.innerHTML = ''
  const keys = Object.keys(byKey).filter((k) => (byKey[k] || []).length)
  if (!keys.length) {
    const p = document.createElement('p')
    p.className = 'hint'
    p.textContent = '아직 배운 교훈이 없어요. 분석에서 “개선점 알려주기”로 피드백을 남겨보세요.'
    listEl.appendChild(p)
    return
  }
  for (const key of keys) {
    const items = byKey[key] || []
    const group = document.createElement('details')
    group.className = 'tools lesson-group'
    const sum = document.createElement('summary')
    sum.textContent = `${lessonKeyLabel(key)} (${items.length})`
    group.appendChild(sum)

    const body = document.createElement('div')
    body.className = 'lesson-body'
    items.forEach((l, i) => body.appendChild(lessonRow(key, i, l)))

    // ＋ 교훈 추가 + 전체 삭제
    const foot = document.createElement('div')
    foot.className = 'lesson-foot'
    const addBtn = document.createElement('button')
    addBtn.type = 'button'
    addBtn.className = 'lesson-add'
    addBtn.textContent = '＋ 교훈 추가'
    addBtn.addEventListener('click', () => {
      const editor = lessonEditor('', async (text) => {
        await window.watchpup.lessonsAdd(key, text)
        renderLessons()
      })
      body.appendChild(editor)
      editor.querySelector('textarea').focus()
    })
    const clearAll = document.createElement('button')
    clearAll.type = 'button'
    clearAll.className = 'lesson-clear'
    clearAll.textContent = '전체 삭제'
    clearAll.addEventListener('click', async () => {
      if (!confirm(`'${lessonKeyLabel(key)}' 교훈을 모두 삭제할까요?`)) return
      await window.watchpup.lessonsClear(key)
      renderLessons()
    })
    foot.append(addBtn, clearAll)

    group.append(body, foot)
    listEl.appendChild(group)
  }
}

// 교훈 한 줄: 출처 배지 + 텍스트 + 수정/삭제
function lessonRow(key, i, l) {
  const row = document.createElement('div')
  row.className = 'lesson-item'
  const src = document.createElement('span')
  src.className = 'lesson-src ' + (l.source === 'user' ? 'user' : 'self')
  src.textContent = l.source === 'user' ? '내 피드백' : '자가평가'
  const txt = document.createElement('span')
  txt.className = 'lesson-text'
  txt.textContent = l.text
  const edit = document.createElement('button')
  edit.type = 'button'
  edit.className = 'lesson-edit'
  edit.textContent = '수정'
  edit.title = '이 교훈 수정'
  edit.addEventListener('click', () => {
    const editor = lessonEditor(l.text, async (text) => {
      await window.watchpup.lessonsEdit(key, i, text)
      renderLessons()
    })
    row.replaceWith(editor)
    editor.querySelector('textarea').focus()
  })
  const x = document.createElement('button')
  x.type = 'button'
  x.className = 'lesson-x'
  x.textContent = '×'
  x.title = '이 교훈 삭제'
  x.addEventListener('click', async () => {
    await window.watchpup.lessonsClear(key, i)
    renderLessons()
  })
  row.append(src, txt, edit, x)
  return row
}

// 인라인 편집기(추가/수정 공용): 텍스트영역 + 저장/취소
function lessonEditor(initial, onSave) {
  const box = document.createElement('div')
  box.className = 'lesson-editor'
  const ta = document.createElement('textarea')
  ta.className = 'dev-extra'
  ta.rows = 2
  ta.value = initial || ''
  ta.placeholder = '다음 실행부터 반영할 교훈을 적어주세요'
  const actions = document.createElement('div')
  actions.className = 'lesson-editor-actions'
  const save = document.createElement('button')
  save.type = 'button'
  save.className = 'primary'
  save.textContent = '저장'
  save.addEventListener('click', () => { const t = ta.value.trim(); if (t) onSave(t); else renderLessons() })
  const cancel = document.createElement('button')
  cancel.type = 'button'
  cancel.textContent = '취소'
  cancel.addEventListener('click', () => renderLessons())
  actions.append(save, cancel)
  box.append(ta, actions)
  return box
}
if (window.watchpup.onLessonsChanged) window.watchpup.onLessonsChanged(() => renderLessons())

// ---- 코드 레포 (추가·삭제) ----
async function renderRepos() {
  const listEl = document.getElementById('repos-list')
  if (!listEl) return
  let repos = []
  try {
    repos = await window.watchpup.reposList()
  } catch {
    repos = []
  }
  listEl.innerHTML = ''
  if (!repos.length) {
    const empty = document.createElement('span')
    empty.className = 'status'
    empty.textContent = '등록된 레포 없음'
    listEl.appendChild(empty)
    return
  }
  for (const p of repos) {
    const row = document.createElement('div')
    row.className = 'repo-row'
    const name = document.createElement('span')
    name.className = 'repo-name'
    name.textContent = p.split('/').filter(Boolean).pop() || p
    name.title = p
    const del = document.createElement('button')
    del.type = 'button'
    del.className = 'group-del'
    del.textContent = '×'
    del.title = '제거'
    del.addEventListener('click', async () => {
      await window.watchpup.reposRemove(p)
      renderRepos()
    })
    row.append(name, del)
    listEl.appendChild(row)
  }
}
// 폴더 추가: git 레포면 바로 등록, 상위 폴더면 하위 git 레포 후보를 체크박스로 선택 등록
function hideRepoScanPanel() {
  document.getElementById('repos-scan-panel')?.classList.add('hidden')
  const listEl = document.getElementById('repos-scan-list')
  if (listEl) listEl.innerHTML = ''
}

function showRepoScanPanel(dir, candidates) {
  const panel = document.getElementById('repos-scan-panel')
  const title = document.getElementById('repos-scan-title')
  const listEl = document.getElementById('repos-scan-list')
  if (!panel || !title || !listEl) return
  listEl.innerHTML = ''
  title.textContent = `${dir} 하위에서 찾은 git 레포 ${candidates.length}개 — 추가할 레포를 선택하세요.`
  for (const candidate of candidates) {
    const row = document.createElement('label')
    row.className = 'repos-scan-row'
    const check = document.createElement('input')
    check.type = 'checkbox'
    check.value = candidate.path
    check.checked = !candidate.already
    check.disabled = candidate.already
    const name = document.createElement('span')
    name.className = 'repo-name'
    name.textContent = candidate.name + (candidate.already ? ' (등록됨)' : '')
    name.title = candidate.path
    row.append(check, name)
    listEl.appendChild(row)
  }
  panel.classList.remove('hidden')
}

document.getElementById('repos-add')?.addEventListener('click', async () => {
  const status = document.getElementById('repos-add-status')
  hideRepoScanPanel()
  if (status) status.textContent = ''
  const result = await window.watchpup.reposAdd()
  if (!result) return
  if (result.repos) {
    await renderRepos()
    if (status) status.textContent = '레포 추가됨'
    return
  }
  if (!result.candidates?.length) {
    if (status) status.textContent = '선택한 폴더와 하위에서 git 레포를 찾지 못했어요.'
    return
  }
  showRepoScanPanel(result.dir, result.candidates)
})

document.getElementById('repos-scan-add')?.addEventListener('click', async () => {
  const status = document.getElementById('repos-add-status')
  const checked = [...document.querySelectorAll('#repos-scan-list input[type="checkbox"]:checked:not(:disabled)')]
    .map((check) => check.value)
  if (!checked.length) {
    if (status) status.textContent = '선택된 레포가 없어요.'
    return
  }
  await window.watchpup.reposAddMany(checked)
  hideRepoScanPanel()
  await renderRepos()
  if (status) status.textContent = `${checked.length}개 레포 추가됨`
})

document.getElementById('repos-scan-cancel')?.addEventListener('click', () => hideRepoScanPanel())
document.getElementById('repos-gh-add')?.addEventListener('click', async () => {
  const input = document.getElementById('repos-gh-input')
  const status = document.getElementById('repos-gh-status')
  const btn = document.getElementById('repos-gh-add')
  const spec = input.value.trim()
  if (!spec) { status.textContent = 'owner/repo 또는 URL 입력'; return }
  btn.disabled = true
  status.textContent = '클론 중… (처음이면 시간이 걸려요)'
  try {
    const r = await window.watchpup.reposAddGithub(spec)
    if (r?.error) {
      status.textContent = '실패: ' + r.error
    } else {
      status.textContent = r?.action === 'updated' ? '최신화됨' : '추가됨'
      input.value = ''
      await renderRepos()
    }
  } catch (e) {
    status.textContent = '실패: ' + (e?.message || e)
  } finally {
    btn.disabled = false
  }
})

// ---- 내 유저그룹 (검색·등록·삭제) ----
async function renderGroups() {
  const listEl = document.getElementById('groups-list')
  if (!listEl) return
  let groups = []
  try {
    groups = await window.watchpup.groupsList()
  } catch {
    groups = []
  }
  listEl.innerHTML = ''
  if (!groups.length) {
    const empty = document.createElement('span')
    empty.className = 'status'
    empty.textContent = '등록된 그룹 없음'
    listEl.appendChild(empty)
    return
  }
  for (const g of groups) {
    const row = document.createElement('div')
    row.className = 'group-row'
    const name = document.createElement('span')
    name.className = 'group-handle'
    name.textContent = '@' + (g.handle || g.id)
    const del = document.createElement('button')
    del.type = 'button'
    del.className = 'group-del'
    del.textContent = '×'
    del.title = '제거'
    del.setAttribute('aria-label', '제거')
    del.addEventListener('click', async () => {
      await window.watchpup.groupsRemove(g.id)
      renderGroups()
    })
    row.append(name, del)
    listEl.appendChild(row)
  }
}
document.getElementById('groups-research')?.addEventListener('click', async () => {
  const status = document.getElementById('groups-status')
  if (status) status.textContent = '검색 중…'
  try {
    const r = await window.watchpup.groupsResearch()
    if (r && r.error) {
      if (status) status.textContent = r.error
      return
    }
    const n = (r && r.groups ? r.groups.length : 0)
    if (status) status.textContent = `${n}개 그룹 등록됨`
    await renderGroups()
  } catch (e) {
    if (status) status.textContent = '실패: ' + (e?.message || e)
  }
})

document.getElementById('cleanup-false')?.addEventListener('click', async () => {
  const status = document.getElementById('cleanup-status')
  const btn = document.getElementById('cleanup-false')
  if (!confirm('각 스레드를 재검사해 오탐 항목을 제거합니다. 진행할까요?')) return
  btn.disabled = true
  if (status) status.textContent = '검사 중… (스레드 수에 따라 시간이 걸려요)'
  try {
    const r = await window.watchpup.cleanupFalseMentions()
    if (status) status.textContent = `${r.removed}개 제거 (검사 ${r.checked}개)`
  } catch (e) {
    if (status) status.textContent = '실패: ' + (e?.message || e)
  } finally {
    btn.disabled = false
  }
})

async function refreshTokenStatus() {
  try {
    const t = await window.watchpup.tokensGet()
    const el = document.getElementById('tokens-status')
    if (el) el.textContent = `봇 ${t.bot ? '✓' : '✗'} · 앱 ${t.app ? '✓' : '✗'} · 유저 ${t.user ? '✓' : '✗'}`
    // 이미 저장된 토큰은 실제 값 대신 마스크로 "저장됨" 표시(보안상 값은 노출하지 않음)
    const SAVED = '•••••••••••• (저장됨)'
    const marks = [
      ['botToken', t.bot, 'Bot Token (xoxb-…)'],
      ['appToken', t.app, 'App Token (xapp-…)'],
      ['userToken', t.user, '변경 시에만 입력 (전 채널 검색용)'],
    ]
    for (const [name, saved, hint] of marks) {
      const input = settingsForm.elements[name]
      if (input) input.placeholder = saved ? SAVED : hint
    }
  } catch {
    /* ignore */
  }
}

settingsForm.addEventListener('submit', async (e) => {
  e.preventDefault()
  const interval = parseInt(settingsForm.elements['searchIntervalSec'].value, 10)
  const patch = {
    mySlackUserId: settingsForm.elements['mySlackUserId'].value.trim(),
    followThreads: settingsForm.elements['followThreads'].checked,
    petTheme: settingsForm.elements['petTheme'].value,
    petAlwaysOnTop: settingsForm.elements['petAlwaysOnTop'] ? settingsForm.elements['petAlwaysOnTop'].checked : true,
    petSizePercent: petSizeInput ? parseInt(petSizeInput.value, 10) : 100,
    bubbleSizePercent: bubbleSizeInput ? parseInt(bubbleSizeInput.value, 10) : 100,
    bubbleStackCount: boundedInteger(bubbleStackCountInput, 3, 1, 5),
    bubbleDurationSeconds: boundedInteger(bubbleDurationInput, 10, 3, 60),
    hudSizePercent: hudSizeInput ? parseInt(hudSizeInput.value, 10) : 100,
    hudAlignment: hudAlignmentInput?.value === 'left' ? 'left' : 'right',
    showActivityHud: showActivityHudInput ? showActivityHudInput.checked : true,
    naggingEnabled: naggingEnabledInput ? naggingEnabledInput.checked : false,
    naggingMinMinutes: naggingMinutes(naggingMinInput, 5),
    naggingMaxMinutes: Math.max(naggingMinutes(naggingMinInput, 5), naggingMinutes(naggingMaxInput, 12)),
    githubPrNaggingEnabled: githubPrNaggingEnabledInput ? githubPrNaggingEnabledInput.checked : true,
    slackNewsEnabled: slackNewsEnabledInput ? slackNewsEnabledInput.checked : false,
    slackNewsChannels: subscriptionList(slackNewsChannelsInput?.value),
    slackNewsKeywords: subscriptionList(slackNewsKeywordsInput?.value),
    buildAlertsEnabled: buildAlertsEnabledInput ? buildAlertsEnabledInput.checked : false,
    xcodeBuildAlertsEnabled: xcodeBuildAlertsEnabledInput ? xcodeBuildAlertsEnabledInput.checked : true,
    androidBuildAlertsEnabled: androidBuildAlertsEnabledInput ? androidBuildAlertsEnabledInput.checked : true,
    persona: settingsForm.elements['persona'] ? settingsForm.elements['persona'].value.trim() : '',
    bubbleStyle: settingsForm.elements['bubbleStyle'] ? settingsForm.elements['bubbleStyle'].value : 'status',
    enableBot: settingsForm.elements['enableBot'].checked,
    enableUserSearch: settingsForm.elements['enableUserSearch'].checked,
    obsidian: {
      enabled: settingsForm.elements['obsidian.enabled'].checked,
      vaultPath: settingsForm.elements['obsidian.vaultPath'].value.trim(),
      folder: settingsForm.elements['obsidian.folder'].value.trim(),
    },
  }
  if (Number.isFinite(interval) && interval >= 15) patch.searchIntervalSec = interval
  const maxAge = parseInt(settingsForm.elements['ingestMaxAgeDays'] ? settingsForm.elements['ingestMaxAgeDays'].value : '', 10)
  if (Number.isFinite(maxAge) && maxAge >= 0) patch.ingestMaxAgeDays = maxAge
  // 빈 값은 patch에서 제외 — 그대로 넣으면 config 기본값을 ''로 덮어써버린다.
  const model = settingsForm.elements['model'].value.trim()
  if (model) patch.model = model
  // Work 에이전트: 모델·레포는 '' 자체가 의미(전역/자동 따름)라 항상 포함한다.
  if (settingsForm.elements['workAgentEnabled']) {
    patch.workAgentEnabled = settingsForm.elements['workAgentEnabled'].checked
    patch.workAgentUseOrca = settingsForm.elements['workAgentUseOrca']?.checked !== false
    patch.workAgentEnglishBranch = !!settingsForm.elements['workAgentEnglishBranch']?.checked
    patch.workAgentProvider = settingsForm.elements['workAgentProvider'].value === 'codex' ? 'codex' : 'claude'
    patch.workAgentModel = settingsForm.elements['workAgentModel']?.value ?? ''
    patch.workAgentCodexModel = settingsForm.elements['workAgentCodexModel']?.value.trim() ?? ''
    const workAgentInterval = parseInt(settingsForm.elements['workAgentIntervalMinutes']?.value ?? '', 10)
    if (Number.isFinite(workAgentInterval)) patch.workAgentIntervalMinutes = Math.min(240, Math.max(5, workAgentInterval))
  }
  // 토큰: 입력된 것만 Keychain에 저장(비우면 기존 유지)
  const tokens = {}
  const bt = settingsForm.elements['botToken'].value.trim()
  const at = settingsForm.elements['appToken'].value.trim()
  const ut = settingsForm.elements['userToken'].value.trim()
  if (bt) tokens.botToken = bt
  if (at) tokens.appToken = at
  if (ut) tokens.userToken = ut
  settingsStatus.textContent = '저장 중…'
  try {
    await window.watchpup.settingsSet(patch)
    if (Object.keys(tokens).length) {
      await window.watchpup.tokensSet(tokens)
      for (const n of ['botToken', 'appToken', 'userToken']) settingsForm.elements[n].value = ''
      await refreshTokenStatus()
    }
    settingsStatus.textContent = '저장됨'
    if (confirm('변경사항을 적용하려면 재시작이 필요합니다. 지금 재시작할까요?')) {
      window.watchpup.restartApp()
    }
  } catch (err) {
    settingsStatus.textContent = '실패: ' + (err?.message || err)
  }
})

// ---- Obsidian: Vault 폴더 선택 + 상태 안내 (enabled인데 vault 없으면 동작 안 함) ----
function updateObsidianHint() {
  const hintEl = document.getElementById('obsidian-hint')
  if (!hintEl) return
  const enabled = settingsForm.elements['obsidian.enabled']?.checked
  const vault = (settingsForm.elements['obsidian.vaultPath']?.value || '').trim()
  if (enabled && !vault) {
    hintEl.textContent = '⚠️ Vault 경로가 없어 노트가 기록되지 않아요. 폴더를 선택하세요.'
    hintEl.style.color = 'var(--st-replied)'
  } else if (enabled && vault) {
    hintEl.textContent = '✓ 새 멘션·분석이 이 Vault에 노트로 저장됩니다.'
    hintEl.style.color = 'var(--st-ready)'
  } else {
    hintEl.textContent = ''
  }
}
document.getElementById('obsidian-pick')?.addEventListener('click', async () => {
  const dir = await window.watchpup.pickObsidianVault()
  if (dir) {
    settingsForm.elements['obsidian.vaultPath'].value = dir
    if (!settingsForm.elements['obsidian.enabled'].checked) settingsForm.elements['obsidian.enabled'].checked = true
    updateObsidianHint()
  }
})
settingsForm.elements['obsidian.enabled']?.addEventListener('change', updateObsidianHint)
settingsForm.elements['obsidian.vaultPath']?.addEventListener('input', updateObsidianHint)

// ---- 커스텀 펫 이미지 폴더 (즉시 적용, 재시작 불필요) ----
async function applyPetImageDir(dir) {
  await window.watchpup.settingsSet({ petImageDir: dir })
  const el = document.getElementById('petimg-path')
  if (el) el.textContent = dir || '이모지 사용 중'
}
document.getElementById('petimg-pick')?.addEventListener('click', async () => {
  const dir = await window.watchpup.pickPetImageDir()
  if (dir) await applyPetImageDir(dir)
})
document.getElementById('petimg-clear')?.addEventListener('click', () => {
  applyPetImageDir('').catch((e) => console.error(e))
})

// ---- Codex Pet 팩 (즉시 적용, 재시작 불필요) ----
function updateCodexPathLabel(name) {
  const el = document.getElementById('codexpet-path')
  if (el) el.textContent = name || '사용 안 함'
}

// Codex 스프라이트시트(1536x1872, 8열x9행, 셀 192x208)의 idle 프레임(0,0)을 아이콘으로.
const CODEX_ICON_H = 52
function codexIconStyle(el, spritesheet) {
  const cellW = 192, cellH = 208, cols = 8, rows = 9
  const scale = CODEX_ICON_H / cellH
  el.style.width = Math.round(cellW * scale) + 'px'
  el.style.height = CODEX_ICON_H + 'px'
  el.style.backgroundImage = 'url("' + spritesheet + '")'
  el.style.backgroundSize = Math.round(cols * cellW * scale) + 'px ' + Math.round(rows * cellH * scale) + 'px'
  el.style.backgroundPosition = '0 0'
  el.style.backgroundRepeat = 'no-repeat'
}

async function selectCodexPet(dir) {
  try {
    const used = dir ? await window.watchpup.codexUse(dir) : ''
    await window.watchpup.settingsSet({ petCodexDir: used || '' })
    await loadCodexPets(used || '')
  } catch (err) {
    console.error('Codex Pet 설정 실패', err)
  }
}

async function loadCodexPets(currentDir) {
  const grid = document.getElementById('codex-grid')
  if (!grid) return
  let pets = []
  try { pets = await window.watchpup.codexList() } catch { pets = [] }
  grid.innerHTML = ''

  // '사용 안 함' 카드
  const none = document.createElement('button')
  none.type = 'button'
  none.className = 'codex-card' + (!currentDir ? ' selected' : '')
  none.title = '사용 안 함'
  none.innerHTML = '<span class="codex-none">🚫</span><span class="codex-card-name">사용 안 함</span>'
  none.addEventListener('click', () => selectCodexPet(''))
  grid.appendChild(none)

  const matched = pets.find((p) => p.dir === currentDir)
  for (const p of pets) {
    const card = document.createElement('button')
    card.type = 'button'
    card.className = 'codex-card' + (p.dir === currentDir ? ' selected' : '')
    card.title = p.displayName
    const icon = document.createElement('span')
    icon.className = 'codex-icon'
    if (p.spritesheet) codexIconStyle(icon, p.spritesheet)
    else icon.textContent = '🐾'
    const name = document.createElement('span')
    name.className = 'codex-card-name'
    name.textContent = p.displayName
    card.append(icon, name)
    card.addEventListener('click', () => selectCodexPet(p.dir))
    grid.appendChild(card)
  }

  // 목록에 없는 사용자 지정 폴더도 선택 유지
  let customName = ''
  if (currentDir && !matched) {
    try { const info = await window.watchpup.petCodex(); customName = info?.displayName || '' } catch { customName = '' }
    const card = document.createElement('button')
    card.type = 'button'
    card.className = 'codex-card selected'
    const icon = document.createElement('span')
    icon.className = 'codex-icon'
    try { const info = await window.watchpup.petCodex(); if (info?.spritesheet) codexIconStyle(icon, info.spritesheet); else icon.textContent = '🐾' } catch { icon.textContent = '🐾' }
    const name = document.createElement('span')
    name.className = 'codex-card-name'
    name.textContent = customName || '(사용자 지정)'
    card.append(icon, name)
    grid.appendChild(card)
  }
  updateCodexPathLabel(matched ? matched.displayName : currentDir ? customName || '(사용자 지정)' : '')
}

document.getElementById('codexpet-pick')?.addEventListener('click', async () => {
  const dir = await window.watchpup.codexPickDir()
  if (!dir) return
  try {
    const used = (await window.watchpup.codexUse(dir)) || dir
    await window.watchpup.settingsSet({ petCodexDir: used })
    await loadCodexPets(used)
  } catch (err) {
    console.error('Codex Pet 폴더 설정 실패', err)
  }
})
document.getElementById('codexpet-site')?.addEventListener('click', () => window.watchpup.openExternal('https://codex-pets.net/'))

// ---- 워크플로우(playbook) CRUD ----

function renderPlaybooksList() {
  const listEl = document.getElementById('playbooks-list')
  if (!listEl) return
  listEl.innerHTML = ''
  for (const pb of playbooks.list) {
    const row = document.createElement('div')
    row.className = 'playbook-row'

    const info = document.createElement('div')
    info.className = 'playbook-info'
    const nameEl = document.createElement('div')
    nameEl.className = 'playbook-name'
    nameEl.textContent = pb.name
    const whenEl = document.createElement('div')
    whenEl.className = 'playbook-when'
    whenEl.textContent = pb.when
    info.append(nameEl, whenEl)

    const badge = document.createElement('span')
    badge.className = 'playbook-badge ' + (pb.write ? 'write' : 'read')
    badge.textContent = pb.write ? '쓰기' : '읽기'

    const enabledLabel = document.createElement('label')
    enabledLabel.className = 'checkbox playbook-enabled'
    const enabledCb = document.createElement('input')
    enabledCb.type = 'checkbox'
    enabledCb.checked = !!pb.enabled
    enabledCb.addEventListener('change', async () => {
      await window.watchpup.playbookUpsert({ ...pb, enabled: enabledCb.checked })
      await afterPlaybookChange()
    })
    enabledLabel.append(enabledCb, document.createTextNode('활성'))

    const editBtn = document.createElement('button')
    editBtn.type = 'button'
    editBtn.textContent = '수정'
    editBtn.addEventListener('click', () => openPlaybookModal(pb))

    const delBtn = document.createElement('button')
    delBtn.type = 'button'
    delBtn.textContent = '삭제'
    delBtn.addEventListener('click', async () => {
      if (!confirm(`'${pb.name}' 워크플로우를 삭제할까요?`)) return
      await window.watchpup.playbookDelete(pb.id)
      await afterPlaybookChange()
    })

    row.append(info, badge, enabledLabel, editBtn, delBtn)
    listEl.appendChild(row)
  }
}

// playbook 변경 후: 목록 갱신 + 현재 열려있는 멘션의 액션 버튼도 최신 상태로
async function afterPlaybookChange() {
  await loadPlaybooks()
  onPlaybooksChanged() // 열린 상세의 액션 버튼 갱신(panel이 등록)
}

// 이름에서 워크플로우 id 자동 생성(사람이 입력하지 않음). ascii 슬러그 없으면 'wf', 중복은 -2,-3…
function genPlaybookId(name) {
  const base = (name || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'wf'
  let id = base
  let n = 2
  while (playbookById(id)) id = `${base}-${n++}`
  return id
}

// 워크플로우 추가/수정 팝업. pb=null이면 추가, 객체면 수정(id 고정, 자동 생성 유지).
function openPlaybookModal(pb) {
  const editing = !!pb
  const field = (labelText, el) => {
    const l = document.createElement('label')
    l.className = 'modal-field'
    const s = document.createElement('span')
    s.textContent = labelText
    l.append(s, el)
    return l
  }
  const name = document.createElement('input')
  name.type = 'text'; name.placeholder = '워크플로우 이름'; name.value = editing ? pb.name : ''
  const when = document.createElement('input')
  when.type = 'text'; when.placeholder = '언제 쓰는지 (제안 판단 근거)'; when.value = editing ? pb.when : ''
  const steps = document.createElement('textarea')
  steps.rows = 4; steps.placeholder = 'claude에게 줄 목표/절차'; steps.value = editing ? pb.steps : ''
  const writeLabel = document.createElement('label')
  writeLabel.className = 'checkbox'
  const write = document.createElement('input')
  write.type = 'checkbox'; write.checked = editing ? !!pb.write : false
  writeLabel.append(write, document.createTextNode(' 쓰기 작업(승인 필요)'))

  const overlay = document.createElement('div')
  overlay.className = 'modal-overlay'
  const box = document.createElement('div')
  box.className = 'modal-box modal-form'
  const title = document.createElement('div')
  title.className = 'modal-title'
  title.textContent = editing ? '워크플로우 수정' : '워크플로우 추가'
  const status = document.createElement('span')
  status.className = 'reply-status'

  // Claude Skill(SKILL.md) 가져오기 — 추가 모드에서만
  let importRow = null
  if (!editing) {
    importRow = document.createElement('div')
    importRow.className = 'modal-import'
    const imp = document.createElement('button')
    imp.type = 'button'
    imp.className = 'lesson-add'
    imp.textContent = '📄 SKILL.md에서 가져오기'
    imp.addEventListener('click', async () => {
      try {
        const s = await window.watchpup.skillPick()
        if (!s) return
        if (s.name) name.value = s.name
        if (s.description) when.value = s.description
        if (s.steps) steps.value = s.steps
        status.textContent = '가져왔어요 — 확인 후 저장'
        name.focus()
      } catch (e) {
        status.textContent = '가져오기 실패: ' + (e?.message || e)
      }
    })
    importRow.appendChild(imp)
  }

  const save = document.createElement('button')
  save.type = 'button'; save.className = 'primary'; save.textContent = '저장'
  save.addEventListener('click', async () => {
    const nm = name.value.trim()
    if (!nm) { status.textContent = '이름을 입력하세요'; return }
    const id = editing ? pb.id : genPlaybookId(nm)
    const next = { id, name: nm, when: when.value.trim(), steps: steps.value.trim(), write: write.checked, enabled: editing ? pb.enabled : true }
    save.disabled = true; status.textContent = '저장 중…'
    try {
      await window.watchpup.playbookUpsert(next)
      overlay.remove()
      await afterPlaybookChange()
    } catch (err) {
      status.textContent = '실패: ' + (err?.message || err)
      save.disabled = false
    }
  })
  const cancel = document.createElement('button')
  cancel.type = 'button'; cancel.textContent = '취소'
  cancel.addEventListener('click', () => overlay.remove())
  overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove() })

  const bar = document.createElement('div')
  bar.className = 'modal-bar'
  bar.append(status, save, cancel)
  box.append(title)
  if (importRow) box.append(importRow)
  box.append(field('이름', name), field('사용 시점', when), field('단계(steps)', steps), writeLabel, bar)
  overlay.append(box)
  document.body.appendChild(overlay)
  name.focus()
}

document.getElementById('pb-add-btn')?.addEventListener('click', () => openPlaybookModal(null))


// ---- MCP 연동 (분석 도구) ----
function mcpTransportSync() {
  const t = document.getElementById('mcp-transport')?.value || 'stdio'
  document.querySelectorAll('.mcp-stdio-only').forEach((el) => el.classList.toggle('hidden', t !== 'stdio'))
  document.querySelectorAll('.mcp-url-only').forEach((el) => el.classList.toggle('hidden', t === 'stdio'))
}
document.getElementById('mcp-transport')?.addEventListener('change', mcpTransportSync)

function resetMcpForm() {
  const set = (id, v) => { const el = document.getElementById(id); if (el) el.value = v }
  set('mcp-id', ''); document.getElementById('mcp-id').disabled = false
  set('mcp-label', ''); set('mcp-command', ''); set('mcp-args', ''); set('mcp-url', ''); set('mcp-write', '')
  document.getElementById('mcp-transport').value = 'stdio'
  document.getElementById('mcp-enabled').checked = true
  document.getElementById('mcp-save-btn').textContent = '추가'
  document.getElementById('mcp-cancel-btn').classList.add('hidden')
  document.getElementById('mcp-form-status').textContent = ''
  mcpTransportSync()
}

function startEditMcp(s) {
  const set = (id, v) => { const el = document.getElementById(id); if (el) el.value = v }
  set('mcp-id', s.id); document.getElementById('mcp-id').disabled = true
  set('mcp-label', s.label || '')
  document.getElementById('mcp-transport').value = s.transport || 'stdio'
  set('mcp-command', s.command || '')
  set('mcp-args', (s.args || []).join('\n'))
  set('mcp-url', s.url || '')
  set('mcp-write', (s.writeTools || []).join(', '))
  document.getElementById('mcp-enabled').checked = s.enabled !== false
  document.getElementById('mcp-save-btn').textContent = '저장'
  document.getElementById('mcp-cancel-btn').classList.remove('hidden')
  document.getElementById('mcp-form-status').textContent = ''
  mcpTransportSync()
}

async function renderMcpList() {
  const listEl = document.getElementById('mcp-list')
  if (!listEl) return
  let servers = []
  try { servers = (await window.watchpup.mcpList()) || [] } catch (e) { /* ignore */ }
  listEl.innerHTML = ''
  if (!servers.length) {
    const p = document.createElement('p')
    p.className = 'hint'
    p.textContent = '등록된 MCP 서버가 없어요. 아래에서 추가하세요.'
    listEl.appendChild(p)
    return
  }
  for (const s of servers) {
    const row = document.createElement('div')
    row.className = 'playbook-row'
    const info = document.createElement('div')
    info.className = 'playbook-info'
    const name = document.createElement('div')
    name.className = 'playbook-name'
    name.textContent = (s.label || s.id) + (s.enabled === false ? ' (꺼짐)' : '')
    const sub = document.createElement('div')
    sub.className = 'playbook-when'
    sub.textContent = s.transport === 'stdio' ? `${s.command || ''} ${(s.args || []).join(' ')}`.trim() : (s.url || s.transport)
    info.append(name, sub)
    if ((s.writeTools || []).length) {
      const badge = document.createElement('span')
      badge.className = 'playbook-badge write'
      badge.textContent = '쓰기 ' + s.writeTools.length
      info.appendChild(badge)
    }
    const edit = document.createElement('button')
    edit.type = 'button'
    edit.className = 'card-act'
    edit.textContent = '✎'
    edit.title = '편집'
    edit.addEventListener('click', () => startEditMcp(s))
    const del = document.createElement('button')
    del.type = 'button'
    del.className = 'card-act'
    del.textContent = '✕'
    del.title = '삭제'
    del.addEventListener('click', async () => {
      if (!confirm(`MCP 서버 '${s.id}'를 삭제할까요?`)) return
      await window.watchpup.mcpRemove(s.id)
      renderMcpList()
    })
    const acts = document.createElement('span')
    acts.className = 'card-acts'
    acts.style.opacity = '1'
    acts.append(edit, del)
    row.append(info, acts)
    listEl.appendChild(row)
  }
}

// 글로벌 Claude 설정에서 MCP 가져오기 — 후보를 체크리스트로 보여주고 선택 추가
document.getElementById('mcp-import-btn')?.addEventListener('click', async () => {
  const box = document.getElementById('mcp-import-list')
  if (!box) return
  let cands = []
  try { cands = (await window.watchpup.mcpImportCandidates()) || [] } catch (e) { /* ignore */ }
  box.innerHTML = ''
  const fresh = cands.filter((c) => !c.already)
  if (!cands.length) {
    box.innerHTML = '<p class="hint">글로벌 설정(~/.claude.json)에 MCP 서버가 없어요.</p>'
    return
  }
  if (!fresh.length) {
    box.innerHTML = '<p class="hint">가져올 새 MCP가 없어요 (모두 이미 등록됨).</p>'
    return
  }
  const wrap = document.createElement('div')
  wrap.className = 'mcp-import-box'
  const checks = []
  for (const c of fresh) {
    const label = document.createElement('label')
    label.className = 'mcp-import-item'
    const cb = document.createElement('input')
    cb.type = 'checkbox'
    cb.checked = true
    const info = document.createElement('span')
    const summary = c.transport === 'stdio' ? `${c.command || ''} ${(c.args || []).join(' ')}`.trim() : (c.url || '')
    info.innerHTML = `<b>${c.id}</b> <span class="mcp-src">${c.source}</span><br><span class="mcp-sum">${summary}</span>`
    label.append(cb, info)
    wrap.appendChild(label)
    checks.push({ cb, c })
  }
  const addBtn = document.createElement('button')
  addBtn.type = 'button'
  addBtn.className = 'primary'
  addBtn.textContent = '선택한 것 추가'
  const status = document.createElement('span')
  status.className = 'status'
  addBtn.addEventListener('click', async () => {
    const picked = checks.filter((x) => x.cb.checked).map((x) => x.c)
    if (!picked.length) { status.textContent = '선택 없음'; return }
    addBtn.disabled = true
    status.textContent = '추가 중…'
    let n = 0
    for (const c of picked) {
      const { already, source, ...server } = c
      try { await window.watchpup.mcpUpsert(server); n++ } catch (e) { /* skip invalid */ }
    }
    box.innerHTML = ''
    await renderMcpList()
    status.textContent = `${n}개 추가됨`
  })
  const actions = document.createElement('div')
  actions.className = 'reply-actions'
  actions.append(addBtn, status)
  box.append(wrap, actions)
})

document.getElementById('mcp-cancel-btn')?.addEventListener('click', resetMcpForm)
document.getElementById('mcp-save-btn')?.addEventListener('click', async () => {
  const statusEl = document.getElementById('mcp-form-status')
  const id = document.getElementById('mcp-id').value.trim()
  const label = document.getElementById('mcp-label').value.trim()
  const transport = document.getElementById('mcp-transport').value
  const command = document.getElementById('mcp-command').value.trim()
  const args = document.getElementById('mcp-args').value.split(/[\n,]/).map((x) => x.trim()).filter(Boolean)
  const url = document.getElementById('mcp-url').value.trim()
  const writeTools = document.getElementById('mcp-write').value.split(',').map((x) => x.trim()).filter(Boolean)
  const enabled = document.getElementById('mcp-enabled').checked
  if (!/^[a-zA-Z0-9_]+$/.test(id)) { statusEl.textContent = 'ID는 영문·숫자·_ 만'; return }
  if (transport === 'stdio' && !command) { statusEl.textContent = 'stdio는 command 필수'; return }
  if (transport !== 'stdio' && !url) { statusEl.textContent = 'http/sse는 URL 필수'; return }
  const s = { id, label, enabled, transport, writeTools }
  if (transport === 'stdio') { s.command = command; s.args = args }
  else s.url = url
  statusEl.textContent = '저장 중…'
  try {
    await window.watchpup.mcpUpsert(s)
    resetMcpForm()
    await renderMcpList()
    statusEl.textContent = '저장됨 (다음 분석부터 적용)'
  } catch (err) {
    statusEl.textContent = '실패: ' + (err?.message || err)
  }
})

export { loadSettings, loadPlaybooks, showSset }
