import { appendMarkdown, copyToClipboard } from './richtext.js'
import { buildWorkPrompt, sameWorkItems, sortWorkItems, userNoteContent } from './work-support.js'

const KIND_LABEL = { jira: 'Jira', github: 'GitHub', slack: 'Slack', notion: 'Notion', figma: 'Figma', web: 'Web' }
const state = { items: [], selectedId: '', query: '', kind: '', includeCompleted: false, loading: false, sort: 'dueDateThenTitle', manualOrder: [], dragId: '', agentStatuses: new Map() }

const listSelect = document.getElementById('work-list-select')
const listEl = document.getElementById('work-list')
const detailEl = document.getElementById('work-detail')
const hintEl = document.getElementById('work-source-hint')
const createForm = document.getElementById('work-create-form')
const createTitle = document.getElementById('work-create-title')
let workInitialized = false
let workInitialization = null

function el(tag, className, text) {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (text != null) node.textContent = text
  return node
}

function formatDue(value) {
  if (!value) return ''
  const date = new Date(value)
  const now = new Date()
  const sameYear = date.getFullYear() === now.getFullYear()
  return new Intl.DateTimeFormat('ko-KR', {
    ...(sameYear ? {} : { year: 'numeric' }), month: 'short', day: 'numeric',
  }).format(date)
}

function filteredItems() {
  const query = state.query.trim().toLowerCase()
  const filtered = state.items.filter((item) => {
    if (state.kind && !item.links?.some((link) => link.kind === state.kind)) return false
    if (!query) return true
    return [item.title, item.notes, ...(item.links || []).flatMap((link) => [link.title, link.url])]
      .filter(Boolean).join(' ').toLowerCase().includes(query)
  })
  return sortWorkItems(filtered, state.sort, state.manualOrder)
}

function orderedOpenItems() {
  return sortWorkItems(state.items.filter((item) => !item.completed), state.sort, state.manualOrder)
}

function issueNumber(item) {
  const index = orderedOpenItems().findIndex((candidate) => candidate.id === item.id)
  return index < 0 ? null : index + 1
}

function renderList() {
  listEl.replaceChildren()
  if (state.loading) {
    listEl.append(el('p', 'list-empty', 'Reminder 불러오는 중…'))
    return
  }
  const items = filteredItems()
  if (!items.length) {
    listEl.append(el('p', 'list-empty', state.items.length ? '조건에 맞는 작업이 없어요' : '이 목록에 작업이 없어요'))
    return
  }
  for (const item of items) {
    const card = el('button', `work-card${item.id === state.selectedId ? ' selected' : ''}${item.completed ? ' completed' : ''}`)
    card.type = 'button'
    card.style.paddingLeft = `${10 + Math.min(item.depth || 0, 8) * 18}px`
    card.addEventListener('click', () => selectItem(item.id))
    if (state.sort === 'manual' && !item.completed) {
      card.draggable = true
      card.addEventListener('dragstart', () => { state.dragId = item.id })
      card.addEventListener('dragover', (event) => event.preventDefault())
      card.addEventListener('drop', async (event) => {
        event.preventDefault()
        if (state.dragId && state.dragId !== item.id) await moveManualItem(state.dragId, item.id)
        state.dragId = ''
      })
    }

    const top = el('div', 'work-card-top')
    if (state.sort === 'manual' && !item.completed) top.append(el('span', 'work-drag', '≡'))
    else if (item.parentId) top.append(el('span', 'work-child-mark', '↳'))
    top.append(el('span', `work-check${item.completed ? ' done' : ''}`, item.completed ? '✓' : ''))
    top.append(el('span', 'work-card-title', item.title || '제목 없음'))
    card.append(top)

    const meta = el('div', 'work-card-meta')
    const number = issueNumber(item)
    if (number) meta.append(el('span', 'work-issue', `#${number}`))
    const agentStatus = state.agentStatuses.get(item.id)
    if (agentStatus === 'ready') meta.append(el('span', 'work-agent-chip ready', '📝 제안'))
    else if (agentStatus === 'running') meta.append(el('span', 'work-agent-chip', '⏳ 제안 중'))
    for (const kind of [...new Set((item.links || []).map((link) => link.kind))].slice(0, 4)) {
      meta.append(el('span', `work-kind kind-${kind}`, KIND_LABEL[kind] || 'Web'))
    }
    if (item.dueAt) meta.append(el('span', `work-due${item.dueAt < Date.now() && !item.completed ? ' overdue' : ''}`, formatDue(item.dueAt)))
    if (item.childIds?.length) meta.append(el('span', 'work-issue', `하위 ${item.childIds.length}`))
    card.append(meta)
    listEl.append(card)
  }
}

function renderEmpty() {
  detailEl.innerHTML = '<div class="empty"><div class="empty-mark">⌁</div><p class="empty-title">왼쪽에서 작업을 골라보세요</p><p class="empty-sub">Reminder 메모에 업무 링크를 한곳에 모아볼 수 있습니다.</p></div>'
}

function linkRow(link, item) {
  const row = el('div', 'work-link-row')
  const badge = el('span', `work-link-badge kind-${link.kind}`, KIND_LABEL[link.kind] || 'Web')
  const info = el('div', 'work-link-info')
  info.append(el('div', 'work-link-title', link.title || link.host))
  info.append(el('div', 'work-link-host', link.host))
  const actions = el('div', 'work-link-actions')
  const copy = el('button', '', '복사')
  copy.type = 'button'
  copy.addEventListener('click', async () => {
    await copyToClipboard(link.url)
    copy.textContent = '완료'
    setTimeout(() => { copy.textContent = '복사' }, 1000)
  })
  const edit = el('button', '', '✎')
  edit.type = 'button'
  edit.title = '링크 편집'
  edit.setAttribute('aria-label', '링크 편집')
  edit.addEventListener('click', () => renderLinkEditor(row, link, item))
  const remove = el('button', '', '×')
  remove.type = 'button'
  remove.title = '링크 삭제'
  remove.setAttribute('aria-label', '링크 삭제')
  remove.addEventListener('click', async () => {
    if (!window.confirm(`이 링크를 지울까요?\n\n${link.title || link.host}\n${link.url}`)) return
    remove.disabled = true
    try {
      await window.watchpup.workReminderLinkRemove(item.id, link.url)
      await refreshWorkView({ preserveSelection: true })
    } catch (error) {
      hintEl.textContent = error?.message || '링크를 지우지 못했습니다.'
      remove.disabled = false
    }
  })
  const open = el('button', 'primary', '↗')
  open.type = 'button'
  open.title = '외부에서 열기'
  open.setAttribute('aria-label', `${KIND_LABEL[link.kind] || '링크'} 외부에서 열기`)
  open.addEventListener('click', () => window.watchpup.openExternal(link.url))
  actions.append(copy, edit, remove, open)
  row.append(badge, info, actions)
  if (link.kind === 'jira' || link.kind === 'github') {
    const statusHost = el('div', 'work-link-status loading', '상태 불러오는 중…')
    row.append(statusHost)
    window.watchpup.workLinkStatus(link.url)
      .then((status) => renderLinkStatus(statusHost, link, status))
      .catch((error) => {
        statusHost.className = 'work-link-status error'
        statusHost.textContent = error?.message || '상태를 불러오지 못했습니다.'
      })
  }
  return row
}

function renderLinkEditor(row, link, item) {
  const form = el('form', 'work-link-edit')
  const title = el('input')
  title.type = 'text'
  title.value = link.title || ''
  title.placeholder = '링크 이름'
  const url = el('input')
  url.type = 'url'
  url.value = link.url
  url.required = true
  const save = el('button', 'primary', '저장')
  save.type = 'submit'
  const cancel = el('button', '', '취소')
  cancel.type = 'button'
  cancel.addEventListener('click', () => renderDetail())
  form.append(title, url, save, cancel)
  form.addEventListener('submit', async (event) => {
    event.preventDefault()
    if (!window.confirm(`링크를 이렇게 수정할까요?\n\n${title.value.trim() || '(이름 없음)'}\n${url.value.trim()}`)) return
    save.disabled = true
    try {
      await window.watchpup.workReminderLinkUpdate(item.id, link.url, title.value, url.value.trim())
      await refreshWorkView({ preserveSelection: true })
    } catch (error) {
      hintEl.textContent = error?.message || '링크를 수정하지 못했습니다.'
      save.disabled = false
    }
  })
  row.replaceChildren(el('span', `work-link-badge kind-${link.kind}`, KIND_LABEL[link.kind] || 'Web'), form)
  title.focus()
}

function renderLinkStatus(host, link, status) {
  host.className = 'work-link-status'
  host.replaceChildren()
  const summary = el('div', 'work-status-summary')
  const statusClass = String(status.status).toLowerCase().replace(/[^a-z0-9_-]+/g, '-')
  summary.append(el('span', `work-status-pill status-${statusClass}`, status.status))
  if (status.detail) summary.append(el('span', 'work-status-detail', status.detail))
  host.append(summary)
  if (!status.actions?.length) return

  const controls = el('div', 'work-status-controls')
  const select = el('select')
  for (const action of status.actions) {
    const option = el('option', '', action.label)
    option.value = action.id
    option.dataset.danger = action.danger ? 'true' : 'false'
    select.append(option)
  }
  const apply = el('button', '', '상태 변경')
  apply.type = 'button'
  apply.addEventListener('click', async () => {
    const option = select.selectedOptions[0]
    if (!option) return
    if (!window.confirm(`“${option.textContent}” 상태로 변경할까요?\n\n${status.title}`)) return
    apply.disabled = true
    apply.textContent = '변경 중…'
    try {
      const next = await window.watchpup.workLinkAction(link.url, select.value)
      renderLinkStatus(host, link, next)
    } catch (error) {
      apply.disabled = false
      apply.textContent = '상태 변경'
      hintEl.textContent = error?.message || '상태를 변경하지 못했습니다.'
    }
  })
  controls.append(select, apply)
  host.append(controls)
}

function renderDetail() {
  const item = state.items.find((candidate) => candidate.id === state.selectedId)
  if (!item) return renderEmpty()
  detailEl.replaceChildren()

  const header = el('header', 'work-detail-head')
  const titleWrap = el('div', 'work-detail-title-wrap')
  const kicker = el('div', 'work-detail-kicker', `${item.account} / ${item.listName}`)
  const title = el('h1', '', item.title || '제목 없음')
  const editTitle = el('button', 'work-title-edit', '✎')
  editTitle.type = 'button'; editTitle.title = '제목 편집'; editTitle.setAttribute('aria-label', '제목 편집')
  editTitle.addEventListener('click', () => renderTitleEditor(titleWrap, item))
  titleWrap.append(kicker, title, editTitle)
  const complete = el('button', item.completed ? 'work-complete done' : 'work-complete', item.completed ? '✓ 완료' : '완료로 표시')
  complete.type = 'button'
  complete.addEventListener('click', async () => {
    complete.disabled = true
    try {
      await window.watchpup.workReminderComplete(item.id, !item.completed)
      await refreshWorkView({ preserveSelection: true })
    } catch (error) {
      hintEl.textContent = error?.message || '완료 상태를 바꾸지 못했습니다.'
      complete.disabled = false
    }
  })
  header.append(titleWrap, complete)
  detailEl.append(header)

  const body = el('div', 'work-detail-body')
  const agentSection = el('section', 'work-section work-agent-section')
  body.append(agentSection)
  void renderWorkAgentSection(agentSection, item)

  const notesSection = el('section', 'work-section')
  const noteHead = el('div', 'work-note-actions')
  noteHead.append(el('h2', '', '메모'))
  const note = userNoteContent(item.notes)
  const editNote = el('button', '', note ? '편집' : '메모 추가')
  editNote.type = 'button'
  noteHead.append(editNote)
  const noteBody = el('div', `work-notes${note ? '' : ' empty-note'}`, note || '메모가 없습니다.')
  editNote.addEventListener('click', () => renderNoteEditor(notesSection, item, note))
  notesSection.append(noteHead, noteBody)
  body.append(notesSection)

  const linksSection = el('section', 'work-section')
  const linkHead = el('div', 'work-section-head')
  linkHead.append(el('h2', '', '연결된 링크'), el('span', 'work-link-count', `${item.links?.length || 0}`))
  linksSection.append(linkHead)
  const links = el('div', 'work-links')
  if (item.links?.length) item.links.forEach((link) => links.append(linkRow(link, item)))
  else links.append(el('p', 'work-section-empty', '아직 연결된 링크가 없습니다.'))
  linksSection.append(links)

  const form = el('form', 'work-link-form')
  const kind = el('select')
  for (const value of ['jira', 'github', 'slack', 'notion', 'figma', 'web']) {
    const option = el('option', '', KIND_LABEL[value])
    option.value = value
    kind.append(option)
  }
  const linkTitle = el('input')
  linkTitle.type = 'text'; linkTitle.placeholder = '링크 이름 (선택)'; linkTitle.autocomplete = 'off'
  const url = el('input')
  url.type = 'url'; url.placeholder = 'https://…'; url.required = true; url.autocomplete = 'off'
  const add = el('button', 'primary', '추가')
  add.type = 'submit'
  form.append(kind, linkTitle, url, add)
  form.addEventListener('submit', async (event) => {
    event.preventDefault()
    add.disabled = true
    try {
      await window.watchpup.workReminderLinkAdd(item.id, { kind: kind.value, title: linkTitle.value, url: url.value })
      await refreshWorkView({ preserveSelection: true })
    } catch (error) {
      hintEl.textContent = error?.message || '링크를 추가하지 못했습니다.'
      add.disabled = false
    }
  })
  linksSection.append(form)
  body.append(linksSection)

  const codexSection = el('section', 'work-section')
  const codexHead = el('div', 'work-codex-head')
  codexHead.append(el('h2', '', 'Codex'))
  const copyPrompt = el('button', '', '프롬프트 복사')
  copyPrompt.type = 'button'
  copyPrompt.addEventListener('click', async () => {
    await copyToClipboard(buildWorkPrompt({
      item,
      issueNumber: issueNumber(item),
      listTitle: `${item.account} / ${item.listName}`,
      subtasks: subtasksOf(item),
      parent: parentOf(item),
    }))
    copyPrompt.textContent = '복사됨'
    setTimeout(() => { copyPrompt.textContent = '프롬프트 복사' }, 1200)
  })
  codexHead.append(copyPrompt)
  const identifiers = el('div', 'work-identifiers')
  const number = issueNumber(item)
  if (number) identifiers.append(el('span', 'work-identifier-label', 'Work issue'), el('span', 'work-identifier-value', `#${number}`))
  identifiers.append(el('span', 'work-identifier-label', 'Reminder ID'), el('span', 'work-identifier-value', item.id))
  codexSection.append(codexHead, identifiers)
  body.append(codexSection)

  const subtasksSection = el('section', 'work-section')
  const subtasks = subtasksOf(item)
  const subtaskHead = el('div', 'work-section-head')
  subtaskHead.append(el('h2', '', '서브태스크'), el('span', 'work-link-count', `${subtasks.length}`))
  const subtaskList = el('div', 'work-subtasks')
  if (subtasks.length) {
    for (const subtask of subtasks) {
      const row = el('div', 'work-subtask-row')
      const toggle = el('button', '', subtask.completed ? '✓' : '○'); toggle.type = 'button'
      toggle.addEventListener('click', async (event) => {
        event.stopPropagation()
        await window.watchpup.workReminderComplete(subtask.id, !subtask.completed)
        await refreshWorkView({ preserveSelection: true })
      })
      row.append(toggle, el('span', subtask.completed ? 'completed' : '', subtask.title))
      row.addEventListener('click', () => selectItem(subtask.id))
      subtaskList.append(row)
    }
  } else subtaskList.append(el('p', 'work-section-empty', '서브태스크가 없습니다.'))
  const subtaskForm = el('form', 'work-subtask-form')
  const subtaskTitle = el('input'); subtaskTitle.placeholder = '새 서브태스크'; subtaskTitle.required = true
  const subtaskAdd = el('button', 'primary', '추가'); subtaskAdd.type = 'submit'
  subtaskForm.append(subtaskTitle, subtaskAdd)
  subtaskForm.addEventListener('submit', async (event) => {
    event.preventDefault(); subtaskAdd.disabled = true
    try {
      const created = await window.watchpup.workReminderSubtaskAdd(item.id, subtaskTitle.value)
      state.selectedId = created.id
      await refreshWorkView({ preserveSelection: true })
    } catch (error) {
      hintEl.textContent = error?.message || '서브태스크를 추가하지 못했습니다.'
      subtaskAdd.disabled = false
    }
  })
  subtasksSection.append(subtaskHead, subtaskList, subtaskForm)
  body.append(subtasksSection)
  detailEl.append(body)
}

// ---- 에이전트 제안: 계획(plan)을 미리 세워두고 카드에서 확인·논의 ----
const agentChats = new Map() // reminderId → [{ role: 'me'|'pup', text, pending }]

function providerLabel(proposal) {
  const name = proposal.provider === 'codex' ? 'Codex' : 'Claude'
  return proposal.model ? `${name} · ${proposal.model}` : name
}

function renderAgentChatLog(log, reminderId) {
  log.replaceChildren()
  for (const message of agentChats.get(reminderId) || []) {
    const row = el('div', `work-agent-msg ${message.role}`)
    if (message.role === 'pup' && !message.pending) appendMarkdown(row, message.text)
    else row.textContent = message.text || (message.pending ? '생각 중…' : '')
    log.append(row)
  }
  log.scrollTop = log.scrollHeight
}

async function renderWorkAgentSection(host, item) {
  let data
  try {
    data = await window.watchpup.workAgentGet(item.id)
  } catch {
    host.remove()
    return
  }
  if (!host.isConnected) return
  const { proposal, prefs, busy } = data
  host.replaceChildren()
  const head = el('div', 'work-section-head')
  head.append(el('h2', '', '에이전트 제안'))
  host.append(head)

  if (proposal) {
    const card = el('div', `work-agent-card status-${proposal.status}`)
    if (proposal.status === 'running') {
      card.append(el('div', 'work-agent-status', '⏳ 계획 세우는 중…'))
      const started = new Date(proposal.startedAt).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' })
      card.append(el('p', 'work-agent-meta', `${providerLabel(proposal)} · ${started} 시작 · 진행 상황은 Agent 탭에서`))
      const runningActions = el('div', 'work-agent-actions')
      if (proposal.orcaTerminal) {
        const watch = el('button', 'primary', 'Orca에서 보기')
        watch.type = 'button'
        watch.addEventListener('click', async () => {
          try {
            await window.watchpup.workAgentOpen(item.id)
          } catch (error) {
            hintEl.textContent = error?.message || 'Orca 터미널을 열지 못했습니다.'
          }
        })
        runningActions.append(watch)
      }
      const cancel = el('button', '', '취소')
      cancel.type = 'button'
      cancel.addEventListener('click', async () => {
        if (!window.confirm('진행 중인 계획 작업을 취소할까요?')) return
        cancel.disabled = true
        cancel.textContent = '취소 중…'
        try {
          await window.watchpup.workAgentCancel(item.id)
        } catch (error) {
          hintEl.textContent = error?.message || '취소하지 못했습니다.'
          cancel.disabled = false
          cancel.textContent = '취소'
        }
      })
      runningActions.append(cancel)
      card.append(runningActions)
    } else if (proposal.status === 'ready') {
      card.append(el('div', 'work-agent-status', '📝 계획을 미리 세워뒀어요'))
      if (proposal.summary) card.append(el('p', 'work-agent-summary', proposal.summary))
      const bits = [providerLabel(proposal)]
      if (proposal.branch) bits.push(proposal.branch)
      card.append(el('p', 'work-agent-meta', bits.join(' · ')))

      const planBox = el('details', 'work-agent-plan')
      const planToggle = el('summary', '', '계획 보기')
      const planOpen = el('button', 'work-agent-plan-open', '파일로 열기 ↗')
      planOpen.type = 'button'
      planOpen.title = '계획 파일(WATCHPUP-PLAN.md)을 기본 앱으로 엽니다'
      planOpen.addEventListener('click', async (event) => {
        event.preventDefault()
        try {
          await window.watchpup.workAgentPlanOpen(item.id)
        } catch (error) {
          hintEl.textContent = error?.message || '계획 파일을 열지 못했습니다.'
        }
      })
      planToggle.append(planOpen)
      planBox.append(planToggle)
      const planBody = el('div', 'work-agent-plan-body')
      planBox.append(planBody)
      card.append(planBox)
      window.watchpup.workAgentPlan(item.id).then(({ content }) => {
        if (content) appendMarkdown(planBody, content)
        else planBody.textContent = '계획 파일을 찾지 못했어요. 세션에서 확인해주세요.'
      }).catch(() => { planBody.textContent = '계획을 읽지 못했어요.' })
    } else {
      card.append(el('div', 'work-agent-status', '⚠️ 실행 실패'))
      card.append(el('p', 'work-agent-meta', (proposal.error || '알 수 없는 오류').slice(0, 200)))
    }

    if (proposal.status !== 'running') {
      const actions = el('div', 'work-agent-actions')
      // 실패해도 worktree가 있으면 세션이 밖에서 계속 돌고 있을 수 있으니 바로 넘어갈 수 있게 한다
      if (proposal.worktreePath) {
        const open = el('button', 'primary', '세션 열기')
        open.type = 'button'
        open.title = 'Orca 또는 터미널에서 이 계획 세션을 이어서 엽니다'
        open.addEventListener('click', async () => {
          open.disabled = true
          try {
            await window.watchpup.workAgentOpen(item.id)
          } catch (error) {
            hintEl.textContent = error?.message || '세션을 열지 못했습니다.'
          } finally {
            open.disabled = false
          }
        })
        actions.append(open)
      }
      const rerun = el('button', '', '다시 실행')
      rerun.type = 'button'
      rerun.addEventListener('click', async () => {
        if (!window.confirm('이전 제안 worktree를 정리하고 계획을 다시 세울까요?')) return
        rerun.disabled = true
        try {
          await window.watchpup.workAgentRun(item.id)
          agentChats.delete(item.id)
        } catch (error) {
          hintEl.textContent = error?.message || '다시 실행하지 못했습니다.'
          rerun.disabled = false
        }
      })
      const dismiss = el('button', '', '지우기')
      dismiss.type = 'button'
      dismiss.addEventListener('click', async () => {
        if (!window.confirm('이 제안을 지울까요? worktree와 계획 파일이 삭제됩니다.')) return
        dismiss.disabled = true
        try {
          await window.watchpup.workAgentDismiss(item.id)
          agentChats.delete(item.id)
        } catch (error) {
          hintEl.textContent = error?.message || '지우지 못했습니다.'
          dismiss.disabled = false
        }
      })
      actions.append(rerun, dismiss)
      card.append(actions)
    }
    host.append(card)

    // 계획 논의 채팅 (claude 세션 resume). codex는 세션 열기로 논의.
    if (proposal.status === 'ready') {
      if (proposal.provider === 'claude' && proposal.sessionId) {
        const log = el('div', 'work-agent-chat-log')
        log.id = 'work-agent-chat-log'
        renderAgentChatLog(log, item.id)
        const chatForm = el('form', 'work-agent-chat')
        const input = el('input')
        input.type = 'text'
        input.placeholder = '계획에 대해 물어보거나 수정 요청…'
        input.autocomplete = 'off'
        const sendBtn = el('button', 'primary', '보내기')
        sendBtn.type = 'submit'
        chatForm.append(input, sendBtn)
        chatForm.addEventListener('submit', async (event) => {
          event.preventDefault()
          const text = input.value.trim()
          if (!text) return
          input.value = ''
          sendBtn.disabled = true
          const messages = agentChats.get(item.id) || []
          messages.push({ role: 'me', text }, { role: 'pup', text: '', pending: true })
          agentChats.set(item.id, messages)
          renderAgentChatLog(log, item.id)
          try {
            await window.watchpup.workAgentChat(item.id, text)
          } catch (error) {
            const pending = [...messages].reverse().find((message) => message.pending)
            if (pending) {
              pending.text = error?.message || '논의 요청에 실패했어요.'
              pending.pending = false
            }
          } finally {
            const current = document.getElementById('work-agent-chat-log')
            if (current) renderAgentChatLog(current, item.id)
            sendBtn.disabled = false
          }
        })
        host.append(log, chatForm)
      } else if (proposal.provider === 'codex') {
        host.append(el('p', 'work-agent-meta', '논의는 "세션 열기"에서 이어갈 수 있어요 (Codex).'))
      } else {
        host.append(el('p', 'work-agent-meta', 'Orca 터미널에서 실행된 제안이에요 — 논의는 "세션 열기"로 그 터미널에서 이어가요.'))
      }
    }
  }

  // 태스크별 설정 + 수동 실행
  const controls = el('div', 'work-agent-controls')
  const autoLabel = el('label', 'work-agent-auto')
  const auto = el('input')
  auto.type = 'checkbox'
  auto.checked = prefs.auto !== false
  auto.addEventListener('change', () => {
    void window.watchpup.workAgentPrefsSet(item.id, { auto: auto.checked }).catch(() => {})
  })
  autoLabel.append(auto, document.createTextNode(' 자동 제안'))
  const provider = el('select')
  for (const [value, label] of [['', '기본 에이전트'], ['claude', 'Claude'], ['codex', 'Codex']]) {
    const option = el('option', '', label)
    option.value = value
    provider.append(option)
  }
  provider.value = prefs.provider || ''
  const model = el('input')
  model.type = 'text'
  model.placeholder = '모델 (비우면 기본)'
  model.value = prefs.model || ''
  // 태스크별 레포: 여러 레포 사용 시 이 작업이 어느 레포에서 진행될지 고정
  const repo = el('select')
  const repoAuto = el('option', '', '레포 선택 (없으면 제안 안 함)')
  repoAuto.value = ''
  repo.append(repoAuto)
  window.watchpup.reposList().then((paths) => {
    for (const path of paths || []) {
      const option = el('option', '', path.split('/').pop() || path)
      option.value = path
      option.title = path
      repo.append(option)
    }
    if (prefs.repo && ![...repo.options].some((option) => option.value === prefs.repo)) {
      const missing = el('option', '', `${prefs.repo.split('/').pop()} (저장값)`)
      missing.value = prefs.repo
      repo.append(missing)
    }
    repo.value = prefs.repo || ''
  }).catch(() => {})
  const savePrefs = () => {
    void window.watchpup.workAgentPrefsSet(item.id, { provider: provider.value, model: model.value.trim(), repo: repo.value }).catch(() => {})
  }
  provider.addEventListener('change', savePrefs)
  model.addEventListener('change', savePrefs)
  repo.addEventListener('change', savePrefs)
  controls.append(autoLabel, provider, model, repo)
  if (!proposal) {
    const run = el('button', 'primary', busy ? '다른 작업 실행 중…' : '지금 계획 세워보기')
    run.type = 'button'
    run.disabled = !!busy
    run.addEventListener('click', async () => {
      run.disabled = true
      try {
        await window.watchpup.workAgentRun(item.id)
      } catch (error) {
        hintEl.textContent = error?.message || '실행하지 못했습니다.'
        run.disabled = false
      }
    })
    controls.append(run)
  }
  host.append(controls)
}

function subtasksOf(item) {
  return sortWorkItems(state.items.filter((candidate) => candidate.parentId === item.id), 'dueDateThenTitle')
}

function parentOf(item) {
  return item.parentId ? state.items.find((candidate) => candidate.id === item.parentId) || null : null
}

async function moveManualItem(sourceId, targetId) {
  const ids = orderedOpenItems().map((item) => item.id)
  const sourceIndex = ids.indexOf(sourceId)
  const targetIndex = ids.indexOf(targetId)
  if (sourceIndex < 0 || targetIndex < 0) return
  ids.splice(sourceIndex, 1)
  ids.splice(targetIndex, 0, sourceId)
  state.manualOrder = ids
  renderList(); renderDetail()
  await window.watchpup.settingsSet({ reminderTaskManualOrder: ids })
}

function renderTitleEditor(host, item) {
  const form = el('form', 'work-title-form')
  const input = el('input')
  input.value = item.title || ''; input.required = true
  const save = el('button', 'primary', '저장'); save.type = 'submit'
  const cancel = el('button', '', '취소'); cancel.type = 'button'
  form.append(input, save, cancel)
  host.replaceChildren(el('div', 'work-detail-kicker', `${item.account} / ${item.listName}`), form)
  input.focus(); input.select()
  cancel.addEventListener('click', renderDetail)
  form.addEventListener('submit', async (event) => {
    event.preventDefault(); save.disabled = true
    try {
      await window.watchpup.workReminderTitleUpdate(item.id, input.value)
      await refreshWorkView({ preserveSelection: true })
    } catch (error) {
      hintEl.textContent = error?.message || '제목을 변경하지 못했습니다.'
      save.disabled = false
    }
  })
}

function renderNoteEditor(section, item, note) {
  const editor = el('form', 'work-note-editor')
  const textarea = el('textarea'); textarea.value = note
  const actions = el('div', 'work-note-actions')
  actions.append(el('span', 'hint', '<note> 블록으로 저장되어 링크는 유지됩니다.'))
  const buttons = el('div')
  const cancel = el('button', '', '취소'); cancel.type = 'button'
  const save = el('button', 'primary', '저장'); save.type = 'submit'
  buttons.append(cancel, save); actions.append(buttons); editor.append(textarea, actions)
  section.replaceChildren(el('h2', '', '메모'), editor)
  textarea.focus()
  cancel.addEventListener('click', renderDetail)
  editor.addEventListener('submit', async (event) => {
    event.preventDefault(); save.disabled = true
    try {
      await window.watchpup.workReminderNoteUpdate(item.id, textarea.value)
      await refreshWorkView({ preserveSelection: true })
    } catch (error) {
      hintEl.textContent = error?.message || '메모를 변경하지 못했습니다.'
      save.disabled = false
    }
  })
}

function selectItem(id, options = {}) {
  state.selectedId = id
  renderList()
  renderDetail()
  if (options.touch !== false) window.watchpup.workItemTouch?.(id).catch(() => {})
}

export async function focusWorkItem(id) {
  if (!id || !listSelect?.value) return
  await refreshWorkView({ preserveSelection: true, silent: true })
  if (state.items.some((item) => item.id === id)) selectItem(id)
}

export async function refreshWorkView(options = {}) {
  if (!listSelect?.value) return
  const silent = options.silent === true
  state.loading = true
  if (!silent) {
    hintEl.textContent = ''
    renderList()
  }
  try {
    const nextItems = await window.watchpup.workItems(listSelect.value, state.includeCompleted)
    try {
      const proposals = await window.watchpup.workAgentList()
      state.agentStatuses = new Map((proposals || []).map((proposal) => [proposal.reminderId, proposal.status]))
    } catch { /* 제안 배지는 없어도 목록은 표시 */ }
    const itemsChanged = !sameWorkItems(state.items, nextItems)
    const previousSelectedId = state.selectedId
    state.items = nextItems
    if (!options.preserveSelection || !nextItems.some((item) => item.id === state.selectedId)) {
      state.selectedId = nextItems[0]?.id || ''
    }
    state.loading = false
    if (!silent || itemsChanged || previousSelectedId !== state.selectedId) {
      renderList()
      renderDetail()
    }
    hintEl.textContent = `${state.items.length}개 작업 · Apple Reminders와 동기화`
  } catch (error) {
    state.loading = false
    if (!silent) {
      state.items = []
      state.selectedId = ''
      renderList()
      renderEmpty()
    }
    hintEl.textContent = error?.message || 'Reminder를 읽지 못했습니다. macOS 권한을 확인해주세요.'
  }
}

async function initializeWorkView() {
  if (!listSelect) return
  const config = await window.watchpup.settingsGet()
  state.sort = config.reminderTaskSortOrder || 'dueDateThenTitle'
  state.manualOrder = config.reminderTaskManualOrder || []
  state.includeCompleted = config.showCompletedReminders === true
  const sortSelect = document.getElementById('work-sort')
  if (sortSelect) sortSelect.value = state.sort
  document.getElementById('work-sort-reset')?.classList.toggle('hidden', state.sort !== 'manual')
  const completedCheckbox = document.getElementById('work-show-completed')
  if (completedCheckbox) completedCheckbox.checked = state.includeCompleted
  const result = await window.watchpup.workLists()
  listSelect.replaceChildren()
  const placeholder = el('option', '', '미리 알림 목록 선택')
  placeholder.value = ''
  placeholder.selected = !result.selectedId
  placeholder.disabled = true
  listSelect.append(placeholder)
  for (const list of result.lists || []) {
    const count = Number.isFinite(list.openCount) ? ` · ${list.openCount}개` : ''
    const option = el('option', '', `${list.name} · ${list.account}${count}`)
    option.value = list.id
    option.selected = list.id === result.selectedId
    listSelect.append(option)
  }
  if (!result.lists?.length) {
    hintEl.textContent = '사용 가능한 Reminder 목록이 없습니다.'
    return
  }
  hintEl.textContent = result.selectedId
    ? '선택한 미리 알림 목록과 동기화합니다.'
    : `${result.lists.length}개 목록을 찾았습니다. 사용할 목록을 선택해주세요.`
  if (result.selectedId) await refreshWorkView()
}

export async function initWorkView() {
  if (!listSelect) return
  if (workInitialized) return refreshWorkView({ preserveSelection: true })
  if (workInitialization) return workInitialization
  workInitialization = initializeWorkView()
  try {
    await workInitialization
    workInitialized = true
  } catch (error) {
    hintEl.textContent = error?.message || 'Reminder 목록을 읽지 못했습니다.'
  } finally {
    workInitialization = null
  }
}

listSelect?.addEventListener('change', async () => {
  await window.watchpup.workListSelect(listSelect.value)
  state.selectedId = ''
  await refreshWorkView()
})
createForm?.addEventListener('submit', async (event) => {
  event.preventDefault()
  const submit = createForm.querySelector('button[type="submit"]')
  if (!listSelect?.value) {
    hintEl.textContent = '작업을 추가할 Reminder 목록을 먼저 선택해주세요.'
    return
  }
  if (!createTitle?.value.trim()) return
  submit.disabled = true
  try {
    const created = await window.watchpup.workReminderCreate(listSelect.value, createTitle.value, '')
    createForm.reset()
    state.selectedId = created.id
    await refreshWorkView({ preserveSelection: true })
    createTitle.focus()
  } catch (error) {
    hintEl.textContent = error?.message || '작업을 추가하지 못했습니다.'
  } finally {
    submit.disabled = false
  }
})
document.getElementById('work-refresh')?.addEventListener('click', () => refreshWorkView({ preserveSelection: true }))
document.getElementById('work-open-reminders')?.addEventListener('click', () => window.watchpup.workRemindersOpen())
document.getElementById('work-search')?.addEventListener('input', (event) => {
  state.query = event.target.value
  renderList()
})
document.getElementById('work-kind-filter')?.addEventListener('change', (event) => {
  state.kind = event.target.value
  renderList()
})
document.getElementById('work-sort')?.addEventListener('change', async (event) => {
  state.sort = event.target.value
  document.getElementById('work-sort-reset')?.classList.toggle('hidden', state.sort !== 'manual')
  renderList(); renderDetail()
  await window.watchpup.settingsSet({ reminderTaskSortOrder: state.sort })
})
document.getElementById('work-sort-reset')?.addEventListener('click', async () => {
  state.manualOrder = sortWorkItems(state.items.filter((item) => !item.completed), 'dueDateThenTitle').map((item) => item.id)
  renderList(); renderDetail()
  await window.watchpup.settingsSet({ reminderTaskManualOrder: state.manualOrder })
})
document.getElementById('work-show-completed')?.addEventListener('change', async (event) => {
  state.includeCompleted = event.target.checked
  await window.watchpup.settingsSet({ showCompletedReminders: state.includeCompleted })
  await refreshWorkView({ preserveSelection: true })
})

setInterval(() => {
  const view = document.getElementById('work-view')
  const active = document.activeElement
  const isEditing = view?.contains(active) && ['INPUT', 'TEXTAREA', 'SELECT'].includes(active?.tagName)
  if (view?.classList.contains('active') && listSelect?.value && !state.loading && !isEditing) {
    void refreshWorkView({ preserveSelection: true, silent: true })
  }
}, 10_000)

// 에이전트 제안 상태 변경(시작/완료/삭제) → 목록 배지 + 열려 있는 상세 갱신
window.watchpup.onWorkAgentChanged?.((payload) => {
  const reminderId = payload?.reminderId
  if (!reminderId) return
  if (payload.proposal) state.agentStatuses.set(reminderId, payload.proposal.status)
  else state.agentStatuses.delete(reminderId)
  renderList()
  if (reminderId === state.selectedId) renderDetail()
})

// 계획 논의 스트리밍 → 진행 중인 말풍선에 누적
window.watchpup.onWorkAgentChatStream?.(({ reminderId, event }) => {
  const messages = agentChats.get(reminderId)
  const pending = messages && [...messages].reverse().find((message) => message.pending)
  if (!pending || !event) return
  if (event.type === 'progress' || event.type === 'assistant_text') pending.text += event.text
  else if (event.type === 'result') {
    pending.text = event.text
    pending.pending = false
  } else if (event.type === 'error') {
    pending.text = '오류: ' + event.message
    pending.pending = false
  }
  if (reminderId === state.selectedId) {
    const log = document.getElementById('work-agent-chat-log')
    if (log) renderAgentChatLog(log, reminderId)
  }
})
