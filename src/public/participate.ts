import {
  $, el, button, message, request, poll, readFragment, storageGet, storageSet, emptyState, statusPill,
  connection, isRecord, RequestError
} from './common.js';
import { chart } from './charts.js';
import { createDiscussionView } from './participant-discussion.js';
import type { PublicDiscussion, PublicQuestion, PublicResults, PublicState, VoteInput } from '../types.js';

const storageKey = 'fakeslido:participant';
const lifetime = 24 * 60 * 60 * 1000;
const codePattern = /^[A-Za-z0-9_-]{22}$/;
const voterPattern = /^[A-Za-z0-9_-]{43}$/;

interface SavedAnswer {
  voteRevision: number;
  choices: number[];
}

interface ParticipantRecord {
  code: string;
  sessionId: string;
  voterToken: string;
  expiresAt: number;
  answers: Record<string, SavedAnswer>;
}

interface VoteAttempt {
  sessionId: string;
  input: VoteInput;
  selections: number[];
}

// 未確認の送信はページ内だけに保持する。受理を確認するまで回答の控えに書かない。
const retryVotes = new Map<string, { attempt: VoteAttempt; hint: string }>();
const discussionViews = new Map<string, ReturnType<typeof createDiscussionView>>();

function voterToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}

// localStorage の JSON は unknown。以前の保存キーと形を維持し、読める回答だけを復元する。
function readRecord(): ParticipantRecord | null {
  try {
    const saved: unknown = JSON.parse(storageGet(localStorage, storageKey) ?? 'null');
    if (isRecord(saved)) {
      const { code, sessionId, voterToken, expiresAt, answers: storedAnswers } = saved;
      if (typeof code === 'string' && codePattern.test(code) && typeof sessionId === 'string'
        && typeof voterToken === 'string' && voterPattern.test(voterToken)
        && typeof expiresAt === 'number' && Number.isFinite(expiresAt) && expiresAt > Date.now()
        && isRecord(storedAnswers)) {
        const answers: Record<string, SavedAnswer> = Object.create(null);
        for (const [id, answer] of Object.entries(storedAnswers)) {
          if (!isRecord(answer)) continue;
          const { voteRevision, choices } = answer;
          if (typeof voteRevision === 'number' && Number.isSafeInteger(voteRevision)
            && Array.isArray(choices) && choices.length > 0 && choices.every((choice: unknown): choice is number =>
              typeof choice === 'number' && Number.isSafeInteger(choice) && choice > 0)) {
            answers[id] = { voteRevision, choices };
          }
        }
        return { code, sessionId, voterToken, expiresAt, answers };
      }
    }
  } catch {
    // 解析できない控えは、新しいセッションの回答に使わない。
  }
  storageSet(localStorage, storageKey, null);
  return null;
}

const saved = readRecord();
const fragment = readFragment();
const code = fragment || saved?.code || '';
if (fragment && fragment !== saved?.code) storageSet(localStorage, storageKey, null);
let record: ParticipantRecord | null = saved?.code === code ? saved : null;
let state: PublicState | null = null;
let selectedId: string | undefined;
let editing = false;
let choices: number[] = [];
let sendingQuestionId: string | undefined;
let voteNotBefore = 0;
let sessionInvalid = false;
let results: PublicResults | null = null;
let resultRequest = 0;

function persist(record: ParticipantRecord) {
  if (!storageSet(localStorage, storageKey, JSON.stringify(record))) {
    message('ブラウザに回答の控えを保存できません。この画面を開いている間は回答を確認できます。');
  }
}

function invalid(text: string) {
  if (readRecord()?.code === code) storageSet(localStorage, storageKey, null);
  record = null;
  state = null;
  sessionInvalid = true;
  retryVotes.clear();
  for (const view of discussionViews.values()) view.dispose();
  discussionViews.clear();
  connection('未接続', true);
  message('');
  resultRequest++;
  $('question-nav').hidden = true;
  $('ballot').replaceChildren(emptyState('投票に接続できません', text));
}

function ensureRecord(sessionId: string): ParticipantRecord {
  const latest = readRecord();
  if (latest?.sessionId === sessionId && latest.code === code
    && (!record || latest.voterToken === record.voterToken || record.expiresAt <= Date.now())) {
    record = latest;
  }
  if (record?.sessionId === sessionId && record.expiresAt > Date.now()) return record;
  record = {
    code, sessionId, voterToken: voterToken(), expiresAt: Date.now() + lifetime, answers: Object.create(null)
  };
  persist(record);
  return record;
}

function currentQuestion() {
  return state?.questions.find(question => question.questionId === selectedId);
}

function orderedQuestions(state: PublicState) {
  const questions: (PublicQuestion | PublicDiscussion)[] = [...state.questions];
  // お題の位置は公開済みの質問とお題を合わせた順番。順に差し込んで一つの一覧にする。
  for (const topic of state.discussions) questions.splice(topic.questionOrder - 1, 0, topic);
  return questions;
}

function refreshDiscussion() {
  if (selectedId !== undefined) void discussionViews.get(selectedId)?.refresh();
}

function ownAnswer(question: PublicQuestion): SavedAnswer | null {
  const answer = record?.answers[question.questionId];
  return answer?.voteRevision === question.voteRevision ? answer : null;
}

function pruneAnswers(record: ParticipantRecord, state: PublicState) {
  for (const [id, answer] of Object.entries(record.answers)) {
    const question = state.questions.find(item => item.questionId === id);
    if (!question || question.voteRevision !== answer?.voteRevision) delete record.answers[id];
  }
}

function retryBlock({ sessionId, input }: VoteAttempt): string | undefined {
  if (state?.sessionId !== sessionId || record?.voterToken !== input.voterToken || record.expiresAt <= Date.now()) {
    return '参加状態が変わりました。現在の質問を確認し、もう一度選択してください。';
  }
  const question = state.questions.find(item => item.questionId === input.questionId);
  if (question && !question.isOpen) return 'この質問の投票受付は終了しました。';
  if (question?.voteRevision !== input.voteRevision) return '質問が更新されました。もう一度選択してください。';
}

function discardDraft(questionId: string, hint: string) {
  retryVotes.delete(questionId);
  if (selectedId !== questionId) return;
  choices = [];
  editing = false;
  message(hint);
}

function pruneRetries() {
  for (const [id, { attempt }] of retryVotes) {
    const reason = retryBlock(attempt);
    if (reason) discardDraft(id, reason);
  }
}

async function applyState(next: PublicState) {
  const sameSession = state?.sessionId === next.sessionId;
  if (sessionInvalid || (sameSession && state && next.revision < state.revision)) return;
  const record = ensureRecord(next.sessionId);
  const previous = currentQuestion();
  state = next;
  for (const [id, view] of discussionViews) {
    if (!sameSession || !next.discussions.some(topic => topic.questionId === id)) {
      view.dispose();
      discussionViews.delete(id);
    }
  }
  pruneRetries();
  const priorAnswers = Object.keys(record.answers).length;
  pruneAnswers(record, next);
  if (Object.keys(record.answers).length !== priorAnswers) persist(record);
  const questions = orderedQuestions(next);
  if (!questions.some(question => question.questionId === selectedId)) {
    selectedId = questions.find(question => question.isOpen)?.questionId ?? questions[0]?.questionId;
    editing = false;
    choices = [];
  }
  const question = currentQuestion();
  if (previous && (!question?.isOpen || previous.voteRevision !== question.voteRevision)) {
    editing = false;
    choices = [];
  }
  if (results?.question.questionId !== question?.questionId || !question?.resultsPublished
    || results?.question.voteRevision !== question?.voteRevision) results = null;
  render();
  refreshDiscussion();
  await updateResults();
}

function selectQuestion(id: string) {
  selectedId = id;
  const retry = retryVotes.get(id);
  const question = currentQuestion();
  editing = Boolean(retry && question && ownAnswer(question));
  choices = retry ? [...retry.attempt.selections] : [];
  message('');
  results = null;
  resultRequest++;
  render();
  refreshDiscussion();
  updateResults().catch(() => {});
}

function nav(state: PublicState) {
  const nav = $('question-nav');
  const questions = orderedQuestions(state);
  nav.hidden = !questions.length;
  const focused = document.activeElement instanceof HTMLButtonElement && nav.contains(document.activeElement)
    ? document.activeElement.dataset.question : undefined;
  nav.replaceChildren(...questions.map((question, index) => {
    const selected = selectedId === question.questionId;
    const label = question.type === 'discussion' ? 'お題 ' + (index + 1)
      : '質問 ' + (index + 1) + (ownAnswer(question) ? ' ✓' : '');
    const item = button(label, () => selectQuestion(question.questionId), 'compact');
    item.dataset.question = question.questionId;
    if (question.type !== 'discussion' && ownAnswer(question)) {
      item.setAttribute('aria-label', '質問 ' + (index + 1) + '、回答済み');
    }
    item.setAttribute('aria-current', selected ? 'true' : 'false');
    return item;
  }));
  if (focused) {
    [...nav.querySelectorAll('button')].find(item => item.dataset.question === focused)?.focus({ preventScroll: true });
  }
}

function render() {
  if (!state) return;
  nav(state);
  const panel = $('ballot');
  const topic = state.discussions.find(item => item.questionId === selectedId);
  if (topic && record) {
    const context = { topic, sessionId: state.sessionId, voterToken: record.voterToken };
    let view = discussionViews.get(topic.questionId);
    if (!view) {
      view = createDiscussionView(context, code, invalid, () => void refreshAfterConflict(topic.questionId));
      discussionViews.set(topic.questionId, view);
    }
    view.update(context);
    if (panel.firstElementChild !== view.element) panel.replaceChildren(view.element);
    return;
  }
  const question = currentQuestion();
  if (!question) {
    panel.replaceChildren(emptyState('質問の開始をお待ちください', '質問がオープンすると、この画面に表示されます。'));
    return;
  }
  const answer = ownAnswer(question);
  const active = document.activeElement;
  const focusKey = active instanceof HTMLElement && panel.dataset.question === question.questionId && panel.contains(active)
    ? active.dataset.ballotFocus : undefined;
  panel.dataset.question = question.questionId;
  const heading = el('div', { cls: 'ballot-heading' },
    el('div', { cls: 'pills' }, statusPill(question.isOpen),
      el('span', { cls: 'pill pill-muted', text: question.type === 'single' ? '単一選択' : '複数選択' })),
    el('h2', { text: question.text }));
  let content;
  if (answer && question.resultsPublished && !editing) {
    content = el('div', {}, receipt(question, answer),
      el('section', { cls: 'participant-results' }, el('h3', { text: '投票結果' }),
        results ? chart(results, question.style, question.type) : el('p', { text: '結果を読み込み中…' })));
  } else if (answer && !editing || !question.isOpen) {
    content = answer ? receipt(question, answer) : el('p', { attrs: { 'data-ballot-focus': 'status', tabindex: '-1' }, text: 'この質問の投票受付は終了しました。' });
  } else {
    content = ballotForm(question, answer);
  }
  panel.replaceChildren(heading, content);
  if (focusKey) {
    const targets = [...panel.querySelectorAll<HTMLElement>('[data-ballot-focus]:not(:disabled):not([hidden])')];
    const preferred = targets.find(element => element.dataset.ballotFocus === focusKey);
    const fallback = targets.find(element => element.dataset.ballotFocus === (sendingQuestionId === question.questionId || !question.isOpen ? 'status' : 'submit'))
      ?? targets.find(element => element.dataset.ballotFocus === 'status')
      ?? targets.find(element => element.dataset.ballotFocus === 'option-1');
    (preferred ?? fallback)?.focus({ preventScroll: true });
  }
}

function receipt(question: PublicQuestion, answer: SavedAnswer) {
  const optionList = el('ul', { cls: 'answer-list' },
    ...answer.choices.map(index => el('li', { text: question.options[index - 1] })));
  const change = button('回答を変更', () => {
    choices = [...answer.choices];
    editing = true;
    render();
    $('ballot').querySelector<HTMLInputElement>('input:checked')?.focus({ preventScroll: true });
  }, 'compact', sendingQuestionId !== undefined);
  change.dataset.ballotFocus = 'change';
  return el('div', { cls: 'receipt' },
    el('p', { cls: 'receipt-label', text: '✓ 回答済み', attrs: {
      'data-ballot-focus': 'status', tabindex: '-1', role: 'status'
    } }), el('h3', { text: 'あなたの回答' }), optionList,
    ...(question.isOpen ? [change] : []));
}

function ballotForm(question: PublicQuestion, answer: SavedAnswer | null) {
  const multiple = question.type === 'multiple';
  const form = el('form', { cls: 'vote-form' });
  const normalLabel = answer ? '変更を保存' : '投票する';
  const retry = retryVotes.get(question.questionId);
  const sendingHere = sendingQuestionId === question.questionId;
  const retryLabel = retry?.attempt.selections.length === 0 ? '回答の取り消しを再送信する' : '同じ回答を再送信する';
  const submit = el('button', { cls: 'primary',
    text: sendingHere ? '送信中…' : retry ? retryLabel : normalLabel,
    attrs: { type: 'submit', 'data-ballot-focus': 'submit' } });
  const status = el('p', { cls: retry && !sendingHere ? 'vote-status vote-retry' : 'vote-status', attrs: {
    'data-ballot-focus': 'status', tabindex: '-1', role: 'status', hidden: ''
  } });
  message(sendingHere ? '回答を送信しています。' : retry?.hint ?? '', status);
  submit.disabled = !canSubmitVote(question);
  const fields = el('fieldset', {}, el('legend', { cls: 'muted', text: multiple ? '当てはまる選択肢を選んでください。' : '選択肢を1つ選んでください。' }));
  for (const [index, text] of question.options.entries()) {
    const value = index + 1;
    const input = el('input', { attrs: { type: multiple ? 'checkbox' : 'radio', name: 'option', value, 'data-ballot-focus': 'option-' + value } });
    input.checked = choices.includes(value);
    input.disabled = sendingQuestionId !== undefined;
    input.addEventListener('change', () => {
      choices = multiple
        ? [...form.querySelectorAll('input')].filter(element => element.checked).map(element => Number(element.value))
        : [value];
      if (retryVotes.delete(question.questionId)) message('', status);
      submit.textContent = normalLabel;
      submit.disabled = !canSubmitVote(question);
    });
    fields.append(el('label', { cls: 'ballot-option' }, input, el('span', { text })));
  }
  if (editing) form.append(el('p', { cls: 'editing-label', text: '回答を変更中' }));
  form.append(fields);
  if (editing && multiple) {
    form.append(el('p', { text: 'すべての選択を外して保存すると、未回答に戻ります。' }));
  }
  form.append(el('div', { cls: 'actions' }, status, submit,
    ...(editing ? [button('キャンセル', () => {
      retryVotes.delete(question.questionId);
      editing = false;
      choices = [];
      render();
      $('ballot').querySelector<HTMLButtonElement>('.receipt button')?.focus({ preventScroll: true });
    }, '', sendingQuestionId !== undefined)] : [])));
  form.addEventListener('submit', event => {
    event.preventDefault();
    const retry = retryVotes.get(question.questionId);
    if (retry) void sendVote(retry.attempt);
    else startVote(question);
  });
  return form;
}

function voteBlocked() {
  return sendingQuestionId !== undefined || performance.now() < voteNotBefore;
}

function canSubmitVote(question: PublicQuestion) {
  return !voteBlocked() && (choices.length > 0 || retryVotes.has(question.questionId)
    || (question.type === 'multiple' && editing && ownAnswer(question) !== null));
}

function startVote(question: PublicQuestion) {
  const current = currentQuestion();
  if (!state || !current?.isOpen || !canSubmitVote(current)
    || current.questionId !== question.questionId || current.voteRevision !== question.voteRevision) return;
  const selections = [...choices];
  void sendVote({
    sessionId: state.sessionId,
    input: {
      questionId: question.questionId,
      voterToken: ensureRecord(state.sessionId).voterToken,
      voteRevision: question.voteRevision,
      choices: question.type === 'single' ? selections[0] : selections
    },
    selections
  });
}

async function refreshAfterConflict(questionId: string) {
  try {
    await applyState(await request('/api/public/state', code));
  } catch (error) {
    if (error instanceof RequestError && (error.status === 401 || error.status === 410)) invalid(error.message);
    else if (state && selectedId === questionId) {
      message('最新の質問を読み込めませんでした。通信が回復したら質問を確認してください。');
    }
  }
}

async function handleVoteFailure(error: unknown, attempt: VoteAttempt) {
  const { questionId } = attempt.input;
  const showHint = (text: string) => {
    if (selectedId === questionId) message(text);
  };
  if (error instanceof RequestError && (error.status === 401 || error.status === 410)) {
    invalid(error.message);
    return;
  }
  if (!state) return;
  if (error instanceof RequestError && (error.status === 404 || (error.status === 409 && error.code !== 'vote_full'))) {
    discardDraft(questionId, error.code === 'vote_closed' ? 'この質問の投票受付は終了しました。'
      : '質問が更新されました。最新の質問を確認し、もう一度選択してください。');
    await refreshAfterConflict(questionId);
    return;
  }

  const subject = attempt.selections.length === 0 ? '回答の取り消し' : '投票';
  let hint: string;
  if (error instanceof RequestError && error.status === 429) {
    const seconds = error.retryAfter || 3;
    voteNotBefore = performance.now() + seconds * 1000;
    setTimeout(render, Math.min(seconds * 1000, 2_147_483_647));
    hint = '投票が混み合っています。' + seconds + '秒ほど待ってから、再送信してください。';
  } else if (!(error instanceof RequestError) || error.status === 408 || error.status >= 500) {
    const timeout = (error instanceof Error && ['TimeoutError', 'AbortError'].includes(error.name))
      || (error instanceof RequestError && (error.status === 408 || error.status === 504));
    hint = timeout ? subject + 'の送信がタイムアウトしました。再送信できます。'
      : '通信エラーで' + subject + 'の送信結果を確認できませんでした。再送信できます。';
  } else {
    retryVotes.delete(questionId);
    showHint(error.message);
    return;
  }
  const reason = retryBlock(attempt);
  if (reason) {
    discardDraft(questionId, reason);
    return;
  }
  retryVotes.set(questionId, { attempt, hint });
  if (selectedId === questionId) {
    choices = [...attempt.selections];
    const question = currentQuestion();
    editing = Boolean(question && ownAnswer(question));
  }
}

async function sendVote(attempt: VoteAttempt) {
  if (voteBlocked()) return;
  const { questionId, voterToken, voteRevision } = attempt.input;
  const reason = retryBlock(attempt);
  if (reason) {
    discardDraft(questionId, reason);
    render();
    return;
  }
  sendingQuestionId = questionId;
  message('');
  render();
  try {
    const response = await request('/api/public/vote', code, { method: 'POST', data: attempt.input });
    if (response?.sessionId !== attempt.sessionId || response.voteRevision !== voteRevision) {
      throw new Error('投票の受理を確認できませんでした。');
    }
    retryVotes.delete(questionId);
    if (state?.sessionId === attempt.sessionId && record?.voterToken === voterToken
      && state.questions.find(item => item.questionId === questionId)?.voteRevision === voteRevision) {
      const latest = ensureRecord(attempt.sessionId);
      if (latest.voterToken === voterToken) {
        if (attempt.selections.length) {
          latest.answers[questionId] = { voteRevision, choices: attempt.selections };
        } else {
          delete latest.answers[questionId];
          if (selectedId === questionId) {
            results = null;
            message('回答を取り消しました。');
          }
        }
        persist(latest);
      }
    }
    if (selectedId === questionId) {
      editing = false;
      choices = [];
    }
    if (state) updateResults().catch(() => {});
  } catch (error) {
    await handleVoteFailure(error, attempt);
  } finally {
    sendingQuestionId = undefined;
    render();
  }
}

async function updateResults() {
  const question = currentQuestion();
  if (!record || !question?.resultsPublished || !ownAnswer(question) || editing) return;
  const index = ++resultRequest;
  try {
    const data = await request(`/api/public/results?questionId=${encodeURIComponent(question.questionId)}`, code);
    const current = currentQuestion();
    if (index !== resultRequest || state?.sessionId !== data.sessionId || !current?.resultsPublished
      || current.questionId !== data.question.questionId || current.voteRevision !== data.question.voteRevision
      || !ownAnswer(current)) return;
    results = data;
    render();
  } catch (error) {
    if (index !== resultRequest) return;
    if (error instanceof RequestError && error.status === 404) {
      results = null;
      render();
    }
    throw error;
  }
}

window.addEventListener('storage', event => {
  if (event.key !== storageKey || !state) return;
  const latest = readRecord();
  if (latest?.code !== code || latest.sessionId !== state.sessionId || latest.voterToken !== record?.voterToken) return;
  record = latest;
  pruneAnswers(latest, state);
  const question = currentQuestion();
  if (question && !ownAnswer(question)) {
    results = null;
    if (!retryVotes.has(question.questionId)) editing = false;
  }
  render();
  updateResults().catch(() => {});
});

$('ballot').replaceChildren(emptyState('投票に接続中', '質問を読み込んでいます。'));
poll('/api/public/state', codePattern.test(code ?? '') ? code : null, {
  interval: 2500,
  onState: applyState,
  onUnchanged: () => {
    if (state && record && record.expiresAt <= Date.now()) {
      ensureRecord(state.sessionId);
      pruneRetries();
      editing = false;
      choices = [];
      results = null;
      render();
    }
    refreshDiscussion();
  },
  onInvalid: invalid
});
