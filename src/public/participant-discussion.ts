import { button, el, message, request, RequestError, statusPill } from './common.js';
import type { PostCommentInput, PublicComment, PublicComments, PublicDiscussion, SetLikeInput } from '../types.js';

interface DiscussionContext {
  topic: PublicDiscussion;
  sessionId: string;
  voterToken: string;
}

const characterLimit = 300;
const shareWarning = 'コメントは他の参加者に公開されることがあります。氏名などの個人情報は入力しないでください。';

export function createDiscussionView(initial: DiscussionContext, code: string,
  onInvalid: (text: string) => void, onConflict: () => void) {
  let context = initial;
  let disposed = false;
  let attempt: PostCommentInput | undefined;
  let posting = false;
  let liking = false;
  let postReadyAt = 0;
  let likeReadyAt = 0;
  let snapshot: PublicComments | null = null;
  let loading = false;
  let requestId = 0;

  const title = el('h2');
  const badges = el('div', { cls: 'pills' });
  const text = el('textarea', { attrs: { id: 'discussion-body', rows: 3, required: '',
    'aria-describedby': 'discussion-privacy discussion-count' } });
  const count = el('span', { cls: 'muted', attrs: { id: 'discussion-count' } });
  const submit = el('button', { cls: 'primary', attrs: { type: 'submit' } });
  const postNotice = el('p', { cls: 'notice', attrs: { role: 'status', hidden: '', tabindex: '-1' } });
  const listNotice = el('p', { cls: 'notice', attrs: { role: 'status', hidden: '' } });
  const closed = el('p', { cls: 'muted', text: 'このお題の投稿といいねの受付は終了しました。' });
  const form = el('form', { cls: 'discussion-form' },
    el('p', { text: shareWarning, attrs: { id: 'discussion-privacy' } }),
    el('label', { cls: 'field', attrs: { for: 'discussion-body' } }, 'コメント', text),
    el('div', { cls: 'actions' }, submit, count), closed, postNotice);
  const list = el('div', { cls: 'discussion-comments' });
  const element = el('div', { cls: 'discussion' }, el('div', { cls: 'ballot-heading' }, badges, title),
    form, el('section', { cls: 'discussion-public' }, el('h3', { text: '公開コメント' }), listNotice, list));

  function binding() {
    return {
      sessionId: context.sessionId, questionId: context.topic.questionId,
      discussionRevision: context.topic.discussionRevision, voterToken: context.voterToken
    };
  }

  function stillCurrent(bound: ReturnType<typeof binding>) {
    const current = binding();
    return !disposed && bound.sessionId === current.sessionId && bound.questionId === current.questionId
      && bound.discussionRevision === current.discussionRevision && bound.voterToken === current.voterToken;
  }

  function updateForm() {
    const length = [...text.value].length;
    const tooLong = length > characterLimit;
    count.textContent = length + ' / ' + characterLimit + '文字';
    text.setAttribute('aria-invalid', String(tooLong));
    text.disabled = posting || !context.topic.isOpen;
    closed.hidden = context.topic.isOpen;
    submit.disabled = text.disabled || !text.value.trim() || tooLong || performance.now() < postReadyAt;
    submit.textContent = posting ? '送信中…' : attempt ? '同じコメントを再送信する' : '投稿する';
  }

  function renderList() {
    if (!snapshot?.comments.length) {
      list.replaceChildren(el('p', { cls: 'muted',
        text: snapshot ? '公開中のコメントはありません。' : '公開コメントを読み込んでいます。' }));
      return;
    }
    const focused = document.activeElement instanceof HTMLButtonElement ? document.activeElement.dataset.comment : undefined;
    const buttons = new Map<string, HTMLButtonElement>();
    const items = snapshot.comments.map(comment => {
      const label = comment.likedByYou ? 'いいねを取り消す' : 'いいね';
      const reaction = button(label, () => void like(comment), 'compact',
        liking || !context.topic.isOpen || comment.authoredByYou || performance.now() < likeReadyAt);
      reaction.dataset.comment = comment.commentId;
      reaction.setAttribute('aria-pressed', String(comment.likedByYou));
      buttons.set(comment.commentId, reaction);
      // textContent で描画し、投稿本文を HTML やリンクに変換しない。
      return el('li', { cls: 'discussion-comment' },
        el('p', { cls: 'discussion-body', text: comment.body }),
        el('div', { cls: 'actions' }, reaction, el('span', { cls: 'muted', text: 'いいね ' + comment.likes + '件' }),
          ...(comment.authoredByYou ? [el('span', { cls: 'muted', text: 'あなたの投稿' })] : [])));
    });
    list.replaceChildren(el('ol', { cls: 'discussion-list' }, ...items));
    const target = focused && buttons.get(focused);
    if (target && !target.disabled) target.focus({ preventScroll: true });
  }

  function update(next: DiscussionContext) {
    const previous = binding();
    const openChanged = next.topic.isOpen !== context.topic.isOpen;
    const titleChanged = next.topic.text !== context.topic.text;
    context = next;
    const changed = !stillCurrent(previous);
    if (changed) {
      requestId++;
      loading = false;
      snapshot = null;
      if (text.value) message('お題または参加状態が更新されました。投稿内容を確認してください。', postNotice);
      attempt = undefined;
    }
    if (titleChanged || !title.textContent) title.textContent = next.topic.text;
    if (openChanged || !badges.childElementCount) badges.replaceChildren(statusPill(next.topic.isOpen),
      el('span', { cls: 'pill pill-muted', text: 'コメント＋いいね' }));
    updateForm();
    if (openChanged || changed) renderList();
  }

  async function refresh(force = false) {
    if (disposed || loading && !force) return;
    const current = binding();
    const id = ++requestId;
    loading = true;
    const query = snapshot ? '&revision=' + snapshot.revision : '';
    const path = `/api/public/comments?questionId=${encodeURIComponent(current.questionId)}${query}` as const;
    try {
      const data = await request(path, code, { voterToken: current.voterToken });
      if (!stillCurrent(current) || id !== requestId) return;
      if (data && (data.sessionId !== current.sessionId || data.questionId !== current.questionId
        || data.discussionRevision !== current.discussionRevision)) {
        onConflict();
        return;
      }
      if (data) {
        snapshot = data;
        renderList();
      }
      message('', listNotice);
    } catch (error) {
      if (!stillCurrent(current) || id !== requestId) return;
      if (invalid(error)) return;
      if (error instanceof RequestError && error.status === 404) {
        snapshot = null;
        list.replaceChildren();
        onConflict();
      }
      message('公開コメントを更新できませんでした。通信状態を確認してください。', listNotice);
    } finally {
      if (id === requestId) loading = false;
    }
  }

  function invalid(error: unknown) {
    if (!(error instanceof RequestError) || (error.status !== 401 && error.status !== 410)) return false;
    onInvalid(error.message);
    return true;
  }

  function retryDelay(error: RequestError, action: 'post' | 'like') {
    const seconds = error.retryAfter || 3;
    const delay = Math.min(seconds * 1000, 2_147_483_647);
    if (action === 'post') postReadyAt = performance.now() + delay;
    else likeReadyAt = performance.now() + delay;
    setTimeout(() => {
      if (disposed) return;
      if (action === 'post') updateForm();
      else renderList();
    }, delay);
    return '混み合っています。' + seconds + '秒ほど待ってからもう一度お試しください。';
  }

  async function post() {
    if (submit.disabled || disposed) return;
    const input = attempt ?? { ...binding(), clientSubmissionId: crypto.randomUUID(), body: text.value };
    attempt = input;
    const hadFocus = document.activeElement === submit;
    posting = true;
    updateForm();
    message('', postNotice);
    try {
      const receipt = await request('/api/public/comments', code, { method: 'POST', data: input });
      if (!stillCurrent(input)) return;
      if (!receipt?.commentId) throw new Error('投稿の受付を確認できませんでした。');
      attempt = undefined;
      text.value = '';
      const status = receipt.visibility === 'published' ? '投稿を公開しました。'
        : receipt.visibility === 'pending' ? '投稿を受け付けました。公開前の審査を待っています。'
          : '投稿を受け付けました。現在は非公開です。';
      message(status, postNotice);
      if (receipt.visibility === 'published') void refresh(true);
    } catch (error) {
      if (!stillCurrent(input) || invalid(error)) return;
      if (error instanceof RequestError && error.status === 429) {
        message(retryDelay(error, 'post'), postNotice);
      } else if (error instanceof RequestError && error.status < 500 && error.status !== 408) {
        attempt = undefined;
        message(error.message, postNotice);
        if (error.status === 404 || error.status === 409) onConflict();
      } else {
        message('通信エラーで投稿の受付を確認できませんでした。同じコメントを再送信できます。', postNotice);
      }
    } finally {
      posting = false;
      if (!disposed) {
        updateForm();
        if (hadFocus && document.activeElement === document.body && !postNotice.hidden) {
          postNotice.focus({ preventScroll: true });
        }
      }
    }
  }

  async function like(comment: PublicComment) {
    if (disposed || liking || !context.topic.isOpen || comment.authoredByYou || performance.now() < likeReadyAt) return;
    const data: SetLikeInput = { ...binding(), commentId: comment.commentId, liked: !comment.likedByYou };
    const hadFocus = document.activeElement instanceof HTMLButtonElement
      && document.activeElement.dataset.comment === comment.commentId;
    liking = true;
    message('', listNotice);
    renderList();
    try {
      await request('/api/public/likes', code, { method: 'POST', data });
      if (stillCurrent(data)) await refresh(true);
    } catch (error) {
      if (!stillCurrent(data) || invalid(error)) return;
      if (error instanceof RequestError && (error.status === 404 || error.status === 409)) {
        onConflict();
        await refresh(true);
      }
      if (!stillCurrent(data)) return;
      const hint = error instanceof RequestError
        ? error.status === 429 ? retryDelay(error, 'like') : error.message
        : 'いいねの反映を確認できませんでした。公開コメントを更新して確認してください。';
      message(hint, listNotice);
    } finally {
      liking = false;
      if (!disposed) {
        renderList();
        if (hadFocus && document.activeElement === document.body) {
          [...list.querySelectorAll('button')].find(control => control.dataset.comment === comment.commentId && !control.disabled)
            ?.focus({ preventScroll: true });
        }
      }
    }
  }

  text.addEventListener('input', () => {
    attempt = undefined;
    message('', postNotice);
    updateForm();
  });
  form.addEventListener('submit', event => {
    event.preventDefault();
    void post();
  });
  update(initial);
  renderList();
  return { element, update, refresh, dispose: () => { disposed = true; } };
}
