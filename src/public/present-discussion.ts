import { el, emptyState, statusPill } from './common.js';
import type { PresentDiscussion } from '../types.js';

export function discussionStage(container: HTMLElement) {
  let identity: string | undefined;
  let list: HTMLElement | undefined;
  let heading: HTMLElement | undefined;
  let generation = 0;
  const cards = new Map<string, HTMLElement>();
  const leaving = new Set<HTMLElement>();
  const reduced = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  function reset() {
    generation++;
    identity = undefined;
    list = heading = undefined;
    cards.clear();
    leaving.clear();
    container.replaceChildren();
  }

  function render(topic: PresentDiscussion, sessionId: string) {
    const current = ++generation;
    // 新しい状態を優先する。退場演出中でも、非公開・削除された本文を残さない。
    for (const card of leaving) card.remove();
    leaving.clear();
    const { focusedCommentId, hidePresented } = topic.presentation;
    const focused = topic.comments.find(comment => comment.commentId === focusedCommentId);
    const nextIdentity = sessionId + '/' + topic.questionId + '/' + topic.discussionRevision + '/' + (focused ? focused.commentId : 'list');
    if (identity !== nextIdentity) {
      cards.clear();
      heading = el('div', { cls: 'stage-heading' });
      list = el('div', { cls: focused ? 'stage-comment-focus' : 'stage-comments', attrs: { 'aria-label': '公開コメント' } });
      container.replaceChildren(heading, list);
      identity = nextIdentity;
    }
    if (!heading || !list) return;
    const headingState = JSON.stringify([topic.isOpen, Boolean(focused), topic.text]);
    if (heading.dataset.state !== headingState) {
      heading.replaceChildren(el('div', { cls: 'pills' }, statusPill(topic.isOpen),
        el('span', { cls: 'pill pill-muted', text: focused ? '注目コメント' : 'コメント一覧' })),
      el('h1', { text: topic.text }));
      heading.dataset.state = headingState;
    }
    const shown = focused ? [focused] : topic.comments.filter(comment => !hidePresented || !comment.presented);
    const selected = new Set(shown.map(comment => comment.commentId));
    const published = new Map(topic.comments.map(comment => [comment.commentId, comment]));
    const positions = new Map([...cards].map(([id, card]) => [id, card.getBoundingClientRect().top]));
    list.querySelector('.empty-state')?.remove();

    const move = (before: Map<string, number>) => {
      if (reduced()) return;
      for (const [id, card] of cards) {
        const previous = before.get(id);
        if (previous === undefined) continue;
        const offset = previous - card.getBoundingClientRect().top;
        if (offset) card.animate([{ transform: `translateY(${offset}px)` }, { transform: 'translateY(0)' }],
          { duration: 250, easing: 'ease-out' });
      }
    };
    for (const [id, card] of cards) {
      if (selected.has(id)) continue;
      cards.delete(id);
      // まだ公開されている「紹介済み」の退場だけを演出し、非公開・削除は即時に除く。
      if (!focused && hidePresented && published.get(id)?.presented && !reduced()) {
        leaving.add(card);
        const animation = card.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 250, fill: 'forwards' });
        animation.finished.then(() => {
          if (current !== generation) return;
          const before = new Map([...cards].map(([key, item]) => [key, item.getBoundingClientRect().top]));
          card.remove();
          leaving.delete(card);
          move(before);
          if (!cards.size && !leaving.size) list?.replaceChildren(emptyState('表示するコメントはありません', '公開されたコメントがここに表示されます。'));
        }).catch(() => {});
      } else card.remove();
    }
    let next = list.firstElementChild;
    for (const comment of shown) {
      let card = cards.get(comment.commentId);
      const meta = comment.likes + ' いいね' + (comment.presented ? ' · 紹介済み' : '');
      if (!card) {
        card = el('article', { cls: 'stage-comment', attrs: { 'data-comment-id': comment.commentId } },
          el('p', { cls: 'discussion-body', text: comment.body }),
          el('p', { cls: 'stage-comment-meta', text: meta }));
        cards.set(comment.commentId, card);
      } else {
        const body = card.firstElementChild!;
        const count = card.lastElementChild!;
        if (body.textContent !== comment.body) body.textContent = comment.body;
        if (count.textContent !== meta) count.textContent = meta;
      }
      // 件数だけが変わったカードは同じ DOM と位置を使う。
      while (next instanceof HTMLElement && leaving.has(next)) next = next.nextElementSibling;
      if (next === card) next = next.nextElementSibling;
      else list.insertBefore(card, next);
    }
    move(positions);
    if (!shown.length && !leaving.size) list.replaceChildren(emptyState('表示するコメントはありません', '公開されたコメントがここに表示されます。'));
  }

  return { render, reset };
}
