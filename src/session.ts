import { createHmac, randomBytes, randomInt, randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import type { ServerResponse } from 'node:http';
import { Discussion, commentsPerSession, likesPerSession, validateDiscussion } from './discussion.js';
import { ApiError, idPattern, objectWith, requireValue, textFits, tokenPattern } from './validation.js';
import type {
  AdminComments, AdminState, CommentControlInput, CommentReceipt, CommentsExport, DeckInput, DiscussionDefinition, GraphStyle, LikeReceipt,
  PostCommentInput, Presentation, PresentState, PublicComments, PublicDiscussion, PublicQuestion, PublicResults,
  PublicState, Question, QuestionDefinition, ResultsExport, Role, SetLikeInput, Tally, VoteInput
} from './types.js';

// type の値で投票とコメントを区別する。コメントのお題には票の Map を持たせない。
interface DiscussionQuestion extends DiscussionDefinition {
  everOpened: boolean;
  isOpen: boolean;
  discussionRevision: number;
  discussion: Discussion;
}

type StoredQuestion = Question | DiscussionQuestion;
type RateAction = 'vote' | 'comment' | 'like';
const randomToken = (bytes: number) => randomBytes(bytes).toString('base64url');

// 配列であることを確認した後も、各要素は個別に検証する。
function isUnknownArray(value: unknown): value is unknown[] {
  return Array.isArray(value);
}

function validateQuestion(input: unknown): QuestionDefinition | DiscussionDefinition {
  if (input !== null && typeof input === 'object' && 'type' in input && input.type === 'discussion') {
    return validateDiscussion(input);
  }
  objectWith(input, ['questionId', 'text', 'type', 'options', 'style']);
  const { questionId, text, type, options, style } = input;
  requireValue(questionId === undefined || typeof questionId === 'string' && idPattern.test(questionId));
  requireValue(textFits(text, 200), '質問文は1〜200文字で入力してください。');
  requireValue(type === 'single' || type === 'multiple');
  requireValue(isUnknownArray(options) && options.length >= 2 && options.length <= 8
    && options.every(option => textFits(option, 80)), '選択肢は2〜8個、各1〜80文字で入力してください。');
  const styles: GraphStyle[] = ['horizontal', 'vertical'];
  if (type === 'single' && options.length <= 6) styles.push('donut');
  if (type === 'single' && options.length <= 4) styles.push('stacked');
  const allowedStyle = styles.find(allowed => allowed === style);
  requireValue(allowedStyle !== undefined, '選択肢数と質問形式に対応したグラフを選んでください。');
  return { questionId: questionId ?? randomUUID(), text, type, options, style: allowedStyle };
}

export function aggregate(question: Question): Tally {
  const respondentCount = question.votes.size;
  const counts = question.options.map(() => 0);
  for (const choices of question.votes.values()) {
    for (const choice of choices) counts[choice - 1]++;
  }
  return {
    respondentCount,
    totalSelections: counts.reduce((sum, count) => sum + count, 0),
    options: counts.map((optionVotes, index) => ({
      optionIndex: index + 1,
      optionText: question.options[index],
      optionVotes,
      percentage: respondentCount ? Math.round(1000 * optionVotes / respondentCount) / 10 : 0
    }))
  };
}

// 公開する項目を列挙して、内部データが追加されても公開 API に混ざらないようにする。
function publicQuestion(question: Question): PublicQuestion {
  const { questionId, text, type, options, style, isOpen, resultsPublished, voteRevision } = question;
  return { questionId, text, type, options, style, isOpen, resultsPublished, voteRevision };
}

function publicDiscussion(question: DiscussionQuestion, index: number): PublicDiscussion {
  const { questionId, text, type, isOpen, discussionRevision } = question;
  return { questionId, questionOrder: index + 1, text, type, isOpen, discussionRevision };
}

function changedContent(before: QuestionDefinition, after: QuestionDefinition) {
  return before.text !== after.text || before.type !== after.type
    || before.options.length !== after.options.length
    || before.options.some((option, index) => option !== after.options[index]);
}

export class PollSession {
  // ! はコンストラクターで呼ぶ reset() が、公開前に初期値を入れることを表す。
  sessionId!: string;
  participantCode!: string;
  presentationToken!: string;
  #sessionKey!: Buffer;
  #rateKey!: Buffer;
  private questions!: Map<string, StoredQuestion>;
  private presentation!: Presentation;
  readonly revision: Record<Role, number>;
  private deckRevision: number;
  private readonly idleMs: number;
  private readonly voteLimit: number;
  private readonly rateTimer: ReturnType<typeof setInterval>;
  #voteRevision = 0;
  #discussionRevision = 0;
  #commentRevision = 0;
  #expiry?: ReturnType<typeof setTimeout>;
  #expiresAt = 0;
  #rateCounts = { vote: new Map<string, number>(), comment: new Map<string, number>(), like: new Map<string, number>() };
  #events = new EventEmitter();
  #waiters = 0;

  constructor({ idleMs, voteLimit }: { idleMs: number; voteLimit: number }) {
    this.idleMs = idleMs;
    this.voteLimit = voteLimit;
    const initialRevision = randomInt(2 ** 40);
    this.revision = { admin: initialRevision, public: initialRevision, present: initialRevision };
    this.deckRevision = initialRevision;
    this.#events.setMaxListeners(0);
    this.reset();
    this.rateTimer = setInterval(() => this.#resetRateLimit(), 60_000).unref();
  }

  dispose() {
    clearTimeout(this.#expiry);
    clearInterval(this.rateTimer);
    this.#events.emit('admin');
    this.#events.emit('present');
  }

  #resetRateLimit() {
    this.#rateKey = randomBytes(32);
    for (const counts of Object.values(this.#rateCounts)) counts.clear();
  }

  reset() {
    this.sessionId = randomUUID();
    this.participantCode = randomToken(16);
    this.presentationToken = randomToken(32);
    this.#sessionKey = randomBytes(32);
    this.#voteRevision = 0;
    this.#discussionRevision = 0;
    this.#resetRateLimit();
    this.questions = new Map();
    this.presentation = { questionId: null, mode: 'question' };
    this.deckRevision++;
    this.touch();
    this.#notify('admin', 'public', 'present');
  }

  touch() {
    clearTimeout(this.#expiry);
    this.#expiresAt = Date.now() + this.idleMs;
    this.#expiry = setTimeout(() => this.reset(), this.idleMs).unref();
  }

  #notify(...roles: Role[]) {
    for (const role of roles) {
      this.revision[role]++;
      this.#events.emit(role);
    }
  }

  wait(role: 'admin' | 'present', response: ServerResponse, timeout: number): Promise<void> {
    if (this.#waiters >= 64) {
      throw new ApiError(429, '接続が混み合っています。');
    }
    this.#waiters++;
    return new Promise(resolve => {
      const finish = () => {
        clearTimeout(timer);
        this.#events.off(role, finish);
        response.off('close', finish);
        this.#waiters--;
        resolve();
      };
      const timer = setTimeout(finish, timeout);
      this.#events.once(role, finish);
      response.once('close', finish);
    });
  }

  #rateLimit(ip: string, action: RateAction = 'vote') {
    const identifier = createHmac('sha256', this.#rateKey).update(ip).digest('base64url');
    const counts = this.#rateCounts[action];
    const count = counts.get(identifier) ?? 0;
    if (count >= this.voteLimit || (!count && counts.size >= 10_000)) {
      throw new ApiError(429, 'しばらく待ってから再試行してください。');
    }
    counts.set(identifier, count + 1);
  }

  #presentationQuestion() {
    const { questionId } = this.presentation;
    return questionId === null ? undefined : this.questions.get(questionId);
  }

  state(role: Role): AdminState | PublicState | PresentState {
    const base = { revision: this.revision[role], sessionId: this.sessionId };
    if (role === 'public') {
      const opened = [...this.questions.values()].filter(q => q.everOpened);
      return {
        ...base,
        questions: opened.filter(q => q.type !== 'discussion').map(publicQuestion),
        discussions: opened.flatMap((q, index) => q.type === 'discussion' ? [publicDiscussion(q, index)] : [])
      } satisfies PublicState;
    }
    if (role === 'present') {
      const question = this.#presentationQuestion();
      if (question?.type === 'discussion' && question.everOpened) {
        return { ...base, participantCode: this.participantCode, mode: 'question', question: null,
          discussion: { ...publicDiscussion(question, [...this.questions.keys()].indexOf(question.questionId)),
            presentation: question.discussion.presentation, comments: question.discussion.presentComments() }
        } satisfies PresentState;
      }
      const visible = question?.type !== 'discussion' && question?.everOpened ? question : null;
      const tallyVisible = this.presentation.mode === 'results' && visible?.resultsPublished;
      return {
        ...base,
        participantCode: this.participantCode,
        mode: tallyVisible ? 'results' : 'question',
        question: visible ? {
          ...publicQuestion(visible),
          respondentCount: visible.votes.size,
          ...(tallyVisible && { results: aggregate(visible) })
        } : null
      } satisfies PresentState;
    }
    const questions = [...this.questions.values()];
    return {
      ...base,
      expiresAt: this.#expiresAt,
      serverTime: Date.now(),
      deckRevision: this.deckRevision,
      participantCode: this.participantCode,
      presentationToken: this.presentationToken,
      presentation: this.presentation,
      questions: questions.filter(q => q.type !== 'discussion').map(question => ({
        ...publicQuestion(question), everOpened: question.everOpened, results: aggregate(question)
      })),
      discussions: questions.flatMap((q, index) => q.type === 'discussion'
        ? [{ ...publicDiscussion(q, index), everOpened: q.everOpened, settings: q.settings, commentCount: q.discussion.size,
          presentation: q.discussion.presentation }]
        : [])
    } satisfies AdminState;
  }

  question(id: unknown): StoredQuestion {
    requireValue(typeof id === 'string' && idPattern.test(id));
    const question = this.questions.get(id);
    if (!question) throw new ApiError(404, '質問が見つかりません。');
    return question;
  }

  results(id: unknown): PublicResults {
    requireValue(typeof id === 'string' && idPattern.test(id));
    const question = this.questions.get(id);
    if (question?.type === 'discussion' || !question?.resultsPublished) throw new ApiError(404, '公開済みの結果がありません。');
    return { sessionId: this.sessionId, question: publicQuestion(question), ...aggregate(question) };
  }

  vote(input: unknown, ip: string): number {
    this.#rateLimit(ip);
    objectWith(input, ['questionId', 'voterToken', 'choices', 'voteRevision'] satisfies (keyof VoteInput)[]);
    const { voterToken, voteRevision } = input;
    requireValue(typeof voterToken === 'string' && tokenPattern.test(voterToken));
    requireValue(typeof voteRevision === 'number' && Number.isSafeInteger(voteRevision) && voteRevision > 0);
    const question = this.question(input.questionId);
    if (question.type === 'discussion') throw new ApiError(404, '選択式の質問が見つかりません。');
    if (!question.isOpen) throw new ApiError(409, 'この質問の受付は終了しています。', 'vote_closed');
    if (question.voteRevision !== voteRevision) {
      throw new ApiError(409, '質問が更新されました。もう一度選択してください。', 'vote_changed');
    }
    const choices = question.type === 'single' ? [input.choices] : input.choices;
    requireValue(isUnknownArray(choices) && choices.length <= question.options.length
      && new Set(choices).size === choices.length
      && choices.every((choice): choice is number => typeof choice === 'number'
        && Number.isInteger(choice) && choice >= 1 && choice <= question.options.length),
    '有効な選択肢を指定してください。');
    const pseudonym = createHmac('sha256', this.#sessionKey)
      .update(voterToken).update(question.questionId).digest('base64url');
    const oldChoices = question.votes.get(pseudonym);
    // 複数選択の空配列は回答の削除。すでに未回答なら、再送でも集計は変わらない。
    const withdrawal = choices.length === 0;
    if (withdrawal && !oldChoices) return voteRevision;
    if (!oldChoices && question.votes.size >= 5000) throw new ApiError(409, '回答者数の上限に達しました。', 'vote_full');
    choices.sort((a, b) => a - b);
    if (oldChoices?.length === choices.length && oldChoices.every((choice, index) => choice === choices[index])) {
      return voteRevision;
    }
    if (withdrawal) question.votes.delete(pseudonym);
    else question.votes.set(pseudonym, choices);
    const roles: Role[] = ['admin'];
    if (question.resultsPublished) roles.push('public');
    if (this.presentation.questionId === question.questionId
      && (!oldChoices || withdrawal || this.presentation.mode === 'results')) roles.push('present');
    this.#notify(...roles);
    return voteRevision;
  }

  #topic(id: unknown, openedOnly = false): DiscussionQuestion {
    requireValue(typeof id === 'string' && idPattern.test(id));
    const question = this.questions.get(id);
    // 開いたことのないお題は、参加者には存在しないお題と同じ応答を返す。
    if (question?.type !== 'discussion' || (openedOnly && !question.everOpened)) {
      throw new ApiError(404, 'コメントのお題が見つかりません。');
    }
    return question;
  }

  #discussionRequest(input: Record<string, unknown>) {
    const { sessionId, questionId, discussionRevision, voterToken } = input;
    requireValue(typeof sessionId === 'string' && sessionId.length > 0);
    requireValue(typeof voterToken === 'string' && tokenPattern.test(voterToken));
    requireValue(Number.isSafeInteger(discussionRevision));
    this.requireSession(sessionId);
    const topic = this.#topic(questionId, true);
    if (!topic.isOpen) throw new ApiError(409, 'このお題の受付は終了しています。');
    if (topic.discussionRevision !== discussionRevision) {
      throw new ApiError(409, 'お題が更新されました。最新の内容を確認してください。');
    }
    return { topic, voterToken };
  }

  #discussionUsage(field: 'size' | 'likeCount') {
    let total = 0;
    for (const question of this.questions.values()) {
      if (question.type === 'discussion') total += question.discussion[field];
    }
    return total;
  }

  postComment(input: unknown, ip: string): CommentReceipt {
    this.#rateLimit(ip, 'comment');
    objectWith(input, [
      'sessionId', 'questionId', 'discussionRevision', 'voterToken', 'clientSubmissionId', 'body'
    ] satisfies (keyof PostCommentInput)[]);
    const { topic, voterToken } = this.#discussionRequest(input);
    const { body, clientSubmissionId } = input;
    requireValue(typeof clientSubmissionId === 'string' && idPattern.test(clientSubmissionId));
    requireValue(textFits(body, 300), 'コメントは1〜300文字で入力してください。');
    const { receipt, added } = topic.discussion.post(voterToken, clientSubmissionId, body, topic.settings,
      this.#discussionUsage('size') >= commentsPerSession);
    if (added) {
      if (receipt.visibility === 'published') {
        topic.discussion.revision = ++this.#commentRevision;
        this.#notify('present');
      }
      this.#notify('admin');
    }
    return receipt;
  }

  setLike(input: unknown, ip: string): LikeReceipt {
    this.#rateLimit(ip, 'like');
    objectWith(input, [
      'sessionId', 'questionId', 'discussionRevision', 'voterToken', 'commentId', 'liked'
    ] satisfies (keyof SetLikeInput)[]);
    const { topic, voterToken } = this.#discussionRequest(input);
    const { commentId, liked } = input;
    requireValue(typeof commentId === 'string' && idPattern.test(commentId) && typeof liked === 'boolean');
    const { receipt, changed } = topic.discussion.setLike(commentId, voterToken, liked,
      this.#discussionUsage('likeCount') >= likesPerSession);
    if (changed) {
      topic.discussion.revision = ++this.#commentRevision;
      this.#notify('present');
    }
    return receipt;
  }

  publicComments(id: unknown, voterToken?: unknown, revision?: number): PublicComments | null {
    requireValue(voterToken === undefined || typeof voterToken === 'string' && tokenPattern.test(voterToken));
    const topic = this.#topic(id, true);
    if (revision === topic.discussion.revision) return null;
    return { sessionId: this.sessionId, questionId: topic.questionId, discussionRevision: topic.discussionRevision,
      revision: topic.discussion.revision,
      comments: topic.discussion.publicComments(voterToken) };
  }

  adminComments(id: unknown): AdminComments {
    const topic = this.#topic(id);
    return { sessionId: this.sessionId, questionId: topic.questionId, discussionRevision: topic.discussionRevision,
      comments: topic.discussion.adminComments() };
  }

  controlComment(input: unknown) {
    objectWith(input, ['sessionId', 'questionId', 'discussionRevision', 'commentId', 'action',
      'expectedVisibility', 'confirm'] satisfies (keyof CommentControlInput)[]);
    const { sessionId, discussionRevision, commentId, action, expectedVisibility, confirm } = input;
    requireValue(typeof sessionId === 'string' && sessionId.length > 0);
    requireValue(Number.isSafeInteger(discussionRevision));
    requireValue(typeof commentId === 'string' && idPattern.test(commentId));
    requireValue(action === 'publish' || action === 'hide' || action === 'delete');
    requireValue(expectedVisibility === 'pending' || expectedVisibility === 'published' || expectedVisibility === 'hidden');
    requireValue(confirm === undefined || typeof confirm === 'boolean');
    requireValue(action !== 'delete' || confirm === true, '削除には確認が必要です。');
    this.requireSession(sessionId);
    const topic = this.#topic(input.questionId);
    if (topic.discussionRevision !== discussionRevision) throw new ApiError(409, 'お題が更新されました。');
    const publicChanged = topic.discussion.control({ sessionId, questionId: topic.questionId,
      discussionRevision: topic.discussionRevision, commentId, action, expectedVisibility, confirm });
    if (publicChanged) {
      topic.discussion.revision = ++this.#commentRevision;
      this.#notify('present');
    }
    this.touch();
    this.#notify('admin');
  }

  controlDiscussion(input: unknown) {
    objectWith(input, ['sessionId', 'questionId', 'discussionRevision', 'action', 'commentId', 'presented',
      'hidePresented', 'freezeOrder']);
    const { sessionId, questionId, discussionRevision, action, commentId, presented, hidePresented, freezeOrder } = input;
    requireValue(typeof sessionId === 'string' && sessionId.length > 0 && Number.isSafeInteger(discussionRevision));
    requireValue(action === 'list' || action === 'focus' || action === 'set-presented' || action === 'configure');
    this.requireSession(sessionId);
    const topic = this.#topic(questionId, true);
    if (topic.discussionRevision !== discussionRevision) throw new ApiError(409, 'お題が更新されました。');
    // 入力をすべて検証してから変更する。別の操作にだけ使える項目の混入も拒否する。
    if (action === 'configure') {
      requireValue(commentId === undefined && presented === undefined);
      requireValue(typeof hidePresented === 'boolean' && typeof freezeOrder === 'boolean');
      topic.discussion.configure(hidePresented, freezeOrder);
    } else {
      requireValue(hidePresented === undefined && freezeOrder === undefined);
      if (action === 'set-presented') {
        requireValue(typeof commentId === 'string' && idPattern.test(commentId) && typeof presented === 'boolean');
        if (topic.discussion.setPresented(commentId, presented)) topic.discussion.revision = ++this.#commentRevision;
      } else {
        requireValue(presented === undefined);
        if (action === 'focus') {
          requireValue(typeof commentId === 'string' && idPattern.test(commentId));
          topic.discussion.focus(commentId);
        } else {
          requireValue(commentId === undefined);
          topic.discussion.focus(null);
        }
        this.presentation = { questionId: topic.questionId, mode: 'question' };
      }
    }
    this.touch();
    this.#notify('admin', 'present');
  }

  exportComments(sessionId: string): CommentsExport {
    this.requireSession(sessionId);
    // 書き出す項目を明示する。運営用一覧の流用は非公開本文や内部情報の混入につながる。
    const topics = [...this.questions.values()].flatMap((topic, index) => topic.type !== 'discussion' ? [] : [{
      questionId: topic.questionId, questionOrder: index + 1, questionText: topic.text,
      settings: { ...topic.settings },
      comments: topic.discussion.publicComments().map(({ commentId, body, likes, presented }) =>
        ({ commentId, text: body, likes, presented }))
    }]);
    this.touch();
    this.#notify('admin');
    return { format: 'pochipoll-comments', version: 1, sessionId: this.sessionId,
      exportedAt: new Date().toISOString(), topics };
  }

  #questionFromDraft(draft: QuestionDefinition | DiscussionDefinition, previous?: StoredQuestion): StoredQuestion {
    if (draft.type === 'discussion') {
      const before = previous?.type === 'discussion' ? previous : undefined;
      const discussion = before?.discussion ?? new Discussion(draft.questionId, this.#sessionKey, ++this.#commentRevision);
      if (before && before.text !== draft.text) discussion.revision = ++this.#commentRevision;
      return {
        ...draft,
        everOpened: before?.everOpened ?? false,
        isOpen: before?.isOpen ?? false,
        discussionRevision: before?.text === draft.text ? before.discussionRevision : ++this.#discussionRevision,
        discussion
      };
    }
    const before = previous?.type === 'discussion' ? undefined : previous;
    const reset = !before || changedContent(before, draft);
    return {
      ...draft,
      everOpened: before?.everOpened ?? false,
      isOpen: before?.isOpen ?? false,
      resultsPublished: before?.resultsPublished ?? false,
      voteRevision: reset ? ++this.#voteRevision : before.voteRevision,
      votes: reset ? new Map() : before.votes
    };
  }

  saveDeck(input: unknown) {
    objectWith(input, ['questions', 'deckRevision', 'replace', 'confirmReset'] satisfies (keyof DeckInput)[]);
    requireValue(isUnknownArray(input.questions) && input.questions.length <= 50, '質問は50問までです。');
    requireValue(input.replace === undefined || typeof input.replace === 'boolean');
    requireValue(input.confirmReset === undefined || typeof input.confirmReset === 'boolean');
    requireValue(Number.isSafeInteger(input.deckRevision));
    if (input.deckRevision !== this.deckRevision) {
      throw new ApiError(409, '質問集が更新されました。最新の内容を確認してください。', 'deck_changed');
    }
    const validated = input.questions.map(validateQuestion);
    requireValue(new Set(validated.map(question => question.questionId)).size === validated.length, '質問IDが重複しています。');
    const incoming = new Map(validated.map(question => [question.questionId, question]));
    const affected = [...this.questions.values()].filter(question => {
      const draft = incoming.get(question.questionId);
      if (question.type === 'discussion') {
        return question.discussion.size && (input.replace || draft?.type !== 'discussion');
      }
      return question.votes.size && (input.replace || !draft || draft.type === 'discussion' || changedContent(question, draft));
    });
    if (affected.length && !input.confirmReset) {
      const hasComments = affected.some(question => question.type === 'discussion');
      throw new ApiError(409, hasComments ? '投稿済みのコメントを消去する操作です。' : '回答済みの票を消去する操作です。',
        'confirm_reset');
    }
    this.questions = new Map(validated.map(draft => {
      const previous = input.replace ? undefined : this.questions.get(draft.questionId);
      return [draft.questionId, this.#questionFromDraft(draft, previous)];
    }));
    const selected = this.#presentationQuestion();
    if (input.replace || !selected) {
      this.presentation = { questionId: null, mode: 'question' };
    } else if (selected.type === 'discussion') {
      this.presentation.mode = 'question';
    }
    this.deckRevision++;
    this.touch();
    this.#notify('admin', 'public', 'present');
  }

  requireSession(sessionId: string) {
    if (sessionId !== this.sessionId) throw new ApiError(409, 'セッションが更新されました。');
  }

  control(input: unknown) {
    objectWith(input, ['action', 'questionId', 'confirm', 'sessionId', 'deckRevision']);
    const { action, questionId, confirm, sessionId, deckRevision } = input;
    requireValue(confirm === undefined || typeof confirm === 'boolean');
    if (action !== 'advance') requireValue(deckRevision === undefined);
    if (action === 'erase') {
      requireValue(questionId === undefined && confirm === true, '全データ消去には確認が必要です。');
      requireValue(typeof sessionId === 'string' && sessionId.length > 0, '消去するセッションを確認してください。');
      // 受信開始時のセッションに加え、運営者が画面で確認したセッションも照合する。
      this.requireSession(sessionId);
      this.reset();
      return;
    }
    if (action === 'extend-expiry') {
      requireValue(questionId === undefined && confirm === undefined);
      requireValue(typeof sessionId === 'string' && sessionId.length > 0);
      this.requireSession(sessionId);
      this.touch();
      this.#notify('admin');
      return;
    }
    if (action === 'advance') {
      requireValue(confirm === undefined && typeof sessionId === 'string' && sessionId.length > 0);
      requireValue(typeof questionId === 'string' && idPattern.test(questionId) && Number.isSafeInteger(deckRevision));
      this.requireSession(sessionId);
      if (deckRevision !== this.deckRevision) {
        throw new ApiError(409, '質問集が更新されました。最新の内容を確認してください。', 'deck_changed');
      }
      this.#advance(questionId);
    } else if (action === 'show-results' || action === 'show-question') {
      requireValue(sessionId === undefined && questionId === undefined);
      const question = this.#presentationQuestion();
      if (action === 'show-results') {
        requireValue(question?.type !== 'discussion', 'コメントのお題には可視化モードを使用できません。');
        requireValue(question?.everOpened, '発表する質問を一度オープンしてください。');
        question.resultsPublished = true;
      }
      this.presentation.mode = action === 'show-results' ? 'results' : 'question';
    } else {
      requireValue(sessionId === undefined);
      this.#controlQuestion(action, this.question(questionId), confirm);
    }
    this.touch();
    this.#notify('admin', 'public', 'present');
  }

  #advance(questionId: string) {
    const current = this.#presentationQuestion();
    if (!current || current.questionId !== questionId) {
      throw new ApiError(409, '発表対象が切り替わりました。最新の内容を確認してください。');
    }
    const ordered = [...this.questions.values()];
    const next = ordered[ordered.indexOf(current) + 1];
    if (!next) throw new ApiError(409, 'これが最後の質問です。');
    // 状態を変える前に対象を確定し、受付と発表を更新してから一度だけ通知する。
    this.#controlQuestion('close', current, undefined);
    this.#controlQuestion('open', next, undefined);
  }

  #controlQuestion(action: unknown, question: StoredQuestion, confirm: boolean | undefined) {
    const selected = this.presentation.questionId === question.questionId;
    switch (action) {
      case 'open':
      case 'select':
        if (action === 'open') {
          question.isOpen = true;
          question.everOpened = true;
        }
        if (!selected) this.presentation = { questionId: question.questionId, mode: 'question' };
        break;
      case 'close':
        question.isOpen = false;
        break;
      case 'publish':
        requireValue(question.type !== 'discussion');
        requireValue(question.everOpened, '質問を一度オープンしてください。');
        question.resultsPublished = true;
        break;
      case 'unpublish':
        requireValue(question.type !== 'discussion');
        question.resultsPublished = false;
        if (selected) this.presentation.mode = 'question';
        break;
      case 'reset-votes':
        requireValue(question.type !== 'discussion');
        requireValue(confirm === true, '票のリセットには確認が必要です。');
        question.votes.clear();
        question.voteRevision = ++this.#voteRevision;
        break;
      default:
        requireValue(false, '操作を確認してください。');
    }
  }

  exportResults(): ResultsExport {
    this.touch();
    this.#notify('admin');
    return {
      format: 'pochipoll-results',
      version: 1,
      sessionId: this.sessionId,
      exportedAt: new Date().toISOString(),
      questions: [...this.questions.values()].flatMap((question, index) => question.type === 'discussion' ? [] : [{
        questionId: question.questionId,
        questionOrder: index + 1,
        questionText: question.text,
        questionType: question.type,
        ...aggregate(question)
      }])
    };
  }
}
