import type { AdminState, DiscussionDefinition, QuestionDefinition } from '../types.js';

export type AdminItem = AdminState['questions'][number] | AdminState['discussions'][number];
export type DeckItem = QuestionDefinition | DiscussionDefinition;

export function orderedItems(state: AdminState): AdminItem[] {
  const items: AdminItem[] = [...state.questions];
  // 選択式だけの配列に、お題を元の質問集内の位置で挿入して混在順を復元する。
  for (const topic of [...state.discussions].sort((a, b) => a.questionOrder - b.questionOrder)) {
    items.splice(topic.questionOrder - 1, 0, topic);
  }
  return items;
}

export function draft(question: DeckItem): DeckItem {
  if (question.type === 'discussion') {
    const { questionId, text, settings } = question;
    return { questionId, text, type: 'discussion', settings: { ...settings } };
  }
  const { questionId, text, type, options, style } = question;
  return { questionId, text, type, options, style };
}
