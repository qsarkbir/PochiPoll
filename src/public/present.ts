import {
  $, el, message, tabCredential, participantUrl, canShareParticipantUrl, poll, storageSet, emptyState, statusPill
} from './common.js';
import { chart } from './charts.js';
import { participantQr } from './qr.js';
import { discussionStage } from './present-discussion.js';
import type { PresentState } from '../types.js';

const token = tabCredential('present');
const joinLink = $('join-link', HTMLAnchorElement);
let previousCode: string | undefined;
const stageMain = $('stage-main');
const discussions = discussionStage(stageMain);
const heading = el('div', { cls: 'stage-heading' });
const badges = el('div', { cls: 'pills' });
const title = el('h1');
heading.append(badges, title);
const voteContent = el('div');
const respondentCount = el('p', { cls: 'chart-summary' });
let view: 'empty' | 'vote' | 'discussion' | 'reconnecting' | undefined;
let lastContent: string | undefined;

function join(code: string) {
  if (previousCode === code) return;
  previousCode = code;
  const url = participantUrl(code);
  joinLink.href = url;
  if (!canShareParticipantUrl) {
    joinLink.textContent = 'この端末で参加画面を開く ↗';
    $('local-join-help').hidden = false;
    return;
  }
  $('qr').replaceChildren(participantQr(url));
  $('qr-help').hidden = false;
}

function render(state: PresentState) {
  join(state.participantCode);
  $('stage').hidden = false;
  if (state.discussion) {
    discussions.render(state.discussion, state.sessionId);
    view = 'discussion';
    return;
  }
  if (view === 'discussion') discussions.reset();
  const { question } = state;
  if (!question) {
    if (view !== 'empty') {
      stageMain.replaceChildren(emptyState('投票の開始をお待ちください', '質問が始まったら、ここに表示されます。'));
    }
    view = 'empty';
    return;
  }
  if (view !== 'vote') {
    stageMain.replaceChildren(heading, voteContent);
    lastContent = undefined;
    view = 'vote';
  }
  if (title.textContent !== question.text) title.textContent = question.text;
  const badgesKey = question.isOpen + '/' + question.type;
  if (badges.dataset.state !== badgesKey) {
    badges.replaceChildren(statusPill(question.isOpen),
      el('span', { cls: 'pill pill-muted', text: question.type === 'single' ? '単一選択' : '複数選択' }));
    badges.dataset.state = badgesKey;
  }
  if (state.mode === 'results' && question.results) {
    const next = JSON.stringify([question.questionId, question.type, question.style, question.results]);
    if (lastContent !== next) voteContent.replaceChildren(chart(question.results, question.style, question.type));
    lastContent = next;
    return;
  }
  // 回答者数だけ更新されたときは、質問と選択肢の DOM を保持する。
  const next = JSON.stringify([question.questionId, question.options]);
  if (lastContent !== next) {
    voteContent.replaceChildren(el('ol', { cls: 'stage-options' }, ...question.options.map((option, index) => el('li', {},
      el('span', { cls: 'question-index', text: index + 1, attrs: { 'aria-hidden': 'true' } }),
      el('span', { text: option })))), respondentCount);
  }
  const count = question.respondentCount + ' 人が回答';
  if (respondentCount.textContent !== count) respondentCount.textContent = count;
  lastContent = next;
}

poll('/api/present/state', token, { interval: 0, onState: render, onConnection: connection => {
  if (connection === 'reconnecting' && view !== 'reconnecting') {
    if (view === 'discussion') discussions.reset();
    view = 'reconnecting';
    stageMain.replaceChildren(emptyState('再接続しています', '最新の公開状態を確認するまで表示を停止します。'));
  }
}, onInvalid: text => {
  storageSet(sessionStorage, 'fakeslido:present', null);
  $('stage').hidden = true;
  discussions.reset();
  $('qr').replaceChildren();
  joinLink.removeAttribute('href');
  message(text);
} });
