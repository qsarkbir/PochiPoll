import {
  $, el, button, message, tabCredential, participantUrl, canShareParticipantUrl, request, poll, downloadFile,
  storageGet, storageSet, styleLabels, emptyState, statusPill, errorMessage, isRecord, RequestError
} from './common.js';
import { chart } from './charts.js';
import { setupPreflight } from './preflight.js';
import { draft, orderedItems } from './admin-deck.js';
import type { AdminItem, DeckItem } from './admin-deck.js';
import type { ExportFormat } from './common.js';
import type { AdminComments, AdminDiscussion, AdminState, CommentControlInput, CommentVisibility, ControlInput,
  DiscussionControlInput, GraphStyle, Presentation } from '../types.js';

const key = tabCredential('admin');
const backupKey = 'fakeslido:deck';
const deckFormat = 'pochipoll-deck';
const legacyDeckFormat = 'fakeslido-deck';
let state: AdminState | undefined;
let previousSessionId: string | undefined;
let selectedId: string | undefined;
let editing: { id: string | undefined; deckRevision: number } | undefined;
let busy = false;
const editor = $('editor', HTMLDialogElement);
const optionFields = $('option-fields');
const editForm = $('edit-form', HTMLFormElement);
const submitEdit = editForm.querySelector('button[type="submit"]');
if (!(submitEdit instanceof HTMLButtonElement)) throw new Error('質問を保存するボタンが見つかりません。');
const questionText = $('question-text', HTMLTextAreaElement);
const questionType = $('question-type', HTMLSelectElement);
const questionStyle = $('question-style', HTMLSelectElement);
const copyLink = $('copy-link', HTMLButtonElement);
const openPresent = $('open-present', HTMLButtonElement);
const importInput = $('import', HTMLInputElement);
const eraseDialog = $('erase-dialog', HTMLDialogElement);
const eraseConfirm = $('erase-confirm', HTMLButtonElement);
const eraseCancel = $('erase-cancel', HTMLButtonElement);
const eraseError = $('erase-error');
const eraseDownloads = { csv: $('erase-csv', HTMLButtonElement), json: $('erase-json', HTMLButtonElement) };
let eraseTarget: string | null = null;
let erasePending: 'erase' | 'export' | undefined;
const updatePreflight = setupPreflight(key, () => state);
const extendExpiry = $('extend-expiry', HTMLButtonElement);
const expiryRemaining = $('expiry-remaining');
const expiryWarning = $('expiry-warning');
let expiryDeadline: number | undefined;
let commentSnapshot: AdminComments | undefined;
let commentFilter: CommentVisibility = 'pending';
let commentGeneration = 0;
let commentsLoading = false;

// API では分かれている選択式とお題を、運営画面では元の質問集順に扱う。
function items() {
  return orderedItems(currentState());
}

function deckData(format: typeof deckFormat | typeof legacyDeckFormat = deckFormat) {
  return { format, version: 1, questions: items().map(draft) };
}

function currentState(): AdminState {
  if (!state) throw new Error('運営画面の状態を取得できませんでした。');
  return state;
}

function setSelection(id: string | undefined) {
  selectedId = id;
  commentSnapshot = undefined;
  commentGeneration++;
}

function showQuestion(id: string) {
  setSelection(id);
  render();
  void refreshComments();
}

function applyState(next: AdminState, selectedAfterAdvance?: string) {
  if (next.sessionId === previousSessionId) return;
  const sameSession = state && next.sessionId === state.sessionId;
  if (state && sameSession && next.revision <= state.revision) {
    // ポーリングが先に同じ進行を反映しても、操作した画面の選択はここで更新する。
    if (selectedAfterAdvance && items().some(question => question.questionId === selectedAfterAdvance)) {
      showQuestion(selectedAfterAdvance);
    }
    return;
  }
  if (state && !sameSession) previousSessionId = state.sessionId;
  const newDeck = next.deckRevision !== state?.deckRevision;
  state = next;
  // サーバー側の時刻差を、端末の時計変更の影響を受けない経過時間に換算する。
  expiryDeadline = performance.now() + (next.expiresAt - next.serverTime);
  renderExpiry();
  const questions = items();
  const requestedId = selectedAfterAdvance ?? selectedId;
  const nextId = questions.find(question => question.questionId === requestedId)?.questionId ?? questions[0]?.questionId;
  if (!sameSession || nextId !== selectedId) setSelection(nextId);
  // 旧版を使うブラウザでも質問集の控えを復元できる形式で保存する。
  if (newDeck && questions.length) storageSet(localStorage, backupKey, JSON.stringify(deckData(legacyDeckFormat)));
  else if (newDeck && sameSession) storageSet(localStorage, backupKey, null);
  $('workspace').hidden = false;
  copyLink.disabled = false;
  openPresent.disabled = false;
  updateBackupControls();
  $('add', HTMLButtonElement).disabled = questions.length >= 50;
  updateEraseDialog(next);
  updatePreflight();
  render();
  void refreshComments();
}

function updateBackupControls() {
  const hasBackup = Boolean(storageGet(localStorage, backupKey));
  $('restore').hidden = items().length > 0 || !hasBackup;
  $('clear-backup').hidden = !hasBackup;
}

function render() {
  const state = currentState();
  const questions = items();
  const openCount = questions.filter(question => question.isOpen).length;
  const metrics: [string, number][] = [
    ['質問・お題', questions.length],
    ['受付中', openCount],
    ['結果公開済み', state.questions.filter(question => question.resultsPublished).length]
  ];
  const overview = metrics.map(([label, count]) => el('div', { cls: 'metric' },
    el('span', { text: label }), el('strong', { text: count })));
  $('overview').replaceChildren(...overview);

  const active = document.activeElement;
  const focused = active instanceof HTMLElement ? active.dataset.focus : undefined;
  $('questions').replaceChildren(...questions.map((question, index) => {
    const row = button('', () => showQuestion(question.questionId), 'question-row');
    row.setAttribute('aria-pressed', String(selectedId === question.questionId));
    row.dataset.focus = 'question-' + question.questionId;
    row.append(el('span', { cls: 'question-index', text: String(index + 1).padStart(2, '0') }),
      el('span', { cls: 'question-row-content' }, el('strong', { text: question.text }),
        el('small', { text: formatLabel(question) + ' · ' + (question.type === 'discussion'
          ? question.commentCount + '件のコメント' : question.results.respondentCount + '人が回答') }),
        el('span', { cls: 'pills' }, statusPill(question.isOpen, question.everOpened),
          ...(selectedId === question.questionId
            ? [el('span', { cls: 'pill pill-purple', text: '選択中', attrs: { 'aria-hidden': 'true' } })] : []),
          ...(state.presentation.questionId === question.questionId
            ? [el('span', { cls: 'pill pill-stage', text: '発表中' })] : []))));
    return row;
  }));
  if (!questions.length) {
    $('questions').append(el('p', { cls: 'list-empty muted', text: '質問はまだありません。' }));
    $('detail').replaceChildren(emptyState('最初の質問を作成', '質問を追加するか、保存した質問集を読み込んでください。'));
  } else {
    const selected = questions.find(question => question.questionId === selectedId);
    if (selected) renderDetail(selected, openCount, focused);
  }
  if (focused && document.activeElement === document.body) {
    const targets = document.querySelectorAll<HTMLElement>('[data-focus]:not(:disabled)');
    let target = [...targets].find(element => element.dataset.focus === focused);
    if (!target && focused === 'next-question') {
      target = [...targets].find(element => element.dataset.focus === 'question-' + state.presentation.questionId);
    }
    target?.focus({ preventScroll: true });
  }
}

function action(label: string, handler: (event: MouseEvent) => void, cls?: string, disabled?: boolean, focusKey = label) {
  const element = button(label, handler, cls, disabled);
  element.dataset.focus = focusKey;
  return element;
}

function formatLabel(question: AdminItem) {
  return question.type === 'discussion' ? 'コメント' : question.type === 'single' ? '単一選択' : '複数選択';
}

function detailHeading(question: AdminItem, inPresentation: boolean) {
  const metadata = question.type === 'discussion'
    ? (question.settings.moderationMode === 'manual' ? '事前審査' : '即時公開')
      + ' · 投稿上限 ' + (question.settings.maxPostsPerToken === 'unlimited'
        ? '制限なし' : question.settings.maxPostsPerToken + '件')
    : styleLabels[question.style];
  const status = el('div', { cls: 'pills', attrs: { 'aria-label': '現在の状態' } },
    statusPill(question.isOpen, question.everOpened));
  if (question.type !== 'discussion') status.append(el('span', {
    cls: 'pill ' + (question.resultsPublished ? 'pill-purple' : 'pill-muted'),
    text: question.resultsPublished ? '結果公開済み' : '結果非公開'
  }));
  status.append(el('span', { cls: 'pill ' + (inPresentation ? 'pill-stage' : 'pill-muted'),
    text: inPresentation ? '発表中' : '発表対象外' }));
  return el('header', { cls: 'detail-heading' },
    el('div', { cls: 'detail-header-row' }, status, action('編集', () => showEditor(question), 'compact')),
    el('h2', { text: question.text }),
    el('p', { cls: 'detail-meta', text: formatLabel(question) + ' · ' + metadata }));
}

function advanceControls(id: string, index: number, inPresentation: boolean, openCount: number) {
  const { sessionId, deckRevision } = currentState();
  const next = items()[index + 1];
  const advance = action('次へ', () => control({ action: 'advance', questionId: id, sessionId, deckRevision }),
    'accent-button', !inPresentation || !next, 'next-question');
  advance.setAttribute('aria-describedby', 'advance-help');
  const hint = !inPresentation ? '発表中の質問から次へ進めます。' : next
    ? 'この受付を終了し、次の質問の受付を開始して発表します。'
    : 'これが最後の質問です。';
  return el('div', { cls: 'advance-controls' }, advance,
    el('div', {}, el('p', { text: hint, attrs: { id: 'advance-help' } }),
      ...(inPresentation && next ? [el('p', { cls: 'advance-target', text: next.text })] : []),
      ...(openCount > 1 ? [el('p', {
        cls: 'multi-open-note', text: openCount + '問を受付中です。ほかの質問の受付状態は維持されます。'
      })] : [])));
}

function management(question: AdminItem, index: number, ...controls: HTMLElement[]) {
  const id = question.questionId;
  const previous = document.querySelector<HTMLDetailsElement>('#detail .question-management');
  const disclosure = el('details', { cls: 'question-management' },
    el('summary', { text: '設定・管理', attrs: { 'data-focus': 'question-management' } }),
    ...controls,
    el('div', { cls: 'actions question-tools' },
      action('↑ 上へ', () => moveQuestion(index, -1), 'compact', index === 0),
      action('↓ 下へ', () => moveQuestion(index, 1), 'compact', index === items().length - 1)));
  disclosure.dataset.question = id;
  // 定期更新でも、同じ質問の管理欄とキーボードの位置を保つ。
  disclosure.open = previous?.dataset.question === id && previous.open;
  return disclosure;
}

function renderDetail(question: AdminItem, openCount: number, focused?: string) {
  if (question.type === 'discussion') return renderDiscussion(question, openCount, focused);
  const state = currentState();
  const id = question.questionId;
  const inPresentation = state.presentation.questionId === id;
  const index = items().findIndex(item => item.questionId === id);
  const controls = el('section', { cls: 'progress-controls', attrs: { 'aria-label': '進行操作' } },
    el('h3', { text: '進行操作' }),
    el('div', { cls: 'actions' },
      action(question.isOpen ? '受付を終了' : '受付を開始して発表',
        () => control({ action: question.isOpen ? 'close' : 'open', questionId: id }), question.isOpen ? '' : 'primary', false, 'toggle-reception'),
      action('発表する質問に選択', () => control({ action: 'select', questionId: id }), '', inPresentation),
      action(question.resultsPublished ? '結果を非公開' : '結果を公開',
        () => control({ action: question.resultsPublished ? 'unpublish' : 'publish', questionId: id }),
        '', !question.everOpened, 'toggle-results')));
  if (inPresentation) {
    controls.append(el('div', { cls: 'presentation-controls' }, el('span', { text: '発表モード' }),
      el('div', { cls: 'segmented', attrs: { role: 'group', 'aria-label': '発表モード' } },
        modeButton('質問モード', 'question'), modeButton('可視化モード', 'results', !question.everOpened))));
  }
  controls.append(advanceControls(id, index, inPresentation, openCount));
  const tally = el('section', { cls: 'tally' }, el('h3', { text: '選択肢と回答状況' }),
    chart(question.results, question.style, question.type));
  const tools = management(question, index, el('div', { cls: 'actions question-tools' },
    action('票をリセット', () => {
      if (window.confirm('この質問の票をすべてリセットしますか？')) {
        control({ action: 'reset-votes', questionId: id, confirm: true });
      }
    }, 'compact'),
    action('質問を削除', () => {
      if (window.confirm('この質問を削除しますか？ この質問の票も消去されます。')) {
        saveDeck(items().filter(item => item.questionId !== id).map(draft), { confirmReset: true });
      }
    }, 'danger-link compact')));
  $('detail').replaceChildren(detailHeading(question, inPresentation), controls, tally, tools);
}

function renderDiscussion(topic: AdminDiscussion, openCount: number, focused?: string) {
  const state = currentState();
  const index = items().findIndex(item => item.questionId === topic.questionId);
  const context = { sessionId: state.sessionId, questionId: topic.questionId, discussionRevision: topic.discussionRevision };
  const inPresentation = state.presentation.questionId === topic.questionId;
  const controls = el('section', { cls: 'progress-controls', attrs: { 'aria-label': '進行操作' } },
    el('h3', { text: '進行操作' }),
    el('div', { cls: 'actions' },
      action(topic.isOpen ? '受付を緊急停止' : '受付を開始',
        () => control({ action: topic.isOpen ? 'close' : 'open', questionId: topic.questionId }),
        topic.isOpen ? 'danger-link emergency' : 'primary', false, 'toggle-reception'),
      action('コメント一覧を発表', () => discussionControl({ ...context, action: 'list' }), '', !topic.everOpened)),
    advanceControls(topic.questionId, index, inPresentation, openCount));
  const hidePresented = el('input', { attrs: { type: 'checkbox', 'data-focus': 'hide-presented' } });
  hidePresented.checked = topic.presentation.hidePresented;
  const freezeOrder = el('input', { attrs: { type: 'checkbox', 'data-focus': 'freeze-order' } });
  freezeOrder.checked = topic.presentation.freezeOrder;
  hidePresented.disabled = freezeOrder.disabled = !topic.everOpened;
  const configure = async () => {
    const saved = await discussionControl({ ...context, action: 'configure',
      hidePresented: hidePresented.checked, freezeOrder: freezeOrder.checked });
    if (!saved) render();
  };
  hidePresented.addEventListener('change', configure);
  freezeOrder.addEventListener('change', configure);
  const displaySettings = el('div', { cls: 'actions discussion-display-settings' },
    el('label', {}, hidePresented, document.createTextNode('紹介済みを一覧から除く')),
    el('label', {}, freezeOrder, document.createTextNode('発表の並び順を固定')));
  const tools = management(topic, index, displaySettings,
    el('div', { cls: 'actions question-tools' },
      action('お題を削除', () => {
        if (window.confirm('このお題とコメント・いいねをすべて削除しますか？ 復元できません。')) {
          void saveDeck(items().filter(item => item.questionId !== topic.questionId).map(draft), { confirmReset: true });
        }
      }, 'danger-link compact')));
  const comments = el('section', { cls: 'moderation' },
    el('h3', { text: 'コメントの審査' }),
    el('p', { text: '受付停止後も審査できます。紹介済みのコメントは参加者の公開一覧に残ります。' }),
    el('div', { attrs: { id: 'admin-comments' } }));
  $('detail').replaceChildren(detailHeading(topic, inPresentation), controls, comments, tools);
  renderComments(focused);
}

function renderComments(previousFocus?: string) {
  const container = document.getElementById('admin-comments');
  if (!container || !state) return;
  const active = document.activeElement;
  const focusKey = active instanceof HTMLElement && container.contains(active) ? active.dataset.focus : previousFocus;
  const focused = focusKey?.startsWith('comment-') || focusKey?.startsWith('moderation-') ? focusKey : undefined;
  const topic = state.discussions.find(item => item.questionId === selectedId);
  const snapshot = commentSnapshot;
  if (!topic || !snapshot || snapshot.sessionId !== state.sessionId || snapshot.questionId !== selectedId ||
      snapshot.discussionRevision !== topic.discussionRevision) {
    const loading = el('p', { text: 'コメントを取得しています…', attrs: { tabindex: '-1', role: 'status' } });
    container.replaceChildren(loading);
    if (focused) {
      loading.dataset.focus = focused;
      loading.focus({ preventScroll: true });
    }
    return;
  }
  const tabs = el('div', { cls: 'actions moderation-filters', attrs: { role: 'group', 'aria-label': 'コメントの公開状態' } });
  const labels = { pending: '承認待ち', published: '公開中', hidden: '非公開' };
  for (const visibility of ['pending', 'published', 'hidden'] as const) {
    const count = snapshot.comments.filter(item => item.visibility === visibility).length;
    const tab = button(labels[visibility] + ' (' + count + ')', () => {
      commentFilter = visibility;
      renderComments();
    }, 'compact');
    tab.dataset.focus = 'moderation-' + visibility;
    tab.setAttribute('aria-pressed', String(commentFilter === visibility));
    tabs.append(tab);
  }
  const rows = snapshot.comments.filter(item => item.visibility === commentFilter).map(comment => {
    const update = async (action: CommentControlInput['action']) => {
      if (action === 'delete' && !window.confirm('このコメントの本文・いいねを完全に削除しますか？ 復元できません。')) return;
      await run(async () => {
        // 画面で確認したセッション・お題・公開状態を送り、古い画面からの操作を検出する。
        commentGeneration++;
        try {
          applyState(await request('/api/admin/comments/control', key, { method: 'POST', data: {
            sessionId: snapshot.sessionId, questionId: snapshot.questionId,
            discussionRevision: snapshot.discussionRevision, commentId: comment.commentId,
            action, expectedVisibility: comment.visibility, ...(action === 'delete' && { confirm: true })
          } }));
        } finally {
          commentSnapshot = undefined;
          renderComments();
          void refreshComments();
        }
      });
    };
    const actions = el('div', { cls: 'actions moderation-actions' });
    if (comment.visibility === 'published') {
      const context = { sessionId: snapshot.sessionId, questionId: snapshot.questionId,
        discussionRevision: snapshot.discussionRevision, commentId: comment.commentId };
      const focused = state?.presentation.questionId === topic.questionId
        && topic.presentation.focusedCommentId === comment.commentId;
      // サーバーの現在値から表示を決め、解除は明示的な一覧操作にする。再送でも二重反転しない。
      const focusButton = button(focused ? '拡大を解除' : '発表で拡大', () => void discussionControl(focused
        ? { sessionId: snapshot.sessionId, questionId: snapshot.questionId,
          discussionRevision: snapshot.discussionRevision, action: 'list' }
        : { ...context, action: 'focus' }), 'compact');
      focusButton.setAttribute('aria-pressed', String(focused));
      const presentedButton = button(comment.presented ? '紹介済みを解除' : '紹介済みにする',
        () => void discussionControl({ ...context, action: 'set-presented', presented: !comment.presented }), 'quiet compact');
      presentedButton.setAttribute('aria-pressed', String(comment.presented));
      actions.append(focusButton, presentedButton);
    }
    if (comment.visibility !== 'published') actions.append(button(comment.visibility === 'pending' ? '承認して公開' : '再公開',
      () => void update('publish'), 'accent-button compact'));
    if (comment.visibility !== 'hidden') actions.append(button('非公開', () => void update('hide'), 'quiet compact'));
    actions.append(button('削除', () => void update('delete'), 'danger-link compact'));
    // ラベルが変わる切り替え操作も、同じ投稿と操作位置にフォーカスを戻す。
    [...actions.querySelectorAll('button')].forEach((control, index) => {
      control.dataset.focus = 'comment-' + comment.commentId + '-' + index;
    });
    // 投稿本文を HTML として解析せず、textContent 経由で表示する。
    return el('article', { cls: 'discussion-comment' }, el('p', { cls: 'discussion-body', text: comment.body }),
      el('div', { cls: 'pills' },
        el('span', { cls: 'pill moderation-' + comment.visibility, text: labels[comment.visibility] }),
        ...(comment.presented ? [el('span', { cls: 'pill pill-stage', text: '紹介済み' })] : []),
        el('span', { cls: 'muted comment-like-count', text: 'いいね ' + comment.likes + '件' })),
      actions);
  });
  container.replaceChildren(tabs, ...rows,
    ...(rows.length ? [] : [el('p', { cls: 'moderation-empty', text: labels[commentFilter] + 'のコメントはありません。' })]));
  if (focused) {
    const target = [...container.querySelectorAll<HTMLButtonElement>('[data-focus]')].find(control => control.dataset.focus === focused)
      ?? tabs.querySelector<HTMLButtonElement>('[aria-pressed="true"]');
    target?.focus({ preventScroll: true });
  }
}

async function refreshComments() {
  const topic = state?.discussions.find(item => item.questionId === selectedId);
  if (!state || !topic || commentsLoading || $('workspace').hidden) return;
  const sessionId = state.sessionId;
  const generation = commentGeneration;
  commentsLoading = true;
  try {
    const next = await request(`/api/admin/comments?questionId=${encodeURIComponent(topic.questionId)}`, key);
    // 選択変更や削除のあとに遅れて届いた一覧で、消した本文を再表示しない。
    if (generation !== commentGeneration || state.sessionId !== sessionId || selectedId !== topic.questionId ||
        next.sessionId !== sessionId || next.discussionRevision !== topic.discussionRevision) return;
    const changed = JSON.stringify(commentSnapshot) !== JSON.stringify(next);
    commentSnapshot = next;
    // 内容が同じポーリングでは DOM を作り直さず、キーボードのフォーカスを保つ。
    if (changed) renderComments();
  } catch {
    if (generation === commentGeneration && selectedId === topic.questionId) {
      commentSnapshot = undefined;
      document.getElementById('admin-comments')?.replaceChildren(el('p', { cls: 'notice',
        text: 'コメントを取得できません。接続を確認しています。' }));
    }
  } finally {
    commentsLoading = false;
    // 選択が変わっていたら、次の定期更新を待たずに移動先のコメントを取得する。
    if (state.sessionId !== sessionId || selectedId !== topic.questionId) void refreshComments();
  }
}

setInterval(() => void refreshComments(), 2500);

function discussionControl(data: DiscussionControlInput) {
  return run(async () => {
    commentGeneration++;
    try {
      applyState(await request('/api/admin/discussions/control', key, { method: 'POST', data }));
    } finally {
      commentSnapshot = undefined;
      renderComments();
      void refreshComments();
    }
  });
}

function modeButton(label: string, mode: Presentation['mode'], disabled?: boolean) {
  const element = action(label, () => control({ action: mode === 'results' ? 'show-results' : 'show-question' }),
    'compact', disabled);
  element.setAttribute('aria-pressed', String(currentState().presentation.mode === mode));
  return element;
}

async function run(operation: () => Promise<void>, errorTarget = $('notice')) {
  if (busy) return false;
  busy = true;
  try {
    message('', errorTarget);
    await operation();
    return true;
  } catch (error) {
    message(errorMessage(error, '操作を完了できませんでした。'), errorTarget);
    return false;
  } finally {
    busy = false;
  }
}

function control(data: ControlInput) {
  return run(async () => {
    const next = await request('/api/admin/control', key, { method: 'POST', data });
    const selectedAfterAdvance = data.action === 'advance' && state?.sessionId === data.sessionId &&
      selectedId === data.questionId ? next.presentation.questionId ?? undefined : undefined;
    applyState(next, selectedAfterAdvance);
  });
}

function renderExpiry() {
  if (expiryDeadline === undefined) return;
  const seconds = Math.max(0, Math.ceil((expiryDeadline - performance.now()) / 1000));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor(seconds / 60) % 60;
  const remaining = hours ? hours + '時間' + minutes + '分' : minutes + '分';
  const label = seconds <= 5 * 60 ? remaining + seconds % 60 + '秒' : '約' + remaining;
  if (expiryRemaining.textContent !== label) expiryRemaining.textContent = label;
  const warning = seconds === 0 ? '自動消去の予定時刻を過ぎました。セッションの更新を待っています。'
    : seconds <= 5 * 60 ? '自動消去まで5分以内です。必要なら有効期限を延長してください。'
      : seconds <= 30 * 60 ? '自動消去まで30分以内です。' : '';
  if (expiryWarning.textContent !== warning) message(warning, expiryWarning);
  expiryWarning.classList.toggle('urgent', seconds <= 5 * 60);
}

setInterval(renderExpiry, 1000);
extendExpiry.addEventListener('click', async () => {
  if (!state || busy) return;
  extendExpiry.disabled = true;
  try {
    if (await control({ action: 'extend-expiry', sessionId: state.sessionId })) {
      message('有効期限を延長しました。');
    }
  } finally {
    extendExpiry.disabled = false;
  }
});

interface SaveOptions {
  replace?: boolean;
  confirmReset?: boolean;
  deckRevision?: number;
  errorTarget?: HTMLElement;
}

function saveDeck(questions: unknown[], {
  replace, confirmReset, deckRevision = currentState().deckRevision, errorTarget
}: SaveOptions = {}) {
  return run(async () => {
    const data = { questions, deckRevision, replace, confirmReset };
    const send = () => request('/api/admin/deck', key, { method: 'PUT', data });
    let next;
    try {
      next = await send();
    } catch (error) {
      if (!(error instanceof RequestError) || error.code !== 'confirm_reset') throw error;
      if (!window.confirm('この操作で対象の票・コメント・いいねが消去され、復元できません。続けますか？')) return;
      data.confirmReset = true;
      next = await send();
    }
    applyState(next);
    if (errorTarget) editor.close();
    if (replace) message('質問集を読み込みました。');
  }, errorTarget);
}

function moveQuestion(index: number, offset: number) {
  const questions = items().map(draft);
  const [question] = questions.splice(index, 1);
  questions.splice(index + offset, 0, question);
  saveDeck(questions);
}

async function reloadDeck(raw: string | null) {
  try {
    const data: unknown = JSON.parse(raw ?? 'null');
    if (!isRecord(data) || (data.format !== deckFormat && data.format !== legacyDeckFormat)
        || data.version !== 1 || !Array.isArray(data.questions)) {
      throw new Error('PochiPoll の質問集 JSON を選んでください。');
    }
    // ファイル全体の形式をここで確認し、個々の質問はサーバーで検証する。
    if (items().length && !window.confirm('現在の質問集を置き換えますか？ 受付と公開状態は初期化されます。')) return;
    await saveDeck(data.questions, { replace: true });
  } catch (error) {
    message(error instanceof SyntaxError ? '質問集のJSON形式を確認してください。'
      : errorMessage(error, '質問集を読み込めませんでした。'));
  }
}

function syncOptions() {
  const count = optionFields.children.length;
  [...optionFields.children].forEach((row, index) => {
    const number = row.querySelector('span');
    if (number) number.textContent = String(index + 1);
    row.querySelector('input')?.setAttribute('aria-label', '選択肢 ' + (index + 1));
    const remove = row.querySelector('button');
    if (remove) {
      remove.setAttribute('aria-label', '選択肢 ' + (index + 1) + ' を削除');
      remove.disabled = count <= 2;
    }
  });
  $('add-option', HTMLButtonElement).disabled = count >= 8;
  updateStyles();
}

function updateStyles(preferred = questionStyle.value) {
  const discussion = questionType.value === 'discussion';
  $('discussion-settings').hidden = !discussion;
  $('choice-settings', HTMLFieldSetElement).disabled = discussion;
  $('choice-settings').hidden = discussion;
  $('graph-field').hidden = discussion;
  const single = questionType.value === 'single';
  const count = optionFields.children.length;
  const choices: GraphStyle[] = ['horizontal', 'vertical'];
  if (single && count <= 6) choices.push('donut');
  if (single && count <= 4) choices.push('stacked');
  questionStyle.replaceChildren(...choices.map(value =>
    el('option', { text: styleLabels[value], attrs: { value } })));
  questionStyle.value = choices.some(style => style === preferred) ? preferred : 'horizontal';
}

function addOption(value = '') {
  const input = el('input', { attrs: { type: 'text', required: '', placeholder: '選択肢を入力' } });
  input.value = value;
  const row = el('div', { cls: 'option-field' }, el('span'), input,
    button('×', () => { row.remove(); syncOptions(); }, 'icon'));
  optionFields.append(row);
  return input;
}

function showEditor(question?: DeckItem) {
  editing = { id: question?.questionId, deckRevision: currentState().deckRevision };
  $('editor-title').textContent = question ? '質問を編集' : '質問を追加';
  questionText.value = question?.text ?? '';
  questionType.value = question?.type ?? 'single';
  optionFields.replaceChildren();
  (question && question.type !== 'discussion' ? question.options : ['', '']).forEach(addOption);
  $('moderation-mode', HTMLSelectElement).value = question?.type === 'discussion' ? question.settings.moderationMode : 'manual';
  $('post-limit', HTMLSelectElement).value = String(question?.type === 'discussion' ? question.settings.maxPostsPerToken : 3);
  syncOptions();
  updateStyles(question && question.type !== 'discussion' ? question.style : undefined);
  message('', $('edit-error'));
  editor.showModal();
}

function isGraphStyle(value: string): value is GraphStyle {
  return Object.hasOwn(styleLabels, value);
}

editForm.addEventListener('submit', async event => {
  event.preventDefault();
  if (!editing) return;
  const type = questionType.value;
  const style = questionStyle.value;
  if ((type !== 'discussion' && type !== 'single' && type !== 'multiple') || !isGraphStyle(style)) {
    return message('回答形式とグラフを選んでください。', $('edit-error'));
  }
  const { id, deckRevision } = editing;
  const moderationMode = $('moderation-mode', HTMLSelectElement).value;
  const limit = $('post-limit', HTMLSelectElement).value;
  if (moderationMode !== 'manual' && moderationMode !== 'instant') return;
  if (limit !== '1' && limit !== '3' && limit !== 'unlimited') return;
  const question: DeckItem = type === 'discussion' ? {
    questionId: id ?? crypto.randomUUID(), text: questionText.value, type,
    settings: { moderationMode, maxPostsPerToken: limit === 'unlimited' ? limit : limit === '1' ? 1 : 3 }
  } : {
    questionId: id ?? crypto.randomUUID(), text: questionText.value, type,
    options: [...optionFields.querySelectorAll('input')].map(input => input.value),
    style
  };
  const questions = items().map(item => item.questionId === id ? question : draft(item));
  if (!id) questions.push(question);
  if (submitEdit.disabled) return;
  const closeButtons = [$('cancel-edit', HTMLButtonElement), $('cancel-edit-footer', HTMLButtonElement)];
  const fields = [...editForm.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement | HTMLButtonElement>(
    'input, select, textarea, fieldset button')].filter(field => !field.disabled);
  submitEdit.disabled = true;
  submitEdit.textContent = '保存中…';
  editForm.setAttribute('aria-busy', 'true');
  for (const control of [...closeButtons, ...fields]) control.disabled = true;
  try {
    await saveDeck(questions, { deckRevision, errorTarget: $('edit-error') });
  } finally {
    submitEdit.disabled = false;
    submitEdit.textContent = '質問を保存';
    editForm.removeAttribute('aria-busy');
    for (const control of [...closeButtons, ...fields]) control.disabled = false;
  }
  if (editor.open) {
    submitEdit.focus({ preventScroll: true });
  } else {
    showQuestion(question.questionId);
    const selectedRow = $('questions').querySelector<HTMLButtonElement>('[aria-pressed="true"]');
    selectedRow?.focus();
  }
});
editor.addEventListener('cancel', event => {
  if (submitEdit.disabled) event.preventDefault();
});
questionType.addEventListener('change', () => updateStyles());
$('add-option').addEventListener('click', () => { const input = addOption(); syncOptions(); input.focus(); });
$('cancel-edit').addEventListener('click', () => editor.close());
$('cancel-edit-footer').addEventListener('click', () => editor.close());
$('add').addEventListener('click', () => showEditor());
$('restore').addEventListener('click', () => reloadDeck(storageGet(localStorage, backupKey)));
$('clear-backup').addEventListener('click', () => {
  if (window.confirm('このブラウザの質問集の控えを削除しますか？')) {
    if (!storageSet(localStorage, backupKey, null)) return message('控えを削除できませんでした。');
    updateBackupControls();
    message('このブラウザの控えを削除しました。');
  }
});
importInput.addEventListener('change', async () => {
  const file = importInput.files?.[0];
  importInput.value = '';
  if (!file) return;
  if (file.size > 256 * 1024) return message('質問集は256KBまで読み込めます。');
  try { await reloadDeck(await file.text()); }
  catch { message('質問集を読み込めませんでした。'); }
});
$('deck-download').addEventListener('click', () => {
  downloadFile(deckFormat + '.json', new Blob([JSON.stringify(deckData(), null, 2)], { type: 'application/json' }));
});

function updateEraseDialog(next: AdminState) {
  if (!eraseDialog.open) return;
  // 複数選択でも、選んだ選択肢の数ではなく質問ごとの回答者数を足す。
  const counts = next.questions.map(question => question.results.respondentCount);
  const total = counts.reduce((sum, count) => sum + count, 0);
  const commentCount = next.discussions.reduce((sum, topic) => sum + topic.commentCount, 0);
  $('erase-questions').textContent = String(orderedItems(next).length);
  $('erase-comments').textContent = String(commentCount);
  $('erase-answered').textContent = String(counts.filter(count => count > 0).length);
  $('erase-responses').textContent = String(total);
  $('erase-exports').hidden = total === 0 && commentCount === 0;
  $('erase-comments-download', HTMLButtonElement).disabled = eraseTarget !== next.sessionId || erasePending !== undefined;
  const changed = eraseTarget !== next.sessionId;
  $('erase-session-changed').hidden = !changed;
  eraseConfirm.disabled = changed || erasePending !== undefined;
  eraseConfirm.textContent = erasePending === 'erase' ? '消去中…' : '消去する';
  eraseCancel.disabled = erasePending === 'erase';
  for (const button of Object.values(eraseDownloads)) button.disabled = eraseConfirm.disabled;
}

async function saveResults(format: ExportFormat, sessionId?: string) {
  const path = sessionId === undefined ? `/api/admin/export?format=${format}` as const
    : `/api/admin/export?format=${format}&sessionId=${encodeURIComponent(sessionId)}` as const;
  const blob = await request(path, key, { download: true });
  if (sessionId === undefined || (eraseDialog.open && state?.sessionId === sessionId)) {
    downloadFile('pochipoll-results.' + format, blob);
  }
}

async function saveComments(sessionId: string) {
  if (!window.confirm('公開済みコメントだけを JSON に保存します。自由記述に個人情報等が含まれる可能性があります。保存先と共有範囲を確認してください。承認待ち・非公開・削除済みの本文は含まれません。')) return;
  const blob = await request(`/api/admin/export-comments?sessionId=${encodeURIComponent(sessionId)}`, key, { download: true });
  if (state?.sessionId !== sessionId) throw new Error('セッションが切り替わったため、保存を中止しました。');
  downloadFile('pochipoll-comments.json', blob);
  message('コメント JSON をダウンロードしました。保存先をご確認ください。ブラウザから保存完了は確認できません。');
}

$('comments-download').addEventListener('click', () => {
  const sessionId = currentState().sessionId;
  void run(() => saveComments(sessionId));
});
$('erase-comments-download').addEventListener('click', () => withEraseTarget('export', saveComments));

async function withEraseTarget(
  kind: 'erase' | 'export', operation: (sessionId: string) => Promise<void>
) {
  const sessionId = eraseTarget;
  if (!sessionId || !state || state.sessionId !== sessionId || !eraseDialog.open || busy) return;
  erasePending = kind;
  updateEraseDialog(state);
  try {
    await run(async () => {
      try {
        await operation(sessionId);
      } catch (error) {
        if (!(error instanceof RequestError) || error.status !== 409) throw error;
        // ポーリングより先に競合を受信した場合も、古い確認を再利用させない。
        eraseTarget = null;
      }
    }, eraseError);
  } finally {
    erasePending = undefined;
    updateEraseDialog(currentState());
  }
}

for (const format of ['csv', 'json'] as const) {
  $(format + '-download').addEventListener('click', () => run(() => saveResults(format)));
  eraseDownloads[format].addEventListener('click', () => withEraseTarget('export', id => saveResults(format, id)));
}
$('erase').addEventListener('click', () => {
  if (!state || busy || eraseDialog.open) return;
  eraseTarget = state.sessionId;
  message('', eraseError);
  eraseDialog.showModal();
  updateEraseDialog(state);
});
eraseCancel.addEventListener('click', () => eraseDialog.close());
eraseDialog.addEventListener('cancel', event => {
  if (erasePending === 'erase') event.preventDefault();
});
eraseConfirm.addEventListener('click', () => withEraseTarget('erase', async sessionId => {
  const next = await request('/api/admin/control', key, {
    method: 'POST', data: { action: 'erase', confirm: true, sessionId }
  });
  eraseDialog.close();
  applyState(next);
}));
$('notice-dismiss').addEventListener('click', event => {
  if (document.activeElement === event.currentTarget) {
    (copyLink.disabled ? $('preflight') : copyLink).focus({ preventScroll: true });
  }
  message('');
});
if (!canShareParticipantUrl) copyLink.textContent = 'この端末用の参加URLをコピー';
copyLink.addEventListener('click', () => run(async () => {
  await navigator.clipboard.writeText(participantUrl(currentState().participantCode));
  message(canShareParticipantUrl ? '参加URLをコピーしました。'
    : 'この端末用の参加URLをコピーしました。別端末からの参加には、HTTPSで公開したURLを使ってください。');
}));
openPresent.addEventListener('click', () => {
  window.open('/present#' + currentState().presentationToken, '_blank', 'noopener,noreferrer');
});

poll('/api/admin/state', key, { interval: 0, onState: applyState, onConnection: updatePreflight, onInvalid: text => {
  storageSet(sessionStorage, 'fakeslido:admin', null);
  $('workspace').hidden = true;
  $('overview').replaceChildren();
  copyLink.disabled = true;
  openPresent.disabled = true;
  eraseDialog.close();
  expiryDeadline = undefined;
  commentSnapshot = undefined;
  commentGeneration++;
  message(text);
} });
