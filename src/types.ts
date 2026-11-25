// ユニオン型で、認証や表示に使える文字列を明示する。
export type Role = 'admin' | 'public' | 'present';
export type Transport = 'local' | 'cloudflare' | 'https-proxy';
export type QuestionType = 'single' | 'multiple';
export type GraphStyle = 'horizontal' | 'vertical' | 'donut' | 'stacked';

export interface QuestionDraft {
  questionId?: string;
  text: string;
  type: QuestionType;
  options: string[];
  style: GraphStyle;
}

export interface QuestionDefinition extends QuestionDraft {
  questionId: string;
}

export interface PublicQuestion extends QuestionDefinition {
  isOpen: boolean;
  resultsPublished: boolean;
  voteRevision: number;
}

// votes のキーは質問ごとの仮名。票の Map は運営・参加・発表のどの API にも含めない。
export interface Question extends PublicQuestion {
  everOpened: boolean;
  votes: Map<string, number[]>;
}

export type ModerationMode = 'manual' | 'instant';
export type CommentVisibility = 'pending' | 'published' | 'hidden';

export interface DiscussionSettings {
  moderationMode: ModerationMode;
  maxPostsPerToken: 1 | 3 | 'unlimited';
}

export interface DiscussionDraft {
  questionId?: string;
  type: 'discussion';
  text: string;
  settings?: Partial<DiscussionSettings>;
}

export interface DiscussionDefinition extends DiscussionDraft {
  questionId: string;
  settings: DiscussionSettings;
}

export interface PublicDiscussion {
  questionId: string;
  questionOrder: number;
  text: string;
  type: 'discussion';
  isOpen: boolean;
  discussionRevision: number;
}

export interface AdminDiscussion extends PublicDiscussion {
  everOpened: boolean;
  settings: DiscussionSettings;
  commentCount: number;
  presentation: DiscussionPresentation;
}

export interface DiscussionPresentation {
  focusedCommentId: string | null;
  hidePresented: boolean;
  freezeOrder: boolean;
}

export type PresentedComment = Pick<PublicComment, 'commentId' | 'body' | 'likes' | 'presented'>;

export interface PresentDiscussion extends PublicDiscussion {
  presentation: DiscussionPresentation;
  comments: PresentedComment[];
}

// action で必要な入力を分ける。紹介済みは反転ではなく明示値なので再送しても二重反転しない。
export type DiscussionControlInput = {
  sessionId: string;
  questionId: string;
  discussionRevision: number;
} & (
  | { action: 'list' }
  | { action: 'focus'; commentId: string }
  | { action: 'set-presented'; commentId: string; presented: boolean }
  | { action: 'configure'; hidePresented: boolean; freezeOrder: boolean }
);

export interface PublicComment {
  commentId: string;
  body: string;
  likes: number;
  presented: boolean;
  likedByYou: boolean;
  authoredByYou: boolean;
}

export interface AdminComment extends Omit<PublicComment, 'likedByYou' | 'authoredByYou'> {
  visibility: CommentVisibility;
}

interface DiscussionRequest {
  sessionId: string;
  questionId: string;
  discussionRevision: number;
  voterToken: string;
}

export interface PostCommentInput extends DiscussionRequest {
  body: string;
  clientSubmissionId: string;
}

export interface SetLikeInput extends DiscussionRequest {
  commentId: string;
  liked: boolean;
}

export interface CommentReceipt {
  commentId: string;
  visibility: CommentVisibility;
}

export interface LikeReceipt {
  commentId: string;
  liked: boolean;
  likes: number;
}

export interface PublicComments {
  sessionId: string;
  questionId: string;
  discussionRevision: number;
  revision: number;
  comments: PublicComment[];
}

export interface AdminComments {
  sessionId: string;
  questionId: string;
  discussionRevision: number;
  comments: AdminComment[];
}

export interface CommentControlInput {
  sessionId: string;
  questionId: string;
  discussionRevision: number;
  commentId: string;
  action: 'publish' | 'hide' | 'delete';
  expectedVisibility: CommentVisibility;
  confirm?: boolean;
}

export interface OptionResult {
  optionIndex: number;
  optionText: string;
  optionVotes: number;
  percentage: number;
}

export interface Tally {
  respondentCount: number;
  totalSelections: number;
  options: OptionResult[];
}

export interface Presentation {
  questionId: string | null;
  mode: 'question' | 'results';
}

// 受理する JSON の型。受信直後は unknown として扱い、値はサーバーで検証する。
export interface VoteInput {
  questionId: string;
  voterToken: string;
  choices: number | number[]; // 複数選択の空配列は保存済み回答の取り消し。
  voteRevision: number;
}

export interface DeckInput {
  questions: (QuestionDraft | DiscussionDraft)[];
  deckRevision: number;
  replace?: boolean;
  confirmReset?: boolean;
}

export type ControlInput =
  | { action: 'erase'; questionId?: never; confirm: true; sessionId: string }
  | { action: 'extend-expiry'; questionId?: never; confirm?: never; sessionId: string }
  | { action: 'advance'; questionId: string; sessionId: string; deckRevision: number }
  | { action: 'show-results' | 'show-question'; questionId?: never; confirm?: boolean }
  | { action: 'open' | 'select' | 'close' | 'publish' | 'unpublish'; questionId: string; confirm?: boolean }
  | { action: 'reset-votes'; questionId: string; confirm: true };

interface StateBase {
  sessionId: string;
  revision: number;
}

export interface PublicState extends StateBase {
  questions: PublicQuestion[];
  discussions?: PublicDiscussion[];
}

export interface PresentState extends StateBase {
  participantCode: string;
  mode: Presentation['mode'];
  question: (PublicQuestion & { respondentCount: number; results?: Tally }) | null;
  discussion?: PresentDiscussion;
}

export interface AdminState extends StateBase {
  expiresAt: number;
  serverTime: number;
  deckRevision: number;
  participantCode: string;
  presentationToken: string;
  presentation: Presentation;
  questions: (PublicQuestion & { everOpened: boolean; results: Tally })[];
  discussions?: AdminDiscussion[];
}

export interface PreflightStatus {
  origin: string;
  transport: Transport;
  sessionId: string;
  participantCode: string;
  presentationToken: string;
}

export interface PublicResults extends Tally {
  sessionId: string;
  question: PublicQuestion;
}

export interface VoteReceipt {
  sessionId: string;
  voteRevision: number;
}

export interface ResultsExport {
  format: 'pochipoll-results';
  version: 1;
  sessionId: string;
  exportedAt: string;
  questions: (Tally & {
    questionId: string;
    questionOrder: number;
    questionText: string;
    questionType: QuestionType;
  })[];
}

export interface CommentsExport {
  format: 'pochipoll-comments';
  version: 1;
  sessionId: string;
  exportedAt: string;
  topics: {
    questionId: string;
    questionOrder: number;
    questionText: string;
    settings: DiscussionSettings;
    comments: { commentId: string; text: string; likes: number; presented: boolean }[];
  }[];
}

export interface ErrorResponse {
  error: string;
  code?: 'deck_changed' | 'confirm_reset' | 'vote_closed' | 'vote_changed' | 'vote_full';
}
