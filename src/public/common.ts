import type { AdminComments, AdminState, CommentControlInput, CommentReceipt, ControlInput, DeckInput, DiscussionControlInput, GraphStyle, LikeReceipt, PostCommentInput,
  PreflightStatus, PresentState, PublicComments, PublicResults, PublicState, SetLikeInput, VoteInput, VoteReceipt
} from '../types.js';

// DOM の検索結果は null の場合がある。型を指定したときは実際の要素も検査する。
export function $(id: string): HTMLElement;
export function $<ElementType extends HTMLElement>(id: string, type: new () => ElementType): ElementType;
export function $(id: string, type?: new () => HTMLElement): HTMLElement {
  const element = document.getElementById(id);
  if (!element || (type && !(element instanceof type))) throw new Error('画面の要素を確認してください。: ' + id);
  return element;
}

interface ElementOptions {
  cls?: string;
  text?: string | number;
  attrs?: Record<string, string | number>;
}

// タグ名から固有の要素型を推論する。たとえば el('input') では value を参照できる。
export function el<Tag extends keyof HTMLElementTagNameMap>(
  tag: Tag, { cls, text, attrs = {} }: ElementOptions = {}, ...children: (Node | string)[]
) {
  const element = document.createElement(tag);
  if (cls) element.className = cls;
  if (text !== undefined) element.textContent = String(text);
  for (const [key, value] of Object.entries(attrs)) element.setAttribute(key, String(value));
  element.append(...children);
  return element;
}

export function button(label: string, handler: (event: MouseEvent) => void, cls?: string, disabled = false) {
  const element = el('button', { cls, text: label, attrs: { type: 'button' } });
  element.addEventListener('click', handler);
  element.disabled = disabled;
  return element;
}

export function message(text: string, target = $('notice')) {
  target.textContent = text;
  target.hidden = !text;
}

export function connection(text: string, disconnected = false) {
  const target = $('connection');
  if (target.textContent !== text) target.textContent = text;
  target.classList.toggle('offline', disconnected);
}

export function storageGet(store: Storage, name: string) {
  try { return store.getItem(name); } catch { return null; }
}

export function storageSet(store: Storage, name: string, value: string | null) {
  try {
    if (value === null) store.removeItem(name);
    else store.setItem(name, value);
    return true;
  } catch {
    return false;
  }
}

export function readFragment() {
  const fragment = location.hash.slice(1);
  if (location.hash) history.replaceState(null, '', location.pathname + location.search);
  return fragment;
}

export function tabCredential(name: 'admin' | 'present') {
  const keyName = 'fakeslido:' + name;
  const fragment = readFragment();
  if (fragment) storageSet(sessionStorage, keyName, fragment);
  return fragment || storageGet(sessionStorage, keyName);
}

export function participantUrl(code: string) {
  return location.origin + '/#' + code;
}

const hostname = location.hostname.replace(/\.$/, '');
const loopback = hostname === 'localhost' || hostname.endsWith('.localhost')
  || /^127(?:\.\d+){3}$/.test(hostname) || hostname === '[::1]';
export const canShareParticipantUrl = location.protocol === 'https:' && !loopback;

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function errorMessage(error: unknown, fallback: string) {
  return error instanceof Error && error.message ? error.message : fallback;
}

export class RequestError extends Error {
  readonly status: number;
  readonly code: string | undefined;
  readonly retryAfter: number;

  constructor(response: Response, body: unknown) {
    const details = isRecord(body) ? body : undefined;
    super(typeof details?.error === 'string' ? details.error : 'サーバーとの通信に失敗しました。');
    this.status = response.status;
    this.code = typeof details?.code === 'string' ? details.code : undefined;
    const header = response.headers.get('Retry-After');
    const seconds = header && !/^\d+$/.test(header) ? (Date.parse(header) - Date.now()) / 1000 : Number(header);
    this.retryAfter = Number.isFinite(seconds) ? Math.max(0, Math.ceil(seconds)) : 0;
  }
}

type Credential = string | null;

interface RequestOptions {
  method?: 'GET' | 'POST' | 'PUT';
  data?: unknown;
  download?: boolean;
  voterToken?: string;
}

async function fetchResponse(path: string, token: Credential, { method = 'GET', data, voterToken }: RequestOptions = {}) {
  const headers = new Headers({ Authorization: 'Bearer ' + token });
  if (data !== undefined) headers.set('Content-Type', 'application/json');
  if (voterToken !== undefined) headers.set('X-PochiPoll-Voter', voterToken);
  const response = await fetch(path, {
    method, headers, body: data === undefined ? undefined : JSON.stringify(data),
    signal: AbortSignal.timeout(25_000), cache: 'no-store', credentials: 'omit'
  });
  if (!response.ok) throw new RequestError(response, await response.json().catch(() => null));
  return response;
}

interface Mutations {
  '/api/admin/discussions/control': { options: { method: 'POST'; data: DiscussionControlInput }; response: AdminState };
  '/api/admin/comments/control': { options: { method: 'POST'; data: CommentControlInput }; response: AdminState };
  '/api/admin/control': { options: { method: 'POST'; data: ControlInput }; response: AdminState };
  '/api/admin/deck': { options: { method: 'PUT'; data: Omit<DeckInput, 'questions'> & { questions: unknown[] } };
    response: AdminState };
  '/api/public/vote': { options: { method: 'POST'; data: VoteInput }; response: VoteReceipt };
  '/api/public/comments': { options: { method: 'POST'; data: PostCommentInput }; response: CommentReceipt };
  '/api/public/likes': { options: { method: 'POST'; data: SetLikeInput }; response: LikeReceipt };
}

export type ExportFormat = 'csv' | 'json';
type ExportPath = `/api/admin/export?format=${ExportFormat | `${ExportFormat}&sessionId=${string}`}`;

// 同一オリジンの API を共有型に結び付ける。外部ファイルや保存データの読み込みには使わない。
export function request<Path extends keyof Mutations>(
  path: Path, token: Credential, options: Mutations[NoInfer<Path>]['options']
): Promise<Mutations[Path]['response']>;
export function request(path: `/api/public/results?questionId=${string}`, token: Credential): Promise<PublicResults>;
export function request(path: '/api/admin/preflight', token: Credential): Promise<PreflightStatus>;
export function request(path: `/api/admin/comments?questionId=${string}`, token: Credential): Promise<AdminComments>;
export function request(path: '/api/public/state', token: Credential): Promise<PublicState>;
export function request(
  path: `/api/public/comments?questionId=${string}`, token: Credential, options: { voterToken: string }
): Promise<PublicComments | null>;
export function request(path: '/api/present/state', token: Credential): Promise<PresentState>;
export function request(
  path: ExportPath, token: Credential, options: { download: true }
): Promise<Blob>;
export function request(
  path: `/api/admin/export-comments?sessionId=${string}`, token: Credential, options: { download: true }
): Promise<Blob>;
export async function request(path: string, token: Credential, options: RequestOptions = {}): Promise<unknown> {
  const response = await fetchResponse(path, token, options);
  if (response.status === 204) return null;
  return options.download ? response.blob() : response.json();
}

interface StateByPath {
  '/api/admin/state': AdminState;
  '/api/public/state': PublicState;
  '/api/present/state': PresentState;
}

export type PollConnection = 'connected' | 'reconnecting' | 'invalid';

interface PollOptions<State> {
  interval: number;
  onState: (state: State) => void | Promise<void>;
  onUnchanged?: () => void;
  onInvalid: (text: string) => void;
  onConnection?: (state: PollConnection) => void;
}

export async function poll<Path extends keyof StateByPath>(
  path: Path, token: Credential, { interval, onState, onUnchanged, onInvalid, onConnection }: PollOptions<StateByPath[Path]>
) {
  if (!token) {
    connection('未接続', true);
    onConnection?.('invalid');
    onInvalid('アクセス用URLから開いてください。');
    return;
  }
  let revision: number | null = null;
  let delay = 0;
  let retries = 0;
  while (true) {
    if (delay) await new Promise(resolve => setTimeout(resolve, delay));
    try {
      const response = await fetchResponse(path + (revision === null ? '' : '?revision=' + revision), token);
      if (response.status === 204) {
        onUnchanged?.();
      } else {
        const data: StateByPath[Path] = await response.json();
        await onState(data);
        revision = data.revision;
      }
      connection('接続済み');
      onConnection?.('connected');
      delay = interval;
      retries = 0;
    } catch (error) {
      if (error instanceof RequestError && (error.status === 401 || error.status === 410)) {
        connection('未接続', true);
        onConnection?.('invalid');
        onInvalid(error.message);
        return;
      }
      connection('再接続中', true);
      onConnection?.('reconnecting');
      revision = null;
      delay = Math.max((error instanceof RequestError ? error.retryAfter : 0) * 1000,
        Math.min(1000 * 2 ** retries, 15_000));
      retries = Math.min(retries + 1, 4);
    }
  }
}

export function downloadFile(name: string, blob: Blob) {
  const url = URL.createObjectURL(blob);
  const link = el('a', { attrs: { href: url, download: name } });
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export const styleLabels = {
  horizontal: '横棒グラフ', vertical: '縦棒グラフ', donut: 'ドーナツ', stacked: '横帯'
} satisfies Record<GraphStyle, string>;

export function emptyState(title: string, text: string) {
  return el('div', { cls: 'empty-state' }, el('img', { attrs: { src: '/mark.svg', alt: '', width: 44, height: 44 } }),
    el('h2', { text: title }), el('p', { text }));
}

export function statusPill(open: boolean, everOpened = true) {
  return el('span', {
    cls: 'pill ' + (open ? 'pill-live' : 'pill-muted'),
    text: open ? '受付中' : everOpened ? '受付終了' : '未オープン'
  });
}
