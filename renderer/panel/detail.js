// 상세 레이어 — 멘션 상세(헤더·스레드·watchpup pane)와 채팅/액션 렌더 + 스트림 반영.
// panel(목록/init)과의 연결은 store.nav로만: nav.renderList 등을 호출하고,
// renderDetail/runAction은 nav에 등록해 다른 모듈이 쓴다.
import { state, nav, getChat, getActionLog } from './store.js'
import { STATUS_LABEL, CAT_LABEL, CAT_ORDER, shortText, shortRef, debugRef, fmtMsgTime, authorColor } from './format.js'
import { copyToClipboard, appendLinkified } from './richtext.js'
import { playbooks, playbookById } from './playbooks.js'
import { agentScrollTop } from './agent-scroll.js'

const detailEl = document.getElementById('detail') // #detail — 상세 렌더 대상

function renderDetail(m) {
  detailEl.innerHTML = ''

  if (!m) {
    const empty = document.createElement('div')
    empty.className = 'empty'
    empty.innerHTML = ''
    const mark = document.createElement('div')
    mark.className = 'empty-mark'
    mark.textContent = '🐾'
    const t = document.createElement('p')
    t.className = 'empty-title'
    t.textContent = '왼쪽에서 멘션을 골라보세요'
    const s = document.createElement('p')
    s.className = 'empty-sub'
    s.textContent = '새 멘션이 오면 여기에 요약·조언·할 일이 정리됩니다.'
    empty.append(mark, t, s)
    detailEl.appendChild(empty)
    return
  }

  const head = document.createElement('div')
  head.className = 'detail-head'
  const row = document.createElement('div')
  row.className = 'head-row'
  const where = document.createElement('div')
  where.className = 'where'
  const chBold = document.createElement('b')
  chBold.textContent = m.channelName || m.channel
  where.append(chBold)
  if (m.authorName || m.authorId) where.append(document.createTextNode(' · ' + (m.authorName || m.authorId)))
  const pill = document.createElement('span')
  pill.className = 'status-pill ' + m.status
  pill.textContent = STATUS_LABEL[m.status] || m.status
  const dref = document.createElement('button')
  dref.type = 'button'
  dref.className = 'mref detail-ref'
  dref.textContent = '#' + shortRef(m.id)
  dref.title = '디버그 참조 — 클릭해서 복사(id·채널·ts)'
  dref.addEventListener('click', () => {
    copyToClipboard(debugRef(m))
    const prev = dref.textContent
    dref.textContent = '복사됨'
    dref.classList.add('copied')
    setTimeout(() => {
      dref.textContent = prev
      dref.classList.remove('copied')
    }, 1000)
  })
  const reBtn = document.createElement('button')
  reBtn.type = 'button'
  reBtn.className = 'reanalyze-btn'
  reBtn.textContent = '↻ 다시 분석'
  reBtn.title = '최신 프롬프트·교훈을 반영해 이 스레드를 다시 분석'
  reBtn.disabled = m.status === 'analyzing'
  reBtn.addEventListener('click', () => {
    reBtn.disabled = true
    reBtn.textContent = '분석 중…'
    window.watchpup.reanalyze(m.id).catch((e) => console.error('reanalyze 실패', e))
  })
  const rightWrap = document.createElement('div')
  rightWrap.className = 'head-right'
  rightWrap.append(reBtn, dref, pill)
  row.append(where, rightWrap)
  head.append(row)

  // 카테고리 선택(수동 이동/수정)
  const catRow = document.createElement('div')
  catRow.className = 'cat-row'
  const catLabel = document.createElement('span')
  catLabel.className = 'cat-row-label'
  catLabel.textContent = '성격'
  const catSel = document.createElement('select')
  catSel.className = 'cat-select'
  const optNone = document.createElement('option')
  optNone.value = ''
  optNone.textContent = '미분류'
  catSel.appendChild(optNone)
  for (const key of CAT_ORDER) {
    const o = document.createElement('option')
    o.value = key
    o.textContent = CAT_LABEL[key]
    catSel.appendChild(o)
  }
  catSel.value = (m.analysis && m.analysis.category) || ''
  catSel.addEventListener('change', () => {
    if (m.analysis) m.analysis.category = catSel.value || undefined
    window.watchpup.setCategory(m.id, catSel.value).catch((e) => console.error('setCategory 실패', e))
  })
  catRow.append(catLabel, catSel)
  head.append(catRow)

  const readState = document.createElement('div')
  readState.className = 'read-state'
  if (m.readAt) {
    const d = new Date(m.readAt)
    const isToday = d.toDateString() === new Date().toDateString()
    const timeStr = isToday
      ? d.toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' })
      : d.toLocaleString('ko-KR')
    readState.textContent = `확인함 · ${timeStr}`
  } else {
    readState.textContent = '안 읽음'
  }
  head.append(readState)
  const linkRow = document.createElement('div')
  linkRow.className = 'permalink-row'
  if (m.permalink) {
    const link = document.createElement('a')
    link.className = 'permalink'
    link.href = '#'
    link.textContent = '↗ Slack에서 열기'
    link.addEventListener('click', (e) => {
      e.preventDefault()
      window.watchpup.openExternal(m.permalink)
    })
    linkRow.append(link)
  }
  const copyMsgBtn = document.createElement('a')
  copyMsgBtn.className = 'permalink'
  copyMsgBtn.href = '#'
  copyMsgBtn.textContent = '링크 복사하기'
  if (!m.permalink) copyMsgBtn.classList.add('disabled')
  copyMsgBtn.addEventListener('click', async (e) => {
    e.preventDefault()
    if (!m.permalink) return
    await copyToClipboard(m.permalink)
    const original = copyMsgBtn.textContent
    copyMsgBtn.textContent = '복사됨'
    setTimeout(() => {
      if (copyMsgBtn.textContent === '복사됨') copyMsgBtn.textContent = original
    }, 1500)
  })
  linkRow.append(copyMsgBtn)
  head.append(linkRow)
  detailEl.appendChild(head)

  // 미리알림 컨트롤 — analysis 유무와 무관하게 항상 표시(헤더와 2-pane 사이, full-width)
  detailEl.appendChild(renderReminderSection(m))

  // 두 개의 패널: 좌측 = 슬랙식 스레드 대화, 우측 = watchpup 코파일럿(요약/조언/할일/답장/액션/대화)
  const panes = document.createElement('div')
  panes.className = 'detail-2pane'
  const left = renderThreadPane(m)
  const right = renderWatchpupPane(m)
  const divider = document.createElement('div')
  divider.className = 'pane-divider'
  divider.title = '드래그해서 좌우 비율 조절'
  panes.append(left, divider, right)
  detailEl.appendChild(panes)
  attachSplitter(panes, left, right, divider)
}

// "미리알림으로 저장하기" 섹션 — 헤더에 있던 미리알림 관련 컨트롤을 모아 하나의 섹션으로 분리.
// 버튼/핸들러는 기존과 동일(위치만 이동): 빠른 추가(mentionToWork) / 프롬프트로 생성(mentionToWorkAI,
// aiPromptRow 인라인 토글) / TODO로 이동(mentionReminderLink→openWorkItem) + 마감일(선택) 입력.
function renderReminderSection(m) {
  const wrap = document.createElement('div')
  wrap.className = 'section reminder-section'
  const h = document.createElement('h3')
  h.textContent = '미리알림으로 저장하기'
  wrap.appendChild(h)

  const body = document.createElement('div')
  body.className = 'reminder-body'

  const dueRow = document.createElement('div')
  dueRow.className = 'reminder-due-row'
  const dueLabel = document.createElement('label')
  dueLabel.className = 'reminder-due-label'
  dueLabel.textContent = '마감일(선택)'
  const dueInput = document.createElement('input')
  dueInput.type = 'datetime-local'
  dueInput.className = 'due-input'
  dueInput.title = '마감일(선택) — 비우면 마감일 없이 추가/업데이트'
  function dueInputValue() {
    if (!dueInput.value) return undefined
    const ms = new Date(dueInput.value).getTime()
    return Number.isFinite(ms) ? ms : undefined
  }
  dueLabel.appendChild(dueInput)
  dueRow.append(dueLabel)

  const btnRow = document.createElement('div')
  btnRow.className = 'reminder-btn-row'

  const workBtn = document.createElement('button')
  workBtn.type = 'button'
  workBtn.className = 'reanalyze-btn'
  workBtn.textContent = '＋ 빠른 추가'
  workBtn.title = '고정 템플릿으로 이 멘션을 선택된 미리 알림 목록에 추가'
  workBtn.addEventListener('click', async () => {
    const original = workBtn.textContent
    workBtn.disabled = true
    workBtn.textContent = '추가 중…'
    try {
      const result = await window.watchpup.mentionToWork(m.id, dueInputValue())
      workBtn.textContent = result && result.ok === false && result.reason === 'no-list'
        ? '목록을 먼저 선택하세요'
        : (result && result.updated ? '업데이트됨' : '추가됨')
    } catch (e) {
      console.error('mentionToWork 실패', e)
      workBtn.textContent = '실패: ' + (e?.message || e)
    } finally {
      setTimeout(() => {
        workBtn.textContent = original
        workBtn.disabled = false
      }, 1500)
    }
  })

  // 스레드 내용을 LLM으로 요약해 미리알림 초안 생성. 추가 지시는 선택 입력.
  const aiBtn = document.createElement('button')
  aiBtn.type = 'button'
  aiBtn.className = 'reanalyze-btn'
  aiBtn.textContent = '✨ 프롬프트로 생성'
  aiBtn.title = '스레드 내용을 바탕으로 AI가 미리알림 초안을 생성'

  const aiPromptRow = document.createElement('div')
  aiPromptRow.className = 'ai-reminder-row hidden'
  const aiExtra = document.createElement('textarea')
  aiExtra.className = 'dev-extra'
  aiExtra.rows = 2
  aiExtra.placeholder = '추가 지시(선택): 미리알림 구조를 어떻게 조정할지'
  const aiGenBtn = document.createElement('button')
  aiGenBtn.type = 'button'
  aiGenBtn.className = 'reanalyze-btn primary'
  aiGenBtn.textContent = '생성'
  const aiStatus = document.createElement('span')
  aiStatus.className = 'reply-status'
  aiPromptRow.append(aiExtra, aiGenBtn, aiStatus)

  aiBtn.addEventListener('click', () => {
    aiPromptRow.classList.toggle('hidden')
  })
  aiGenBtn.addEventListener('click', async () => {
    if (aiGenBtn.disabled) return
    const original = aiGenBtn.textContent
    aiGenBtn.disabled = true
    aiGenBtn.textContent = '생성 중…'
    aiStatus.textContent = ''
    try {
      const result = await window.watchpup.mentionToWorkAI(m.id, aiExtra.value.trim(), dueInputValue())
      if (result && result.ok === false && result.reason === 'no-list') {
        aiStatus.textContent = '목록을 먼저 선택하세요'
      } else {
        aiStatus.textContent = result && result.updated ? '업데이트됨' : '추가됨'
        aiPromptRow.classList.add('hidden')
      }
    } catch (e) {
      console.error('mentionToWorkAI 실패', e)
      aiStatus.textContent = '실패: ' + (e?.message || e)
    } finally {
      aiGenBtn.disabled = false
      aiGenBtn.textContent = original
    }
  })

  // 이 스레드에 이미 매핑된 Reminder가 있으면(=중복 추가된 게 아니라 기존에 연결된 TODO가
  // 있으면) 이동 버튼을 보여준다. 조회는 비동기라 우선 숨겨두고 결과가 오면 채운다.
  const goToWorkBtn = document.createElement('button')
  goToWorkBtn.type = 'button'
  goToWorkBtn.className = 'reanalyze-btn hidden'
  goToWorkBtn.textContent = '↪ TODO로 이동'
  goToWorkBtn.title = '이 스레드에 연결된 미리 알림으로 이동'
  window.watchpup.mentionReminderLink(m.id).then((reminderId) => {
    if (!reminderId || state.current !== m.id) return
    goToWorkBtn.classList.remove('hidden')
    goToWorkBtn.addEventListener('click', () => window.watchpup.openWorkItem(reminderId))
  }).catch((e) => console.error('mentionReminderLink 실패', e))

  btnRow.append(workBtn, aiBtn, goToWorkBtn)
  body.append(btnRow, dueRow, aiPromptRow)
  wrap.append(body)
  return wrap
}

function renderActivityDetail(activity, targetEl = detailEl) {
  const previousBody = targetEl.querySelector('.agent-session-body')
  const previousScroll = previousBody
    ? {
        sameActivity: targetEl.dataset.activityId === activity.id,
        previousTop: previousBody.scrollTop,
        previousHeight: previousBody.scrollHeight,
        previousClientHeight: previousBody.clientHeight,
      }
    : {
        sameActivity: false,
        previousTop: 0,
        previousHeight: 0,
        previousClientHeight: 0,
      }
  targetEl.replaceChildren()
  targetEl.dataset.activityId = activity.id
  const sourceName = activity.source === 'claude' ? 'Claude' : 'Codex'
  const stateLabels = { running: '진행 중', done: '완료', waiting: '대기', error: '오류' }

  const head = document.createElement('div')
  head.className = 'detail-head agent-detail-head'
  const row = document.createElement('div')
  row.className = 'head-row'
  const where = document.createElement('div')
  where.className = 'where'
  const source = document.createElement('b')
  source.textContent = `${sourceName} 로컬 세션`
  where.append(source)
  const right = document.createElement('div')
  right.className = 'head-right'
  const open = document.createElement('button')
  open.type = 'button'
  open.className = 'reanalyze-btn'
  open.textContent = `↗ ${sourceName}에서 열기`
  open.disabled = activity.canOpen === false
  open.addEventListener('click', () => window.watchpup.openActivity(activity.id))
  const pill = document.createElement('span')
  pill.className = `status-pill ${activity.state || 'waiting'}`
  pill.textContent = stateLabels[activity.state] || activity.state || '대기'
  right.append(open, pill)
  row.append(where, right)
  head.append(row)

  const meta = document.createElement('div')
  meta.className = 'agent-session-meta'
  const updated = Number(activity.updatedAt)
  const parts = [Number.isFinite(updated) ? `최근 갱신 ${new Date(updated).toLocaleString('ko-KR')}` : '']
  if (Number.isFinite(activity.contextPercent)) parts.push(`컨텍스트 ${Math.round(activity.contextPercent)}%`)
  parts.push(`세션 ${activity.sessionId || ''}`)
  meta.textContent = parts.filter(Boolean).join(' · ')
  head.append(meta)
  targetEl.append(head)

  const body = document.createElement('div')
  body.className = 'agent-session-body'
  const title = document.createElement('h1')
  title.className = 'agent-session-title'
  title.textContent = activity.title || `${sourceName} 세션`
  body.append(title)

  const messages = Array.isArray(activity.messages) ? activity.messages : []
  if (messages.length) {
    const label = document.createElement('div')
    label.className = 'agent-session-section-title'
    label.textContent = `최근 대화 ${messages.length}개`
    body.append(label)
    const transcript = document.createElement('div')
    transcript.className = 'agent-session-transcript'
    for (const message of messages) {
      if (!message || typeof message.text !== 'string' || !message.text) continue
      const card = document.createElement('article')
      card.className = `agent-session-message ${message.role === 'user' ? 'user' : 'assistant'}`
      const messageHead = document.createElement('div')
      messageHead.className = 'agent-session-message-head'
      const role = document.createElement('b')
      role.textContent = message.role === 'user' ? '사용자' : sourceName
      const at = document.createElement('span')
      at.textContent = Number.isFinite(message.at)
        ? new Date(message.at).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' })
        : ''
      messageHead.append(role, at)
      const content = document.createElement('pre')
      content.textContent = message.text
      card.append(messageHead, content)
      transcript.append(card)
    }
    body.append(transcript)
  } else {
    const summary = document.createElement('pre')
    summary.className = 'agent-session-summary'
    summary.textContent = activity.detail || '아직 표시할 대화 내용이 없습니다.'
    body.append(summary)
  }
  targetEl.append(body)
  const restoreScroll = () => {
    body.scrollTop = agentScrollTop({
      ...previousScroll,
      nextHeight: body.scrollHeight,
    })
  }
  restoreScroll()
  requestAnimationFrame(restoreScroll)
}

// 좌우 비율(스레드:watchpup) 저장·복원 + 드래그 리사이즈
const SPLIT_KEY = 'watchpup.splitRatio'
function getSplitRatio() {
  const v = parseFloat(localStorage.getItem(SPLIT_KEY) || '')
  return Number.isFinite(v) && v >= 0.25 && v <= 0.75 ? v : 0.56
}
function applySplit(container, ratio) {
  container.style.setProperty('--split-l', String(ratio))
  container.style.setProperty('--split-r', String(1 - ratio))
}
function attachSplitter(container, left, right, divider) {
  applySplit(container, getSplitRatio())
  let dragging = false
  const onMove = (e) => {
    if (!dragging) return
    const rect = container.getBoundingClientRect()
    let ratio = (e.clientX - rect.left) / rect.width
    ratio = Math.max(0.25, Math.min(0.75, ratio))
    applySplit(container, ratio)
    localStorage.setItem(SPLIT_KEY, String(ratio))
  }
  const stop = () => {
    dragging = false
    document.body.classList.remove('col-resizing')
    window.removeEventListener('mousemove', onMove)
    window.removeEventListener('mouseup', stop)
  }
  divider.addEventListener('mousedown', (e) => {
    e.preventDefault()
    dragging = true
    document.body.classList.add('col-resizing')
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', stop)
  })
}

// 스레드 메시지 시간: 오늘이면 시각만, 아니면 날짜+시각. ts는 epoch 초(.마이크로) 문자열.

// 발화자별 색(이름 해시 → 팔레트, Tableau10 계열 — 무난·조화).

// 평문에서 URL(클릭) · @멘션 · #채널을 색으로 강조. 안전: 노드 조립(innerHTML 미사용).

const REACTION_CHOICES = [
  ['eyes', '👀'],
  ['white_check_mark', '✅'],
  ['+1', '👍'],
  ['heart', '❤️'],
  ['pray', '🙏'],
  ['tada', '🎉'],
]
const REACTION_EMOJI = new Map(REACTION_CHOICES)

function reactionLabel(name) {
  return REACTION_EMOJI.get(name) || `:${name}:`
}

async function changeReaction(mention, msg, name, active, button, errorEl) {
  if (!msg.ts || button.disabled) return
  button.disabled = true
  errorEl.textContent = ''
  try {
    const result = await window.watchpup.reactionSet(mention.id, msg.ts, name, active)
    if (Array.isArray(result?.thread)) mention.thread = result.thread
    if (state.current === mention.id) renderDetail(mention)
  } catch (error) {
    console.error('reactionSet 실패', error)
    button.disabled = false
    errorEl.textContent = '리액션 권한을 확인해 주세요'
  }
}

function renderReactions(mention, msg) {
  if (!msg.ts) return null
  const wrap = document.createElement('div')
  wrap.className = 'treactions'
  const error = document.createElement('span')
  error.className = 'treaction-error'

  for (const reaction of msg.reactions || []) {
    const button = document.createElement('button')
    button.type = 'button'
    button.className = 'treaction' + (reaction.reacted ? ' active' : '')
    button.textContent = `${reactionLabel(reaction.name)} ${reaction.count}`
    button.title = reaction.reacted ? '내 리액션 취소' : '리액션 추가'
    button.addEventListener('click', () => {
      changeReaction(mention, msg, reaction.name, !reaction.reacted, button, error)
    })
    wrap.appendChild(button)
  }

  const add = document.createElement('details')
  add.className = 'treaction-add'
  const summary = document.createElement('summary')
  summary.textContent = '+'
  summary.title = '리액션 추가'
  const picker = document.createElement('div')
  picker.className = 'treaction-picker'
  for (const [name, emoji] of REACTION_CHOICES) {
    const button = document.createElement('button')
    button.type = 'button'
    button.textContent = emoji
    button.title = `:${name}:`
    button.addEventListener('click', () => {
      add.open = false
      changeReaction(mention, msg, name, true, button, error)
    })
    picker.appendChild(button)
  }
  add.append(summary, picker)
  wrap.append(add, error)
  return wrap
}

function renderThreadPane(m) {
  const pane = document.createElement('div')
  pane.className = 'thread-pane'
  const thread = m.thread || []
  if (!thread.length) {
    const empty = document.createElement('p')
    empty.className = 'thread-empty'
    empty.textContent = '스레드 불러오는 중…'
    pane.appendChild(empty)
    // 예전 멘션은 thread가 저장돼있지 않을 수 있음 → 즉석 조회 후 다시 렌더
    window.watchpup
      .threadGet(m.id)
      .then((msgs) => {
        if (Array.isArray(msgs) && msgs.length) {
          m.thread = msgs
          if (state.current === m.id) renderDetail(m)
        } else {
          empty.textContent = '(스레드 내용을 불러오지 못했어요)'
        }
      })
      .catch(() => {
        empty.textContent = '(스레드 내용을 불러오지 못했어요)'
      })
    return pane
  }
  // 저장된 과거 스레드도 상세 화면을 처음 열 때 한 번 갱신해 리액션을 채운다.
  if (!m.reactionsLoaded) {
    m.reactionsLoaded = true
    window.watchpup
      .threadGet(m.id, true)
      .then((msgs) => {
        if (Array.isArray(msgs)) m.thread = msgs
        if (state.current === m.id) renderDetail(m)
      })
      .catch((error) => console.error('리액션 포함 스레드 새로고침 실패', error))
  }
  for (const msg of thread) {
    const row = document.createElement('div')
    row.className = 'tmsg' + (msg.mine ? ' mine' : '')
    const col = msg.mine ? '' : authorColor(msg.author || '')
    const author = document.createElement('div')
    author.className = 'tauthor'
    const name = document.createElement('span')
    name.className = 'tauthor-name'
    name.textContent = msg.author || ''
    if (col) name.style.color = col
    author.appendChild(name)
    const when = fmtMsgTime(msg.ts)
    if (when) {
      const t = document.createElement('span')
      t.className = 'tauthor-time'
      t.textContent = when
      author.appendChild(t)
    }
    const text = document.createElement('div')
    text.className = 'ttext'
    if (col) text.style.borderLeftColor = col
    appendLinkified(text, msg.text || '')
    row.append(author, text)
    const reactions = renderReactions(m, msg)
    if (reactions) row.appendChild(reactions)
    pane.appendChild(row)
  }
  // 새 창/재렌더 시 가장 최근 메시지(맨 아래)로 스크롤
  requestAnimationFrame(() => {
    pane.scrollTop = pane.scrollHeight
  })
  return pane
}

function renderWatchpupPane(m) {
  const pane = document.createElement('div')
  pane.className = 'watchpup-pane'

  const analysis = m.analysis
  if (!analysis) {
    const analyzing = document.createElement('p')
    analyzing.className = 'empty'
    analyzing.textContent = '분석 중…'
    pane.appendChild(analyzing)
  } else {
    const routing = renderRouting(analysis)
    if (routing) pane.appendChild(routing)
    pane.appendChild(section('요약', analysis.summary))
    pane.appendChild(section('조언', analysis.advice))
    pane.appendChild(renderTodos(m))
    pane.appendChild(renderDraftReply(m))
    // 워크플로우 직접 실행(다른 워크플로우·개발→PR)은 접이식으로 — 기본 화면은 깔끔하게
    const tools = document.createElement('details')
    tools.className = 'tools'
    const sum = document.createElement('summary')
    sum.textContent = '🛠 워크플로우 실행'
    tools.appendChild(sum)
    tools.appendChild(renderRunOther(m))
    pane.appendChild(tools)
    // 평가 & 개선(만족도 별점 + 개선점 → 학습)을 하나로
    pane.appendChild(renderReview(m))
  }

  pane.appendChild(renderChat(m))
  return pane
}

// 평가 & 개선 — 만족도 별점(빠른 신호) + 개선점 서술(즉시 재분석). 둘 다 학습에 사용.
function renderReview(m) {
  const wrap = document.createElement('details')
  wrap.className = 'tools review'
  const sum = document.createElement('summary')
  sum.textContent = '⭐ 평가 & 개선'
  wrap.appendChild(sum)

  // 1) 만족도 별점
  const rating = document.createElement('div')
  rating.className = 'rating'
  const rlabel = document.createElement('span')
  rlabel.className = 'rating-label'
  rlabel.textContent = '만족도'
  const stars = document.createElement('div')
  stars.className = 'rating-stars'
  const rstatus = document.createElement('span')
  rstatus.className = 'rating-status'
  const paint = (val) => { ;[...stars.children].forEach((b, i) => b.classList.toggle('on', i < val)) }
  for (let i = 1; i <= 5; i++) {
    const b = document.createElement('button')
    b.type = 'button'
    b.className = 'star'
    b.textContent = '★'
    b.title = `${i}점`
    b.addEventListener('mouseenter', () => paint(i))
    b.addEventListener('mouseleave', () => paint(m.rating || 0))
    b.addEventListener('click', () => {
      m.rating = i
      paint(i)
      rstatus.textContent = i <= 2 ? '개선점을 배울게요' : '고마워요!'
      window.watchpup.rate(m.id, i).catch((e) => console.error('rate 실패', e))
    })
    stars.appendChild(b)
  }
  paint(m.rating || 0)
  if (m.rating) rstatus.textContent = '평가함'
  rating.append(rlabel, stars, rstatus)

  // 2) 개선점 서술 → 교훈 + 즉시 재분석
  const hint = document.createElement('p')
  hint.className = 'hint'
  hint.textContent = '고쳤으면 하는 점을 남기면 교훈으로 배워 다음부터 반영하고, 지금 다시 분석해요.'
  const ta = document.createElement('textarea')
  ta.className = 'dev-extra'
  ta.rows = 2
  ta.placeholder = '예: 요약이 너무 길어요 / 버그면 코드 워크플로우를 제안해줘 / 답장은 더 정중하게'
  const btn = document.createElement('button')
  btn.type = 'button'
  btn.className = 'primary'
  btn.textContent = '반영하고 다시 분석'
  const status = document.createElement('span')
  status.className = 'reply-status'
  btn.addEventListener('click', async () => {
    const text = ta.value.trim()
    if (!text) { status.textContent = '내용을 입력하세요'; return }
    btn.disabled = true
    status.textContent = '반영 중… 다시 분석할게요'
    try {
      const r = await window.watchpup.sendFeedback(m.id, text)
      status.textContent = r && r.lesson ? '배웠어요: ' + r.lesson : '반영했어요'
      ta.value = ''
    } catch (e) {
      status.textContent = '실패: ' + (e?.message || e)
    } finally { btn.disabled = false }
  })
  const actions = document.createElement('div')
  actions.className = 'reply-actions'
  actions.append(btn, status)

  // 만족도(별점)와 개선점(서술)을 두 블록으로 분리 → 블록 사이는 넉넉히, 블록 안은 촘촘히
  const feedback = document.createElement('div')
  feedback.className = 'review-feedback'
  feedback.append(hint, ta, actions)

  wrap.append(rating, feedback)
  return wrap
}

// 라우팅: 이 멘션을 watchpup가 어떤 워크플로우로 파악했는지 + 실제 조사한 소스(코드/노션/웹 등)
function renderRouting(analysis) {
  const actions = analysis.actions || []
  const sources = analysis.sources || []
  if (!actions.length && !sources.length) return null
  const wrap = document.createElement('div')
  wrap.className = 'routing'

  if (actions.length) {
    const row = document.createElement('div')
    row.className = 'route-row'
    const lab = document.createElement('span')
    lab.className = 'route-label'
    lab.textContent = actions.length > 1 ? `워크플로우 ${actions.length}` : '워크플로우'
    row.appendChild(lab)
    for (const a of actions) {
      const chip = document.createElement('span')
      chip.className = 'route-chip'
      chip.textContent = a.label
      row.appendChild(chip)
    }
    wrap.appendChild(row)
  }
  if (sources.length) {
    const row = document.createElement('div')
    row.className = 'route-row'
    const lab = document.createElement('span')
    lab.className = 'route-label'
    lab.textContent = '조사'
    row.appendChild(lab)
    for (const s of sources) {
      const tag = document.createElement('span')
      tag.className = 'route-src'
      tag.textContent = s
      row.appendChild(tag)
    }
    wrap.appendChild(row)
  }
  return wrap
}

// '개발 → PR' 전용 레포 선택 패널. 드롭다운에서 이 항목을 골랐을 때만 펼쳐진다.
// (추가 지시 입력은 모든 워크플로우 공통이라 renderRunOther가 따로 둔다.)
function buildRepoPicker() {
  const el = document.createElement('div')
  el.className = 'dev-panel hidden'
  const list = document.createElement('div')
  list.className = 'dev-repos'
  const checks = []
  window.watchpup.reposList().then((repos) => {
    if (!(repos || []).length) {
      list.innerHTML = '<p class="hint">설정 → 저장소에서 레포를 먼저 추가하세요.</p>'
      return
    }
    for (const p of repos) {
      const label = document.createElement('label')
      label.className = 'dev-repo-item'
      const cb = document.createElement('input')
      cb.type = 'checkbox'
      cb.value = p
      const span = document.createElement('span')
      span.textContent = p.split('/').filter(Boolean).pop() || p
      label.append(cb, span)
      list.appendChild(label)
      checks.push(cb)
    }
    if (repos.length === 1) checks[0].checked = true
  })
  el.append(list)
  return { el, getRepos: () => checks.filter((c) => c.checked).map((c) => c.value) }
}

function section(label, text) {
  const wrap = document.createElement('div')
  wrap.className = 'section'
  const h = document.createElement('h3')
  h.textContent = label
  const body = document.createElement('div')
  body.className = 'body'
  appendLinkified(body, text || '') // 요약·조언 속 URL도 클릭 가능
  wrap.append(h, body)
  return wrap
}

function renderTodos(m) {
  const wrap = document.createElement('div')
  wrap.className = 'section'
  const h = document.createElement('h3')
  const n = (m.todos || []).length
  h.textContent = n ? `할 일 ${n}` : '할 일'
  wrap.appendChild(h)

  const running = state.runningActions.has(m.id)
  const coveredPb = new Set()

  const ul = document.createElement('ul')
  ul.id = 'todos'
  ;(m.todos || []).forEach((todo, i) => {
    const li = document.createElement('li')
    if (todo.done) li.classList.add('done')
    const checkbox = document.createElement('input')
    checkbox.type = 'checkbox'
    checkbox.checked = !!todo.done
    checkbox.addEventListener('change', () => {
      todo.done = checkbox.checked
      li.classList.toggle('done', todo.done)
      window.watchpup.todoToggle(m.id, i).catch((e) => console.error('todoToggle 실패', e))
      nav.renderList() // 카드의 "할 일 남음/완료" 배지 즉시 갱신
    })
    const span = document.createElement('span')
    span.className = 'todo-text'
    span.textContent = todo.text
    li.append(checkbox, span)
    // 자동 수행 가능한 할 일이면 "실행" 버튼(해당 playbook이 활성일 때만)
    const pb = todo.playbookId ? playbookById(todo.playbookId) : null
    if (pb && pb.enabled) {
      coveredPb.add(pb.id)
      const run = document.createElement('button')
      run.type = 'button'
      run.className = 'todo-run'
      run.textContent = `▶ ${pb.name}`
      run.title = `watchpup가 대신 실행: ${pb.name}`
      run.disabled = running
      run.addEventListener('click', (e) => {
        e.stopPropagation()
        runAction(m.id, todo.playbookId)
      })
      li.appendChild(run)
    }
    ul.appendChild(li)
  })
  wrap.appendChild(ul)

  // 제안 행동(actions) 중 위 할 일로 아직 안 걸린 것 → 여기 ▶ 액션 칩으로 통합 노출
  const suggested = ((m.analysis && m.analysis.actions) || []).filter((a) => {
    const pb = playbookById(a.playbookId)
    return pb && pb.enabled && !coveredPb.has(a.playbookId)
  })
  if (suggested.length) {
    const acts = document.createElement('div')
    acts.className = 'todo-actions'
    for (const act of suggested) {
      const btn = document.createElement('button')
      btn.type = 'button'
      btn.className = 'todo-run standalone'
      btn.textContent = `▶ ${act.label}`
      btn.disabled = running
      btn.addEventListener('click', () => runAction(m.id, act.playbookId))
      acts.appendChild(btn)
    }
    wrap.appendChild(acts)
  }

  // 실행 로그(트랜스크립트) — 액션 진행/결과가 여기 표시
  const log = document.createElement('div')
  log.id = 'action-log'
  wrap.appendChild(log)
  const alog = getActionLog(m.id)
  for (const entry of alog.entries) {
    const el = appendActionEntry(log, entry)
    if (!entry.done) state.actionEls.set(m.id, el)
  }

  return wrap
}

function renderDraftReply(m) {
  const wrap = document.createElement('div')
  wrap.className = 'section'
  const h = document.createElement('h3')
  h.textContent = '답장 초안'
  const textarea = document.createElement('textarea')
  textarea.id = 'draft-reply'
  textarea.readOnly = true
  textarea.value = m.analysis?.draftReply || ''

  // 원클릭 리라이트 (승인 전 톤 조정)
  const rewriteRow = document.createElement('div')
  rewriteRow.className = 'rewrite-row'
  const REWRITES = [
    ['polite', '정중하게'],
    ['short', '짧게'],
    ['soft', '부드럽게'],
    ['english', '영어로'],
  ]
  const rewriteBtns = []
  for (const [style, label] of REWRITES) {
    const b = document.createElement('button')
    b.type = 'button'
    b.className = 'rewrite-btn'
    b.textContent = label
    b.disabled = !m.analysis?.draftReply
    b.addEventListener('click', async () => {
      rewriteBtns.forEach((x) => (x.disabled = true))
      status.textContent = '다듬는 중…'
      try {
        const r = await window.watchpup.replyRewrite(m.id, style)
        if (r && r.text) {
          textarea.value = r.text
          if (m.analysis) m.analysis.draftReply = r.text
          status.textContent = '다듬음'
        } else {
          status.textContent = '실패'
        }
      } catch (e) {
        status.textContent = '실패: ' + (e?.message || e)
      } finally {
        rewriteBtns.forEach((x) => (x.disabled = false))
      }
    })
    rewriteBtns.push(b)
    rewriteRow.appendChild(b)
  }

  const actions = document.createElement('div')
  actions.className = 'reply-actions'
  const approveBtn = document.createElement('button')
  approveBtn.className = 'primary'
  approveBtn.textContent = '승인'
  approveBtn.disabled = !m.analysis?.draftReply || m.status === 'replied'
  const copyBtn = document.createElement('button')
  copyBtn.textContent = '복사'
  copyBtn.disabled = !m.analysis?.draftReply
  const status = document.createElement('span')
  status.className = 'reply-status'
  if (m.status === 'replied') status.textContent = '답장 완료'

  approveBtn.addEventListener('click', async () => {
    approveBtn.disabled = true
    status.textContent = '전송 중…'
    try {
      await window.watchpup.replyApprove(m.id)
      m.status = 'replied'
      status.textContent = '답장 완료'
      nav.renderList()
    } catch (e) {
      status.textContent = '실패: ' + (e?.message || e)
      approveBtn.disabled = false
    }
  })
  copyBtn.addEventListener('click', async () => {
    await window.watchpup.replyCopy(m.id)
    status.textContent = '복사됨'
    setTimeout(() => {
      if (status.textContent === '복사됨') status.textContent = ''
    }, 1500)
  })

  actions.append(approveBtn, copyBtn, status)
  wrap.append(h, textarea, rewriteRow, actions)
  return wrap
}

// 워크플로우를 직접 골라 실행. 등록된 playbook + 특수 빌트인 '개발 → PR'(레포 선택 필요)을
// 한 드롭다운에서 고른다. '개발 → PR' 선택 시에만 레포 선택 패널이 펼쳐지고 버튼이 바뀐다.
const DEV_PR = '__dev_pr__'
function renderRunOther(m) {
  const wrap = document.createElement('div')
  wrap.className = 'section'
  const enabled = playbooks.list.filter((p) => p.enabled)
  const running = state.runningActions.has(m.id)

  const moreWrap = document.createElement('div')
  moreWrap.className = 'action-more'
  const select = document.createElement('select')
  for (const pb of enabled) {
    const opt = document.createElement('option')
    opt.value = pb.id
    opt.textContent = pb.name
    select.appendChild(opt)
  }
  const devOpt = document.createElement('option')
  devOpt.value = DEV_PR
  devOpt.textContent = '개발 → PR (Draft)'
  select.appendChild(devOpt)

  const runBtn = document.createElement('button')
  runBtn.type = 'button'
  runBtn.textContent = '＋ 실행'
  runBtn.disabled = running
  moreWrap.append(select, runBtn)

  const dev = buildRepoPicker()
  // 추가 지시(선택) — 모든 워크플로우 공통
  const extra = document.createElement('textarea')
  extra.className = 'dev-extra'
  extra.rows = 2
  const status = document.createElement('span')
  status.className = 'reply-status'
  const statusRow = document.createElement('div')
  statusRow.className = 'reply-actions'
  statusRow.append(status)

  const isDev = () => select.value === DEV_PR
  const syncMode = () => {
    dev.el.classList.toggle('hidden', !isDev())
    runBtn.textContent = isDev() ? 'PR 만들기 (Draft)' : '＋ 실행'
    runBtn.classList.toggle('primary', isDev())
    extra.placeholder = isDev()
      ? '추가 지시(선택): 어디를 어떻게 고칠지, 주의사항 등'
      : '추가 지시(선택): 이 워크플로우에 덧붙일 요청'
    status.textContent = ''
  }
  select.addEventListener('change', syncMode)

  runBtn.addEventListener('click', async () => {
    if (!isDev()) { runAction(m.id, select.value, extra.value.trim()); return }
    const repos = dev.getRepos()
    if (!repos.length) { status.textContent = '레포를 선택하세요'; return }
    const many = repos.length > 1 ? ` (${repos.length}개)` : ''
    if (!confirm(`격리된 worktree에서 자동으로 코드를 수정하고 각 레포에 Draft PR${many}을 생성합니다. 진행할까요?`)) return
    runBtn.disabled = true
    status.textContent = '개발 중… (진행은 아래 로그)'
    try {
      await window.watchpup.devRun(m.id, repos, extra.value.trim())
      status.textContent = '완료(로그·PR 확인)'
    } catch (e) {
      status.textContent = '실패: ' + (e?.message || e)
    } finally {
      runBtn.disabled = false
    }
  })

  syncMode()
  wrap.append(moreWrap, dev.el, extra, statusRow)
  return wrap
}

function appendActionEntry(log, entry) {
  const div = document.createElement('div')
  div.className = 'action-entry' + (entry.done ? '' : ' running') + (entry.error ? ' error' : '')
  const label = document.createElement('div')
  label.className = 'action-entry-label'
  label.textContent = entry.label
  const body = document.createElement('div')
  body.className = 'action-entry-body'
  body.textContent = entry.text || (entry.done ? '' : '실행 중…')
  div.append(label, body)
  log.appendChild(div)
  log.scrollTop = log.scrollHeight
  return body
}

function findRunningEntry(mentionId, playbookId) {
  const alog = getActionLog(mentionId)
  return [...alog.entries].reverse().find((e) => e.playbookId === playbookId && !e.done)
}

async function runAction(mentionId, playbookId, extra = '') {
  const pb = playbookById(playbookId)
  if (!pb) return
  if (pb.write && !confirm(`'${pb.name}' 실행할까요? (쓰기 작업)`)) return

  const alog = getActionLog(mentionId)
  const entry = { label: pb.name, playbookId, text: '', done: false, error: false }
  alog.entries.push(entry)
  state.runningActions.add(mentionId)
  if (mentionId === state.current) {
    const m = state.mentions.get(mentionId)
    if (m) renderDetail(m)
  }

  try {
    const result = await window.watchpup.actionRun(mentionId, playbookId, extra)
    finalizeAction(mentionId, entry, (result && result.text) || entry.text, false)
  } catch (err) {
    finalizeAction(mentionId, entry, '오류: ' + (err?.message || err), true)
  }
}

// 스트리밍 이벤트와 actionRun()의 await 완료 양쪽에서 호출될 수 있으므로
// entry.done 플래그로 중복 완료를 막는다(chat 패턴과 동일).
// 방어적 폴백: 워크플로우가 (세션 재사용 탓에) 분석 JSON을 그대로 뱉으면 사람이 읽는 형태로 변환.
function humanizeActionText(text) {
  const t = (text || '').trim()
  const fence = t.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/)
  const raw = fence ? fence[1].trim() : t
  if (!raw.startsWith('{')) return text
  let o
  try { o = JSON.parse(raw) } catch { return text }
  if (!o || typeof o !== 'object' || Array.isArray(o)) return text
  if (!(o.summary || o.advice || o.todos || o.draftReply || o.headline)) return text
  const parts = []
  if (o.headline) parts.push(o.headline)
  if (o.summary) parts.push('요약: ' + o.summary)
  if (o.advice) parts.push('조언: ' + o.advice)
  if (Array.isArray(o.todos) && o.todos.length) parts.push('할 일:\n' + o.todos.map((td) => '· ' + (td && td.text ? td.text : td)).join('\n'))
  if (o.draftReply) parts.push('답장 초안: ' + o.draftReply)
  return parts.join('\n\n')
}

function finalizeAction(mentionId, entry, finalText, isError) {
  if (entry.done) return
  entry.text = isError ? finalText : humanizeActionText(finalText)
  entry.done = true
  entry.error = isError
  state.runningActions.delete(mentionId)
  if (mentionId === state.current) {
    const el = state.actionEls.get(mentionId)
    if (el) {
      el.textContent = entry.text
      el.parentElement.classList.remove('running')
      if (isError) el.parentElement.classList.add('error')
    }
    detailEl.querySelectorAll('.action-buttons button, .action-more button').forEach((b) => {
      b.disabled = false
    })
  }
  state.actionEls.delete(mentionId)
}

function renderChat(m) {
  const wrap = document.createElement('div')
  wrap.className = 'section'
  const h = document.createElement('h3')
  h.textContent = '의견 더 구하기'
  const log = document.createElement('div')
  log.id = 'chat-log'
  const form = document.createElement('form')
  form.id = 'chat-form'
  const input = document.createElement('input')
  input.id = 'chat-input'
  input.type = 'text'
  input.placeholder = '질문을 입력하세요…'
  const sendBtn = document.createElement('button')
  sendBtn.type = 'submit'
  sendBtn.textContent = '보내기'

  form.append(input, sendBtn)
  wrap.append(h, log, form)

  // 이 멘션의 기존 대화 기록을 복원
  const chat = getChat(m.id)
  for (const msg of chat.messages) {
    const cls = msg.role === 'me' ? 'me' : msg.pending ? 'watchpup pending' : 'watchpup'
    const el = appendChatMsg(log, cls, msg.text)
    if (msg.pending) state.pendingEls.set(m.id, el)
  }

  form.addEventListener('submit', async (e) => {
    e.preventDefault()
    const text = input.value.trim()
    if (!text) return
    input.value = ''
    sendBtn.disabled = true

    chat.messages.push({ role: 'me', text, pending: false })
    appendChatMsg(log, 'me', text)

    const pendingMsg = { role: 'watchpup', text: '', pending: true }
    chat.messages.push(pendingMsg)
    const pendingEl = appendChatMsg(log, 'watchpup pending', '…')
    state.pendingEls.set(m.id, pendingEl)

    try {
      const result = await window.watchpup.chatSend(m.id, text)
      finalizePendingChat(m.id, pendingMsg, result?.text || pendingMsg.text)
    } catch (err) {
      finalizePendingChat(m.id, pendingMsg, '오류: ' + (err?.message || err))
    } finally {
      sendBtn.disabled = false
    }
  })

  return wrap
}

// 스트리밍 이벤트와 chatSend()의 await 완료 양쪽에서 호출될 수 있으므로
// pendingMsg.pending 플래그로 중복 완료를 막는다.
function finalizePendingChat(mentionId, pendingMsg, finalText) {
  if (!pendingMsg.pending) return
  pendingMsg.text = finalText
  pendingMsg.pending = false
  if (state.current === mentionId) {
    const el = state.pendingEls.get(mentionId)
    if (el) {
      el.textContent = finalText
      el.classList.remove('pending')
    }
  }
  state.pendingEls.delete(mentionId)
}

function appendChatMsg(log, cls, text) {
  const div = document.createElement('div')
  div.className = 'chat-msg ' + cls
  div.textContent = text
  log.appendChild(div)
  log.scrollTop = log.scrollHeight
  return div
}

window.watchpup.onChatStream(({ mentionId, event }) => {
  const chat = getChat(mentionId)
  const pendingMsg = [...chat.messages].reverse().find((msg) => msg.role === 'watchpup' && msg.pending)
  if (!pendingMsg) return

  if (event.type === 'progress' || event.type === 'assistant_text') {
    pendingMsg.text += event.text
    if (mentionId === state.current) {
      const el = state.pendingEls.get(mentionId)
      if (el) {
        el.textContent = pendingMsg.text
        el.parentElement.scrollTop = el.parentElement.scrollHeight
      }
    }
  } else if (event.type === 'result') {
    finalizePendingChat(mentionId, pendingMsg, event.text)
  } else if (event.type === 'error') {
    finalizePendingChat(mentionId, pendingMsg, '오류: ' + event.message)
  }
})

window.watchpup.onActionStream(({ mentionId, playbookId, event }) => {
  const entry = findRunningEntry(mentionId, playbookId)
  if (!entry) return
  if (event.type === 'progress' || event.type === 'assistant_text') {
    entry.text += event.text
    if (mentionId === state.current) {
      const el = state.actionEls.get(mentionId)
      if (el) {
        el.textContent = entry.text
        const log = document.getElementById('action-log')
        if (log) log.scrollTop = log.scrollHeight
      }
    }
  }
})

window.watchpup.onActionDone(({ mentionId, playbookId, text, error }) => {
  const entry = findRunningEntry(mentionId, playbookId)
  if (!entry) return
  finalizeAction(mentionId, entry, text || entry.text, !!error)
})

// 다른 모듈이 순환 import 없이 쓰도록 등록
Object.assign(nav, { renderDetail, renderActivityDetail, runAction })

export { renderActivityDetail, renderDetail, runAction }
