'use strict';

const APP_VERSION = '1.2.0';
const APP_TITLE = 'Тренажёр МЧС';
const STATE_SCHEMA = 1;
const EXAM_SIZE = 20;
const EXAM_DURATION_MS = 20 * 60 * 1000;
const DEFAULT_PASS_THRESHOLD = 18;
const LEARNED_STREAK = 2; // столько правильных подряд — вопрос выучен и уходит из «Ошибок»
const GRADES = { ok: 'Справился', partial: 'Частично', fail: 'Не справился' };
const MAX_MISSED_SHADE = 10; // столько пропущенных дней и больше — красный цвет
const DAILY_GOAL = 10;       // ответов в день, чтобы день засчитался в серию (как урок в Duolingo)

const mainEl = document.getElementById('main');
const titleEl = document.getElementById('header-title');
const backEl = document.getElementById('header-back');
const settingsLinkEl = document.getElementById('header-settings');
const toastEl = document.getElementById('toast');
const importInput = document.getElementById('import-input');

const ENCRYPTED_BANK_URL = 'questions.enc.json';
const KEY_STORAGE = 'unlock';

let bank = null;          // расшифрованный и нормализованный банк вопросов
let lockedBank = null;    // зашифрованный банк, ждущий пароля
let questionsById = new Map();
let categoriesById = new Map();
let state = null;         // прогресс пользователя
let session = null;       // текущая тренировка (в памяти)
let animateChoice = false; // только что выбран вариант ответа — анимировать его в следующей отрисовке
const revealedScenarios = new Set();

/* ================= Хранилище ================= */

const storage = (() => {
  const DB_NAME = 'ods-trainer';
  const STORE = 'kv';
  const LS_PREFIX = 'ods-trainer-';
  let db = null;
  let kind = 'memory';

  function openDb() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
      req.onblocked = () => reject(new Error('IndexedDB заблокирована'));
    });
  }

  function request(mode, fn) {
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, mode);
      const req = fn(tx.objectStore(STORE));
      tx.oncomplete = () => resolve(req.result);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  }

  function localStorageWorks() {
    try {
      localStorage.setItem('__ods_test', '1');
      localStorage.removeItem('__ods_test');
      return true;
    } catch (e) {
      return false;
    }
  }

  return {
    get kind() { return kind; },

    async init() {
      try {
        if (!('indexedDB' in window)) throw new Error('IndexedDB недоступна');
        db = await openDb();
        kind = 'indexeddb';
        return;
      } catch (e) {
        console.warn('IndexedDB:', e);
        db = null;
      }
      kind = localStorageWorks() ? 'localstorage' : 'memory';
    },

    async get(key) {
      if (db) {
        try {
          const value = await request('readonly', (s) => s.get(key));
          if (value) return value;
        } catch (e) {
          console.warn('Чтение IndexedDB:', e);
        }
      }
      try {
        const raw = localStorage.getItem(LS_PREFIX + key);
        return raw ? JSON.parse(raw) : null;
      } catch (e) {
        return null;
      }
    },

    async set(key, value) {
      if (db) {
        try {
          await request('readwrite', (s) => s.put(value, key));
          return true;
        } catch (e) {
          console.warn('Запись IndexedDB:', e);
        }
      }
      try {
        localStorage.setItem(LS_PREFIX + key, JSON.stringify(value));
        return true;
      } catch (e) {
        console.warn('Запись localStorage:', e);
        return false;
      }
    },

    async remove(key) {
      if (db) {
        try {
          await request('readwrite', (s) => s.delete(key));
        } catch (e) {
          console.warn('Удаление IndexedDB:', e);
        }
      }
      try {
        localStorage.removeItem(LS_PREFIX + key);
      } catch (e) { /* не критично */ }
    },
  };
})();

let saveTimer = null;
let saveWarned = false;

function save() {
  clearTimeout(saveTimer);
  saveTimer = null;
  return storage.set('state', state).then((ok) => {
    if (!ok && !saveWarned) {
      saveWarned = true;
      toast('Не удалось сохранить прогресс на устройстве');
    }
  });
}

function saveSoon() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(save, 400);
}

/* ================= Состояние ================= */

function defaultState() {
  return {
    schema: STATE_SCHEMA,
    progress: {},   // id вопроса → { shown, correct, streak, last, mistake }
    scenarios: {},  // id ситуации → { draft, attempts: [{ date, grade, text }] }
    settings: { passThreshold: DEFAULT_PASS_THRESHOLD },
    exam: null,
    lastExam: null,
    activity: defaultActivity(),
  };
}

function defaultActivity() {
  // lastDone — последний день (ГГГГ-ММ-ДД) с выполненной нормой, streak — серия, закончившаяся этим днём;
  // today и todayCount — сколько ответов засчитано в норму сегодня
  return { lastDone: null, streak: 0, best: 0, today: null, todayCount: 0 };
}

function toCount(v) {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0;
}

function clampThreshold(v) {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n)) return DEFAULT_PASS_THRESHOLD;
  return Math.min(EXAM_SIZE, Math.max(1, n));
}

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function normalizeState(raw) {
  const out = defaultState();
  if (!isPlainObject(raw)) return out;

  if (isPlainObject(raw.progress)) {
    for (const [id, p] of Object.entries(raw.progress)) {
      if (!isPlainObject(p)) continue;
      out.progress[id] = {
        shown: toCount(p.shown),
        correct: toCount(p.correct),
        streak: toCount(p.streak),
        last: toCount(p.last),
        mistake: Boolean(p.mistake),
      };
    }
  }

  if (isPlainObject(raw.scenarios)) {
    for (const [id, s] of Object.entries(raw.scenarios)) {
      if (!isPlainObject(s)) continue;
      out.scenarios[id] = {
        draft: typeof s.draft === 'string' ? s.draft : '',
        attempts: Array.isArray(s.attempts)
          ? s.attempts
            .filter((a) => isPlainObject(a) && typeof a.date === 'string' && GRADES[a.grade])
            .map((a) => ({ date: a.date, grade: a.grade, text: typeof a.text === 'string' ? a.text : '' }))
          : [],
      };
    }
  }

  if (isPlainObject(raw.settings) && raw.settings.passThreshold !== undefined) {
    out.settings.passThreshold = clampThreshold(raw.settings.passThreshold);
  }

  const ex = raw.exam;
  if (isPlainObject(ex) && Number.isFinite(ex.startedAt) && Array.isArray(ex.ids)
    && isPlainObject(ex.orders) && isPlainObject(ex.answers)) {
    out.exam = {
      startedAt: ex.startedAt,
      ids: ex.ids.map(String),
      orders: ex.orders,
      answers: ex.answers,
      pos: toCount(ex.pos),
    };
  }

  if (isPlainObject(raw.lastExam) && Array.isArray(raw.lastExam.items)) {
    out.lastExam = raw.lastExam;
  }

  const a = raw.activity;
  if (isPlainObject(a)) {
    const day = (v) => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null);
    out.activity = {
      lastDone: day(a.lastDone),
      streak: toCount(a.streak),
      best: toCount(a.best),
      today: day(a.today),
      todayCount: toCount(a.todayCount),
    };
  }

  return out;
}

/* ================= Серия дней ================= */

function dayKey(date) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function daysBetween(fromKey, toKey) {
  const toUtc = (key) => {
    const [y, m, d] = key.split('-').map(Number);
    return Date.UTC(y, m - 1, d);
  };
  return Math.round((toUtc(toKey) - toUtc(fromKey)) / 86400000);
}

// Серия по правилам Duolingo: день засчитывается, когда выполнена дневная норма;
// пропущенный день без нормы обнуляет серию. Норма сегодня не выполнена — серия ещё жива до полуночи.
function streakStatus() {
  const a = state.activity;
  const today = dayKey(new Date());
  const gap = a.lastDone ? Math.max(0, daysBetween(a.lastDone, today)) : null;
  const todayCount = a.today === today ? a.todayCount : 0;
  return {
    never: gap === null,
    doneToday: gap === 0,
    atRisk: gap === 1,
    streak: gap === 0 || gap === 1 ? a.streak : 0,
    best: a.best,
    missed: gap === null || gap <= 1 ? 0 : gap - 1, // полных дней без нормы
    todayCount: Math.min(todayCount, DAILY_GOAL),
    left: Math.max(0, DAILY_GOAL - todayCount),
  };
}

// Засчитывает ответы в дневную норму. Возвращает true, если норма выполнена только что.
function countPractice(amount) {
  const a = state.activity;
  const today = dayKey(new Date());
  if (a.today !== today) {
    a.today = today;
    a.todayCount = 0;
  }
  a.todayCount += amount;
  if (a.todayCount < DAILY_GOAL || a.lastDone === today) return false;
  const gap = a.lastDone ? daysBetween(a.lastDone, today) : null;
  a.streak = gap === 1 ? a.streak + 1 : 1;
  a.best = Math.max(a.best, a.streak);
  a.lastDone = today;
  return true;
}

function celebrateGoal() {
  const n = state.activity.streak;
  toast(`Норма выполнена: ${n} ${plural(n, ['день', 'дня', 'дней'])} подряд`);
}

// Слова начальника ЦУКС: по серии, по невыполненной норме и по числу пропущенных дней
function bossPhrase(st) {
  const days = (n) => `${n} ${plural(n, ['день', 'дня', 'дней'])}`;
  const left = `Осталось ${st.left} ${plural(st.left, ['вопрос', 'вопроса', 'вопросов'])}.`;
  if (st.never) {
    if (st.todayCount > 0) return `Первое дежурство идёт: ${st.todayCount} из ${DAILY_GOAL}. Добей норму — и серия пошла. ${left}`;
    return `Заступаешь на первое дежурство. Норма — ${DAILY_GOAL} вопросов в день. Приступай.`;
  }
  if (st.doneToday) {
    const tomorrow = `Завтра будет ${days(st.streak + 1)} подряд — не сорви.`;
    if (st.streak >= 30) return `Месяц без пропусков. Такого дежурного хоть сейчас в старшие. ${tomorrow}`;
    if (st.streak >= 14) return `Две недели без пропусков. На разборе поставлю тебя в пример. ${tomorrow}`;
    if (st.streak >= 7) return `Неделя без пропусков. Вот это оперативная готовность. ${tomorrow}`;
    if (st.streak >= 4) return `Заступаешь стабильно. Так и докладывай — без замечаний. ${tomorrow}`;
    return `Норма выполнена. Но один день — ещё не система. ${tomorrow}`;
  }
  if (st.atRisk) {
    if (st.streak >= 7) return `Сегодня ты ещё не заступал. ${days(st.streak)} подряд сгорят в полночь — не подводи смену. ${left}`;
    return `Норма на сегодня не выполнена. Серия ${days(st.streak)} сгорит в полночь. ${left}`;
  }
  if (st.missed === 1) return 'Вчера норма не выполнена — серия сгорела. Начинай заново, пока не вошло в привычку.';
  if (st.missed <= 3) return `${days(st.missed)} тишины. В ЦУКС так не работают — догоняй.`;
  if (st.missed <= 6) return `Тебя не было ${days(st.missed)}. Обстановка меняется каждые сутки, а ты — нет.`;
  if (st.missed < MAX_MISSED_SHADE) return `${days(st.missed)} без тренировки. Готовь объяснительную или садись за вопросы.`;
  return `${days(st.missed)} без доклада. Я уже решил, что ты сменил место службы. Срочно за тренажёр.`;
}

const STREAK_ICON = '<svg viewBox="0 0 24 24" width="30" height="30" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 21.5c3.9 0 6.5-2.7 6.5-6.4 0-3.3-2-5.6-3.6-7.6-.5 1.8-1.4 3-2.6 3.6.2-3.2-1.3-5.9-3.6-8.1.2 3-1.4 5.1-2.8 7.1-.9 1.4-1.4 3-1.4 4.9 0 3.8 2.6 6.5 6.5 6.5z"/><path d="M12 21.5c-1.7 0-2.8-1.2-2.8-2.8 0-1.8 1.4-2.9 2.3-4.3.9 1.1 3.3 2.4 3.3 4.4 0 1.5-1.1 2.7-2.8 2.7z"/></svg>';

function getProgress(id) {
  return state.progress[String(id)] || { shown: 0, correct: 0, streak: 0, last: 0, mistake: false };
}

function recordAnswer(id, isCorrect) {
  const p = { ...getProgress(id) };
  p.shown += 1;
  if (isCorrect) {
    p.correct += 1;
    p.streak += 1;
    if (p.streak >= LEARNED_STREAK) p.mistake = false;
  } else {
    p.streak = 0;
    p.mistake = true;
  }
  p.last = Date.now();
  state.progress[String(id)] = p;
}

function isLearned(id) {
  return getProgress(id).streak >= LEARNED_STREAK;
}

function statsFor(ids) {
  let shown = 0;
  let correct = 0;
  let learned = 0;
  for (const id of ids) {
    const p = getProgress(id);
    shown += p.shown;
    correct += p.correct;
    if (p.streak >= LEARNED_STREAK) learned += 1;
  }
  return {
    total: ids.length,
    shown,
    learned,
    percent: shown ? Math.round((correct / shown) * 100) : null,
  };
}

function scenarioData(id) {
  return state.scenarios[id] || { draft: '', attempts: [] };
}

function ensureScenarioData(id) {
  if (!state.scenarios[id]) state.scenarios[id] = { draft: '', attempts: [] };
  return state.scenarios[id];
}

/* ================= Банк вопросов ================= */

// Вопросы публикуются зашифрованными (tools/build.mjs): PBKDF2 + AES-GCM.
async function fetchEncryptedBank() {
  const res = await fetch(ENCRYPTED_BANK_URL, { cache: 'no-cache' });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  const env = await res.json();
  if (!isPlainObject(env) || env.format !== 'ods-trainer-encrypted' || !isPlainObject(env.kdf) || !isPlainObject(env.cipher)) {
    throw new Error('Неверный формат файла вопросов');
  }
  return env;
}

function fromBase64(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

function toBase64(buffer) {
  let bin = '';
  for (const b of new Uint8Array(buffer)) bin += String.fromCharCode(b);
  return btoa(bin);
}

function kdfId(env) {
  return [env.kdf.name, env.kdf.hash, env.kdf.iterations, env.kdf.salt].join(':');
}

async function decryptBank(env, key) {
  try {
    const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromBase64(env.cipher.iv) }, key, fromBase64(env.data));
    return normalizeBank(JSON.parse(new TextDecoder().decode(plain)));
  } catch (e) {
    return null;
  }
}

// Ключ, сохранённый после ввода пароля, — чтобы не спрашивать пароль при каждом запуске
async function unlockWithSavedKey(env) {
  const saved = await storage.get(KEY_STORAGE);
  if (!isPlainObject(saved) || saved.kdf !== kdfId(env) || typeof saved.key !== 'string') return null;
  try {
    const key = await crypto.subtle.importKey('raw', fromBase64(saved.key), 'AES-GCM', false, ['decrypt']);
    return await decryptBank(env, key);
  } catch (e) {
    return null;
  }
}

async function unlockWithPassword(env, password) {
  const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveKey']);
  const key = await crypto.subtle.deriveKey(
    { name: 'PBKDF2', hash: env.kdf.hash, salt: fromBase64(env.kdf.salt), iterations: env.kdf.iterations },
    base,
    { name: 'AES-GCM', length: 256 },
    true,
    ['decrypt'],
  );
  const result = await decryptBank(env, key);
  if (result) await storage.set(KEY_STORAGE, { kdf: kdfId(env), key: toBase64(await crypto.subtle.exportKey('raw', key)) });
  return result;
}

function setBank(value) {
  bank = value;
  indexBank();
  sanitizeExam();
  if (state.exam && examRemaining() <= 0) {
    finishExam(true);
    toast('Время экзамена истекло — результат сохранён');
  }
}

function normalizeBank(raw) {
  if (!isPlainObject(raw)) throw new Error('Неверный формат questions.json');

  const categories = (Array.isArray(raw.categories) ? raw.categories : [])
    .filter((c) => isPlainObject(c) && c.id != null)
    .map((c) => ({ id: String(c.id), title: c.title != null ? String(c.title) : String(c.id) }));

  const seen = new Set();
  let skipped = 0;
  const questions = [];
  for (const q of Array.isArray(raw.questions) ? raw.questions : []) {
    const valid = isPlainObject(q) && q.id != null && typeof q.question === 'string'
      && Array.isArray(q.options) && q.options.length >= 2
      && Number.isInteger(q.correct) && q.correct >= 0 && q.correct < q.options.length
      && !seen.has(String(q.id));
    if (!valid) {
      skipped += 1;
      continue;
    }
    seen.add(String(q.id));
    questions.push({
      id: String(q.id),
      category: q.category != null ? String(q.category) : '',
      question: q.question,
      options: q.options.map(String),
      correct: q.correct,
      explanation: typeof q.explanation === 'string' ? q.explanation : '',
      source: typeof q.source === 'string' ? q.source : '',
    });
  }

  const scenarios = (Array.isArray(raw.scenarios) ? raw.scenarios : [])
    .filter((s) => isPlainObject(s) && s.id != null && typeof s.situation === 'string')
    .map((s) => ({
      id: String(s.id),
      title: typeof s.title === 'string' ? s.title : '',
      situation: s.situation,
      answer: Array.isArray(s.answer) ? s.answer.map(String) : [],
    }));

  return {
    version: raw.version != null ? String(raw.version) : '',
    updated: raw.updated != null ? String(raw.updated) : '',
    note: typeof raw.note === 'string' ? raw.note : '',
    categories,
    questions,
    scenarios,
    skipped,
  };
}

function indexBank() {
  questionsById = new Map(bank.questions.map((q) => [q.id, q]));
  categoriesById = new Map(bank.categories.map((c) => [c.id, c]));
}

function categoryTitle(id) {
  const c = categoriesById.get(id);
  return c ? c.title : '';
}

function questionsInCategory(catId) {
  return bank.questions.filter((q) => q.category === catId).map((q) => q.id);
}

function mistakeIds() {
  return bank.questions
    .filter((q) => getProgress(q.id).mistake)
    .sort((a, b) => getProgress(a.id).last - getProgress(b.id).last)
    .map((q) => q.id);
}

/* ================= Утилиты ================= */

function esc(v) {
  return String(v == null ? '' : v).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function range(n) {
  return Array.from({ length: n }, (_, i) => i);
}

function plural(n, forms) {
  const n10 = n % 10;
  const n100 = n % 100;
  if (n10 === 1 && n100 !== 11) return forms[0];
  if (n10 >= 2 && n10 <= 4 && (n100 < 10 || n100 >= 20)) return forms[1];
  return forms[2];
}

function formatDateTime(value) {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleString('ru-RU', {
    day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit',
  });
}

function formatBankDate(value) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  return m ? `${m[3]}.${m[2]}.${m[1]}` : value;
}

function formatDuration(ms) {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

function percentText(p) {
  return p == null ? '—' : p + '%';
}

let toastTimer = null;

function toast(text) {
  toastEl.textContent = text;
  toastEl.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toastEl.hidden = true; }, 2600);
}

function emptyState(text) {
  return `<p class="empty-state">${esc(text)}</p>`;
}

/* ================= Тренировка ================= */

// Сначала вопросы с ошибками, затем — давно не повторённые (новые считаются самыми давними).
function orderByPriority(ids) {
  return shuffle(ids.slice()).sort((a, b) => {
    const pa = getProgress(a);
    const pb = getProgress(b);
    if (pa.mistake !== pb.mistake) return pa.mistake ? -1 : 1;
    return pa.last - pb.last;
  });
}

function createSession(key) {
  let ids;
  if (key === 'all') ids = bank.questions.map((q) => q.id);
  else if (key === 'mistakes') ids = mistakeIds();
  else if (categoriesById.has(key)) ids = questionsInCategory(key);
  else return { key, queue: [], pos: 0, right: 0, current: null, unknown: true };
  return { key, queue: orderByPriority(ids), pos: 0, right: 0, current: null };
}

function renderTrain(key = 'all') {
  if (!session || session.key !== key) session = createSession(key);

  const title = key === 'all' ? 'Тренировка' : key === 'mistakes' ? 'Работа над ошибками' : (categoryTitle(key) || 'Тренировка');
  const back = key === 'all' ? '#/' : key === 'mistakes' ? '#/mistakes' : '#/docs';

  if (session.unknown) return { title, back, html: emptyState('Такого раздела нет в банке вопросов.') };
  if (!session.queue.length) {
    const text = key === 'mistakes' ? 'Ошибок нет.' : 'В этом разделе пока нет вопросов.';
    return { title, back, html: emptyState(text) };
  }

  if (session.pos >= session.queue.length) return { title, back, html: trainSummaryHtml(key) };

  const id = session.queue[session.pos];
  const q = questionsById.get(id);
  if (!session.current || session.current.id !== id) {
    // Варианты перемешиваются при каждом показе вопроса
    session.current = { id, order: shuffle(range(q.options.length)), chosen: null };
  }
  const cur = session.current;
  const answered = cur.chosen !== null;
  const isRight = answered && cur.chosen === q.correct;
  const isLast = session.pos === session.queue.length - 1;

  const options = cur.order.map((orig) => {
    let cls = '';
    if (answered && orig === q.correct) cls = ' is-correct';
    else if (answered && orig === cur.chosen) cls = ' is-wrong';
    if (cls && animateChoice) cls += ' is-animated';
    return `<button type="button" class="option${cls}" data-action="train-answer" data-orig="${orig}"${answered ? ' disabled' : ''}>${esc(q.options[orig])}</button>`;
  }).join('');

  const feedback = answered ? `
    <section class="feedback ${isRight ? 'is-ok' : 'is-bad'}">
      <p class="feedback-verdict">${isRight ? 'Верно' : 'Неверно'}</p>
      ${q.explanation ? `<p>${esc(q.explanation)}</p>` : ''}
      ${q.source ? `<p class="source">Источник: ${esc(q.source)}</p>` : ''}
    </section>
    <div class="action-bar">
      <button type="button" class="btn btn-primary" data-action="train-next">${isLast ? 'Завершить' : 'Дальше'}</button>
    </div>` : '';

  const html = `
    <div class="quiz-meta">
      <span>Вопрос ${session.pos + 1} из ${session.queue.length}</span>
      ${categoryTitle(q.category) ? `<span class="tag">${esc(categoryTitle(q.category))}</span>` : ''}
    </div>
    <progress class="progress" max="${session.queue.length}" value="${session.pos + (answered ? 1 : 0)}"></progress>
    <h2 class="question-text">${esc(q.question)}</h2>
    <div class="options">${options}</div>
    ${feedback}`;

  return {
    title,
    back,
    html,
    after: answered ? () => {
      const fb = mainEl.querySelector('.feedback');
      if (fb) fb.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    } : null,
  };
}

function trainSummaryHtml(key) {
  const total = session.queue.length;
  const pct = Math.round((session.right / total) * 100);
  const extra = key === 'mistakes'
    ? `<p class="muted">Осталось в «Ошибках»: ${mistakeIds().length}</p>`
    : '';
  return `
    <section class="card result-card">
      <p class="result-verdict">Готово</p>
      <p class="result-score">Верно ${session.right} из ${total} (${pct}%)</p>
      ${extra}
    </section>
    <div class="stack spaced">
      <button type="button" class="btn btn-primary btn-block" data-action="train-restart">Пройти ещё раз</button>
      <a class="btn btn-block" href="#/">На главную</a>
    </div>`;
}

/* ================= Экзамен ================= */

function examSize() {
  return Math.min(EXAM_SIZE, bank.questions.length);
}

function effectiveThreshold(total) {
  return Math.min(state.settings.passThreshold, total);
}

function examRemaining() {
  return state.exam ? EXAM_DURATION_MS - (Date.now() - state.exam.startedAt) : 0;
}

// Банк могли обновить посреди экзамена — убираем исчезнувшие вопросы и чиним порядок вариантов.
function sanitizeExam() {
  const ex = state.exam;
  if (!ex) return;
  ex.ids = ex.ids.filter((id) => questionsById.has(id));
  if (!ex.ids.length) {
    state.exam = null;
    return;
  }
  for (const id of ex.ids) {
    const n = questionsById.get(id).options.length;
    const order = ex.orders[id];
    const valid = Array.isArray(order) && order.length === n && range(n).every((i) => order.includes(i));
    if (!valid) ex.orders[id] = shuffle(range(n));
    if (ex.answers[id] != null && !(Number.isInteger(ex.answers[id]) && ex.answers[id] < n)) delete ex.answers[id];
  }
  if (ex.pos >= ex.ids.length) ex.pos = ex.ids.length - 1;
}

function startExam() {
  const ids = shuffle(bank.questions.map((q) => q.id)).slice(0, examSize());
  const orders = {};
  for (const id of ids) orders[id] = shuffle(range(questionsById.get(id).options.length));
  state.exam = { startedAt: Date.now(), ids, orders, answers: {}, pos: 0 };
  save();
}

function finishExam(timeout) {
  const ex = state.exam;
  if (!ex) return;
  const items = ex.ids.filter((id) => questionsById.has(id)).map((id) => {
    const q = questionsById.get(id);
    const chosen = Number.isInteger(ex.answers[id]) ? ex.answers[id] : null;
    const ok = chosen === q.correct;
    recordAnswer(id, ok);
    return { id, chosen, ok };
  });
  const score = items.filter((i) => i.ok).length;
  const threshold = effectiveThreshold(items.length);
  const goalReached = countPractice(items.filter((i) => i.chosen !== null).length);
  state.lastExam = {
    date: new Date().toISOString(),
    durationMs: Math.min(Date.now() - ex.startedAt, EXAM_DURATION_MS),
    timeout: Boolean(timeout),
    total: items.length,
    score,
    threshold,
    passed: score >= threshold,
    items,
  };
  state.exam = null;
  save();
  if (goalReached) celebrateGoal();
}

function answeredCount() {
  return state.exam.ids.filter((id) => Number.isInteger(state.exam.answers[id])).length;
}

function renderExam(arg) {
  if (arg === 'result') return renderExamResult();
  if (state.exam && examRemaining() <= 0) {
    finishExam(true);
    return renderExamResult();
  }
  if (!state.exam) return renderExamIntro();

  const ex = state.exam;
  const id = ex.ids[ex.pos];
  const q = questionsById.get(id);
  const chosen = ex.answers[id];
  const total = ex.ids.length;
  const isLast = ex.pos === total - 1;
  const remaining = examRemaining();

  const options = ex.orders[id].map((orig) => `
    <button type="button" class="option${chosen === orig ? ` is-selected${animateChoice ? ' is-animated' : ''}` : ''}" data-action="exam-choose" data-orig="${orig}">${esc(q.options[orig])}</button>`).join('');

  return {
    title: 'Экзамен',
    back: '#/',
    html: `
      <div class="quiz-meta">
        <span>Вопрос ${ex.pos + 1} из ${total}</span>
        <span class="exam-timer${remaining < 60000 ? ' is-low' : ''}" data-exam-timer>${formatDuration(remaining)}</span>
      </div>
      <progress class="progress" max="${total}" value="${answeredCount()}"></progress>
      <h2 class="question-text">${esc(q.question)}</h2>
      <div class="options">${options}</div>
      <p class="muted spaced">Отвечено ${answeredCount()} из ${total}. Ответ можно изменить до завершения.</p>
      <div class="action-bar">
        <button type="button" class="btn" data-action="exam-prev"${ex.pos === 0 ? ' disabled' : ''}>Назад</button>
        <button type="button" class="btn btn-primary" data-action="${isLast ? 'exam-finish' : 'exam-next'}">${isLast ? 'Завершить' : 'Дальше'}</button>
      </div>
      ${isLast ? '' : '<button type="button" class="btn btn-block" data-action="exam-finish">Завершить экзамен</button>'}`,
  };
}

function renderExamIntro() {
  const n = examSize();
  const last = state.lastExam;
  return {
    title: 'Экзамен',
    back: '#/',
    html: `
      <section class="card">
        <h2>Условия</h2>
        <ul class="facts">
          <li>${n} ${plural(n, ['случайный вопрос', 'случайных вопроса', 'случайных вопросов'])}</li>
          <li>${EXAM_DURATION_MS / 60000} минут</li>
          <li>Подсказок нет — правильные ответы и пояснения после завершения</li>
          <li>Сдано: не менее ${effectiveThreshold(n)} из ${n}</li>
        </ul>
      </section>
      <div class="stack spaced">
        <button type="button" class="btn btn-primary btn-block" data-action="exam-start"${n ? '' : ' disabled'}>Начать экзамен</button>
        ${last ? `<a class="btn btn-block" href="#/exam/result">Последний результат: ${last.score} из ${last.total} — ${last.passed ? 'сдано' : 'не сдано'}</a>` : ''}
      </div>`,
  };
}

function renderExamResult() {
  const r = state.lastExam;
  if (!r) return { title: 'Результат', back: '#/', html: emptyState('Экзамен ещё не сдавался.') };

  const errors = r.items.filter((i) => !i.ok && questionsById.has(String(i.id)));
  const errorsHtml = errors.map((i) => {
    const q = questionsById.get(String(i.id));
    const yours = Number.isInteger(i.chosen) && q.options[i.chosen] != null ? q.options[i.chosen] : null;
    return `
      <article class="card review-item">
        ${categoryTitle(q.category) ? `<p class="list-meta">${esc(categoryTitle(q.category))}</p>` : ''}
        <h4 class="review-question">${esc(q.question)}</h4>
        <p class="answer-line is-wrong">Ваш ответ: ${yours != null ? esc(yours) : 'нет ответа'}</p>
        <p class="answer-line is-correct">Правильно: ${esc(q.options[q.correct])}</p>
        ${q.explanation ? `<p>${esc(q.explanation)}</p>` : ''}
        ${q.source ? `<p class="source">Источник: ${esc(q.source)}</p>` : ''}
      </article>`;
  }).join('');

  return {
    title: 'Результат',
    back: '#/',
    html: `
      <section class="card result-card ${r.passed ? 'is-pass' : 'is-fail'}">
        <p class="result-verdict">${r.passed ? 'Сдано' : 'Не сдано'}</p>
        <p class="result-score">${r.score} из ${r.total}</p>
        <p class="muted">Порог: ${r.threshold} · время: ${formatDuration(r.durationMs)}${r.timeout ? ' (время вышло)' : ''}</p>
        <p class="muted">${esc(formatDateTime(r.date))}</p>
      </section>
      <h3 class="section-title">Ошибки: ${errors.length}</h3>
      ${errors.length ? `<div class="stack">${errorsHtml}</div>` : emptyState('Ошибок нет.')}
      <div class="stack spaced">
        <a class="btn btn-primary btn-block" href="#/exam">Новый экзамен</a>
        <a class="btn btn-block" href="#/">На главную</a>
      </div>`,
  };
}

function tick() {
  if (!state || !state.exam) return;
  const remaining = examRemaining();
  if (remaining <= 0) {
    const onExamScreen = location.hash.startsWith('#/exam');
    finishExam(true);
    toast('Время экзамена вышло');
    if (onExamScreen) navigate('#/exam/result');
    else render();
    return;
  }
  for (const el of document.querySelectorAll('[data-exam-timer]')) {
    el.textContent = formatDuration(remaining);
    el.classList.toggle('is-low', remaining < 60000);
  }
}

/* ================= Экраны ================= */

// Контурные иконки плиток главного экрана: основной цвет — currentColor, акцентная деталь — класс icon-accent
const MENU_ICONS = {
  train: '<path d="M8 3h9.5A2.5 2.5 0 0 1 20 5.5V16"/><rect x="4" y="6" width="13" height="15" rx="2.5"/><path class="icon-accent" d="M7.5 13.5l2.5 2.5 4-4.5"/>',
  exam: '<circle cx="12" cy="13.5" r="7.5"/><path d="M10 2.5h4M12 2.5V6M18.5 7l1.5-1.5"/><path class="icon-accent" d="M12 10v3.5l2.5 2"/>',
  mistakes: '<path d="M10.3 4.4 3 17.1A2 2 0 0 0 4.7 20h14.6a2 2 0 0 0 1.7-2.9L13.7 4.4a2 2 0 0 0-3.4 0z"/><path class="icon-accent" d="M12 9.5v4M12 16.8h.01"/>',
  scenarios: '<path d="M5 4h14a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2h-7l-4.5 3.5V17H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z"/><path class="icon-accent" d="M8 10.5h.01M12 10.5h.01M16 10.5h.01"/>',
  docs: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/><path class="icon-accent" d="M8.5 12.5h7M8.5 16h5"/>',
  settings: '<circle class="icon-accent" cx="12" cy="12" r="3"/><path d="M12 2.5v2.2M12 19.3v2.2M4.6 4.6l1.6 1.6M17.8 17.8l1.6 1.6M2.5 12h2.2M19.3 12h2.2M4.6 19.4l1.6-1.6M17.8 6.2l1.6-1.6"/><circle cx="12" cy="12" r="6.5"/>',
};

function menuIcon(name) {
  return `<span class="menu-icon" aria-hidden="true"><svg viewBox="0 0 24 24" width="28" height="28" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${MENU_ICONS[name]}</svg></span>`;
}

function renderHome() {
  if (!bank) {
    return {
      title: APP_TITLE,
      html: `
        <div class="notice">Не удалось загрузить вопросы. Откройте приложение при подключении к интернету.</div>
        <nav class="menu"><a class="menu-item" href="#/settings">${menuIcon('settings')}<span class="menu-title">Настройки</span><span class="menu-sub">Резервная копия и восстановление</span></a></nav>`,
    };
  }

  const s = statsFor(bank.questions.map((q) => q.id));
  const st = streakStatus();
  const mistakes = mistakeIds().length;
  const storageWarning = storage.kind === 'memory'
    ? '<div class="notice">Хранилище браузера недоступно (например, частный режим) — прогресс не сохранится после закрытия.</div>'
    : '';
  const examCard = state.exam ? `
    <section class="card exam-resume">
      <p><strong>Идёт экзамен.</strong> Осталось <span class="exam-timer" data-exam-timer>${formatDuration(examRemaining())}</span></p>
      <a class="btn btn-primary btn-block" href="#/exam">Продолжить экзамен</a>
    </section>` : '';

  return {
    title: APP_TITLE,
    html: `
      ${storageWarning}
      <section class="card stats-card status-${Math.min(st.missed, MAX_MISSED_SHADE)}${st.doneToday ? '' : ' is-pending'}">
        <div class="streak">
          <span class="streak-icon">${STREAK_ICON}</span>
          <div class="streak-main">
            <div class="streak-count">
              <span class="streak-value">${st.streak}</span>
              <span class="streak-label">${plural(st.streak, ['день', 'дня', 'дней'])} подряд</span>
            </div>
            <span class="streak-today">${st.doneToday ? 'Норма выполнена' : `Норма на сегодня: ${st.todayCount} / ${DAILY_GOAL}`}</span>
          </div>
          <span class="streak-best">Рекорд<br><strong>${st.best}</strong></span>
        </div>
        <blockquote class="boss-quote">
          <p>${esc(bossPhrase(st))}</p>
          <cite>— Начальник ЦУКС</cite>
        </blockquote>
        <div class="stats-row">
          <div class="stats-item">
            <span class="stats-value">${s.percent == null ? 0 : s.percent}%</span>
            <span class="stats-label">правильных ответов</span>
          </div>
          <div class="stats-item">
            <span class="stats-value">${s.learned}<small> / ${s.total}</small></span>
            <span class="stats-label">выучено вопросов</span>
          </div>
        </div>
        <progress class="progress" max="${s.total || 1}" value="${s.learned}"></progress>
        <p class="stats-sub">Ответов дано: ${s.shown}</p>
      </section>
      ${examCard ? `<div class="spaced">${examCard}</div>` : ''}
      <nav class="menu">
        <a class="menu-item" href="#/train/all">
          ${menuIcon('train')}
          <span class="menu-title">Тренировка</span>
          <span class="menu-sub">Все вопросы: сначала ошибки и давно не повторённые</span>
        </a>
        <a class="menu-item" href="#/exam">
          ${menuIcon('exam')}
          <span class="menu-title">Экзамен</span>
          <span class="menu-sub">${examSize()} вопросов · ${EXAM_DURATION_MS / 60000} минут</span>
        </a>
        <a class="menu-item" href="#/mistakes">
          ${menuIcon('mistakes')}
          <span class="menu-title">Ошибки</span>
          <span class="menu-sub">Уходят после ${LEARNED_STREAK} правильных ответов подряд</span>
          <span class="badge${mistakes ? '' : ' badge-muted'}">${mistakes}</span>
        </a>
        <a class="menu-item" href="#/scenarios">
          ${menuIcon('scenarios')}
          <span class="menu-title">Ситуации</span>
          <span class="menu-sub">Свой ответ и сверка с эталоном</span>
          <span class="badge badge-muted">${bank.scenarios.length}</span>
        </a>
        <a class="menu-item" href="#/docs">
          ${menuIcon('docs')}
          <span class="menu-title">По документам</span>
          <span class="menu-sub">Прогресс по каждому разделу</span>
          <span class="badge badge-muted">${bank.categories.length}</span>
        </a>
      </nav>`,
  };
}

function renderUnlock() {
  return {
    title: APP_TITLE,
    html: `
      <form class="card" id="unlock-form">
        <h2>Вход</h2>
        <p class="muted spaced">Вопросы зашифрованы. Введите пароль — на этом устройстве он понадобится один раз.</p>
        <label class="field-label" for="unlock-password">Пароль</label>
        <input id="unlock-password" class="input" type="password" autocomplete="current-password" autocapitalize="off" autocorrect="off" spellcheck="false">
        <p class="field-error" id="unlock-error" hidden></p>
        <button type="submit" class="btn btn-primary btn-block spaced">Открыть</button>
      </form>`,
  };
}

function renderMistakes() {
  const ids = mistakeIds();
  if (!ids.length) {
    return {
      title: 'Ошибки',
      back: '#/',
      html: emptyState(`Ошибок нет. Вопрос попадает сюда после неверного ответа и уходит после ${LEARNED_STREAK} правильных ответов подряд.`),
    };
  }
  const items = ids.map((id) => {
    const q = questionsById.get(id);
    const p = getProgress(id);
    return `
      <article class="card list-item">
        ${categoryTitle(q.category) ? `<p class="list-meta">${esc(categoryTitle(q.category))}</p>` : ''}
        <p class="list-title">${esc(q.question)}</p>
        <p class="list-meta">Верно подряд: ${p.streak} из ${LEARNED_STREAK}</p>
      </article>`;
  }).join('');
  return {
    title: 'Ошибки',
    back: '#/',
    html: `
      <button type="button" class="btn btn-primary btn-block" data-action="go-mistakes-training">Повторить ошибки (${ids.length})</button>
      <div class="stack spaced">${items}</div>`,
  };
}

function renderDocs() {
  if (!bank.categories.length) return { title: 'По документам', back: '#/', html: emptyState('Разделы не заданы в банке вопросов.') };
  const items = bank.categories.map((c) => {
    const ids = questionsInCategory(c.id);
    const s = statsFor(ids);
    const meta = ids.length
      ? `Выучено ${s.learned} из ${s.total} · правильных: ${percentText(s.percent)}`
      : 'Вопросов пока нет';
    return `
      <a class="card list-item" href="#/train/${encodeURIComponent(c.id)}">
        <span class="list-title">${esc(c.title)}</span>
        <progress class="progress" max="${s.total || 1}" value="${s.learned}"></progress>
        <span class="list-meta">${meta}</span>
      </a>`;
  }).join('');
  return { title: 'По документам', back: '#/', html: `<div class="stack">${items}</div>` };
}

function renderScenarios(id) {
  if (id) return renderScenario(id);
  if (!bank.scenarios.length) return { title: 'Ситуации', back: '#/', html: emptyState('Ситуаций пока нет.') };
  const items = bank.scenarios.map((s) => {
    const attempts = scenarioData(s.id).attempts;
    const last = attempts[attempts.length - 1];
    const status = last
      ? `<span class="badge grade-${last.grade}">${GRADES[last.grade]}</span> <span class="list-meta">${esc(formatDateTime(last.date))}</span>`
      : '<span class="list-meta">Ещё не решалась</span>';
    return `
      <a class="card list-item" href="#/scenarios/${encodeURIComponent(s.id)}">
        <span class="list-title">${esc(s.title || 'Ситуация')}</span>
        <span class="clamp">${esc(s.situation)}</span>
        <span>${status}</span>
      </a>`;
  }).join('');
  return { title: 'Ситуации', back: '#/', html: `<div class="stack">${items}</div>` };
}

function renderScenario(id) {
  const s = bank.scenarios.find((x) => x.id === id);
  if (!s) return { title: 'Ситуация', back: '#/scenarios', html: emptyState('Такой ситуации нет в банке вопросов.') };
  const data = scenarioData(id);
  const revealed = revealedScenarios.has(id);

  const reference = revealed ? `
    <section class="card reference">
      <h3>Эталон</h3>
      ${s.answer.length ? `<ol class="reference-list">${s.answer.map((a) => `<li>${esc(a)}</li>`).join('')}</ol>` : '<p class="muted">Эталонный ответ не задан.</p>'}
    </section>
    <p class="field-label">Как вы справились?</p>
    <div class="grade-row">
      ${Object.entries(GRADES).map(([k, label]) => `<button type="button" class="btn grade-${k}" data-action="scenario-grade" data-id="${esc(id)}" data-grade="${k}">${label}</button>`).join('')}
    </div>` : `<button type="button" class="btn btn-primary btn-block" data-action="scenario-reveal" data-id="${esc(id)}">Показать эталон</button>`;

  const history = data.attempts.length ? `
    <h3 class="section-title">История</h3>
    <div class="stack">
      ${data.attempts.slice().reverse().map((a) => `
        <details class="card attempt">
          <summary><span class="badge grade-${a.grade}">${GRADES[a.grade]}</span><span class="list-meta">${esc(formatDateTime(a.date))}</span></summary>
          <p class="attempt-text">${a.text ? esc(a.text) : '<span class="muted">Ответ не записан</span>'}</p>
        </details>`).join('')}
    </div>` : '';

  return {
    title: s.title || 'Ситуация',
    back: '#/scenarios',
    html: `
      <section class="card"><p class="situation-text">${esc(s.situation)}</p></section>
      <label class="field-label" for="scenario-answer">Ваш ответ</label>
      <textarea id="scenario-answer" class="textarea" data-scenario="${esc(id)}" placeholder="Действия, сроки, документы">${esc(data.draft)}</textarea>
      <p class="field-hint">Черновик сохраняется автоматически</p>
      ${reference}
      ${history}`,
  };
}

function renderSettings() {
  const storageText = {
    indexeddb: 'IndexedDB',
    localstorage: 'localStorage (запасной вариант)',
    memory: 'недоступно — прогресс не сохраняется',
  }[storage.kind];
  const offline = navigator.serviceWorker && navigator.serviceWorker.controller ? 'готов' : 'после первой загрузки';
  const threshold = state.settings.passThreshold;

  const about = bank ? `
    ${bank.note ? `<p class="about-note">${esc(bank.note)}</p>` : '<p class="muted">Примечание к банку вопросов не задано.</p>'}
    <dl class="info-list">
      <div><dt>Версия банка вопросов</dt><dd>${esc(bank.version || '—')}</dd></div>
      <div><dt>Обновлён</dt><dd>${esc(formatBankDate(bank.updated) || '—')}</dd></div>
      <div><dt>Вопросов</dt><dd>${bank.questions.length}</dd></div>
      <div><dt>Ситуаций</dt><dd>${bank.scenarios.length}</dd></div>
      ${bank.skipped ? `<div><dt>Пропущено (ошибки в файле)</dt><dd>${bank.skipped}</dd></div>` : ''}
      <div><dt>Версия приложения</dt><dd>${APP_VERSION}</dd></div>
      <div><dt>Хранилище</dt><dd>${storageText}</dd></div>
      <div><dt>Работа офлайн</dt><dd>${offline}</dd></div>
    </dl>` : '<p class="muted">Банк вопросов не загружен.</p>';

  return {
    title: 'Настройки',
    back: '#/',
    html: `
      <h3 class="section-title">Экзамен</h3>
      <section class="card setting-row">
        <span>Порог «сдано»</span>
        <div class="stepper">
          <button type="button" class="btn" data-action="threshold-change" data-delta="-1" aria-label="Уменьшить"${threshold <= 1 ? ' disabled' : ''}>−</button>
          <span class="stepper-value">${threshold} из ${EXAM_SIZE}</span>
          <button type="button" class="btn" data-action="threshold-change" data-delta="1" aria-label="Увеличить"${threshold >= EXAM_SIZE ? ' disabled' : ''}>+</button>
        </div>
      </section>

      <h3 class="section-title">Резервная копия</h3>
      <section class="card stack">
        <p class="muted">Браузер может очистить данные. Сохраняйте копию прогресса в файл (например, в «Файлы» на iPhone) и при необходимости восстанавливайте из неё.</p>
        <button type="button" class="btn btn-primary btn-block" data-action="backup-export">Сохранить резервную копию</button>
        <button type="button" class="btn btn-block" data-action="backup-import">Восстановить</button>
      </section>

      <h3 class="section-title">Прогресс</h3>
      <section class="card stack">
        <button type="button" class="btn btn-danger btn-block" data-action="progress-reset">Сбросить прогресс</button>
      </section>

      <h3 class="section-title">Доступ</h3>
      <section class="card stack">
        <p class="muted">Пароль к вопросам запомнен на этом устройстве. Если его забыть, при следующем запуске пароль спросят снова. Прогресс не пострадает.</p>
        <button type="button" class="btn btn-block" data-action="forget-password">Забыть пароль на этом устройстве</button>
      </section>

      <h3 class="section-title">О приложении</h3>
      <section class="card">${about}</section>
      <p class="muted spaced">Приложение работает без интернета и никуда не отправляет данные: всё хранится только на этом устройстве.</p>`,
  };
}

const SCREENS = {
  '': renderHome,
  train: renderTrain,
  exam: renderExam,
  mistakes: renderMistakes,
  scenarios: renderScenarios,
  docs: renderDocs,
  settings: renderSettings,
};

function parseRoute() {
  return location.hash.replace(/^#\/?/, '').split('/').filter(Boolean).map((p) => {
    try { return decodeURIComponent(p); } catch (e) { return p; }
  });
}

// Глубина экрана: главная — 0, разделы — 1, вложенные экраны — 2.
// По ней понятно, вперёд или назад идёт переход.
function routeDepth() {
  return parseRoute().length;
}

let currentDepth = routeDepth();

// transition: 'forward' / 'back' — смена экрана, 'next' / 'prev' — смена вопроса, 'fade' — обновление экрана
function render(scrollTop, transition) {
  const animate = transition && !reducedMotion.matches;
  if (animate && document.startViewTransition) {
    document.documentElement.dataset.nav = transition;
    try {
      const t = document.startViewTransition(() => paint(scrollTop));
      t.finished.finally(() => { delete document.documentElement.dataset.nav; });
      return;
    } catch (e) {
      delete document.documentElement.dataset.nav;
    }
  }
  paint(scrollTop);
  if (animate) {
    // Запасной вариант для браузеров без View Transitions: новый экран плавно въезжает
    mainEl.classList.remove('enter-forward', 'enter-back', 'enter-next', 'enter-prev', 'enter-fade');
    void mainEl.offsetWidth;
    mainEl.classList.add('enter-' + transition);
  }
}

function paint(scrollTop) {
  const [screen = '', arg] = parseRoute();
  currentDepth = routeDepth();
  let renderFn = SCREENS[screen] || renderHome;
  if (lockedBank) renderFn = renderUnlock;
  else if (!bank && screen !== 'settings') renderFn = renderHome;
  const view = renderFn(arg);

  titleEl.textContent = view.title;
  backEl.hidden = !view.back;
  if (view.back) backEl.setAttribute('href', view.back);
  settingsLinkEl.hidden = Boolean(view.back) || Boolean(lockedBank);
  fadeTapLayers();
  mainEl.innerHTML = view.html;
  animateChoice = false;
  if (scrollTop) window.scrollTo(0, 0);
  if (view.after) view.after();
}

function navigate(hash) {
  if (location.hash === hash) render(true, 'fade');
  else location.hash = hash;
}

/* ================= Резервная копия ================= */

function backupFileName() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `ods-trainer-backup-${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}.json`;
}

function downloadFile(file) {
  const url = URL.createObjectURL(file);
  const a = document.createElement('a');
  a.href = url;
  a.download = file.name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

function exportBackup() {
  const payload = {
    app: 'ods-trainer',
    schema: STATE_SCHEMA,
    exportedAt: new Date().toISOString(),
    bankVersion: bank ? bank.version : null,
    state: { ...state, exam: null },
  };
  const file = new File([JSON.stringify(payload, null, 2)], backupFileName(), { type: 'application/json' });

  // На iPhone «Поделиться» → «Сохранить в Файлы» надёжнее скачивания
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    navigator.share({ files: [file], title: 'Резервная копия ОДС' })
      .then(() => toast('Резервная копия сохранена'))
      .catch((e) => {
        if (e && e.name === 'AbortError') return;
        downloadFile(file);
      });
    return;
  }
  downloadFile(file);
  toast('Файл резервной копии скачан');
}

async function importBackup(file) {
  let payload;
  try {
    payload = JSON.parse(await file.text());
  } catch (e) {
    toast('Не удалось прочитать файл');
    return;
  }
  if (!isPlainObject(payload) || payload.app !== 'ods-trainer' || !isPlainObject(payload.state)) {
    toast('Это не резервная копия тренажёра');
    return;
  }
  const exported = payload.exportedAt ? ` от ${formatDateTime(payload.exportedAt)}` : '';
  if (!confirm(`Восстановить прогресс из копии${exported}? Текущий прогресс будет заменён.`)) return;

  state = normalizeState(payload.state);
  state.exam = null;
  session = null;
  await save();
  toast('Прогресс восстановлен');
  render();
}

/* ================= Действия ================= */

const ACTIONS = {
  'train-answer'(d) {
    const cur = session && session.current;
    if (!cur || cur.chosen !== null) return;
    const q = questionsById.get(cur.id);
    cur.chosen = Number(d.orig);
    const ok = cur.chosen === q.correct;
    if (ok) session.right += 1;
    animateChoice = true;
    recordAnswer(cur.id, ok);
    if (countPractice(1)) celebrateGoal();
    save();
    render();
  },
  'train-next'() {
    session.pos += 1;
    session.current = null;
    render(true, 'next');
  },
  'train-restart'() {
    session = null;
    render(true, 'fade');
  },
  'go-mistakes-training'() {
    session = null;
    navigate('#/train/mistakes');
  },
  'exam-start'() {
    startExam();
    render(true, 'next');
  },
  'exam-choose'(d) {
    if (!state.exam) return;
    if (examRemaining() <= 0) {
      tick();
      return;
    }
    state.exam.answers[state.exam.ids[state.exam.pos]] = Number(d.orig);
    animateChoice = true;
    save();
    render();
  },
  'exam-next'() {
    if (!state.exam) return;
    state.exam.pos = Math.min(state.exam.pos + 1, state.exam.ids.length - 1);
    save();
    render(true, 'next');
  },
  'exam-prev'() {
    if (!state.exam) return;
    state.exam.pos = Math.max(state.exam.pos - 1, 0);
    save();
    render(true, 'prev');
  },
  'exam-finish'() {
    if (!state.exam) return;
    const left = state.exam.ids.length - answeredCount();
    if (left > 0 && !confirm(`Без ответа: ${left}. Они будут засчитаны как ошибки. Завершить экзамен?`)) return;
    finishExam(false);
    navigate('#/exam/result');
  },
  'scenario-reveal'(d) {
    revealedScenarios.add(d.id);
    render();
  },
  'scenario-grade'(d) {
    const data = ensureScenarioData(d.id);
    const textarea = document.getElementById('scenario-answer');
    const text = textarea ? textarea.value : data.draft;
    data.attempts.push({ date: new Date().toISOString(), grade: d.grade, text });
    data.draft = '';
    revealedScenarios.delete(d.id);
    // Разобранная ситуация засчитывается как полная дневная норма
    const goalReached = countPractice(DAILY_GOAL);
    save();
    if (goalReached) celebrateGoal();
    else toast('Ответ и оценка сохранены');
    render();
  },
  'threshold-change'(d) {
    state.settings.passThreshold = clampThreshold(state.settings.passThreshold + Number(d.delta));
    save();
    render();
  },
  'backup-export'() {
    exportBackup();
  },
  'backup-import'() {
    importInput.click();
  },
  async 'forget-password'() {
    if (!confirm('Забыть пароль на этом устройстве? Для входа нужно будет ввести его снова.')) return;
    await storage.remove(KEY_STORAGE);
    location.hash = '#/';
    location.reload();
  },
  'progress-reset'() {
    if (!confirm('Сбросить весь прогресс: статистику, ошибки, ответы на ситуации и результаты экзамена? Отменить будет нельзя.')) return;
    state = { ...defaultState(), settings: state.settings };
    session = null;
    save();
    toast('Прогресс сброшен');
    render();
  },
};

// Переходы на другой экран выполняются после короткой анимации нажатия —
// иначе экран сменяется мгновенно и не видно, куда нажал.
const PRESS_DELAY_MS = 140;
const DELAYED_ACTIONS = new Set(['train-next', 'train-restart', 'go-mistakes-training', 'exam-start', 'exam-next', 'exam-prev', 'scenario-reveal']);
let pressPending = false;

function afterPress(el, fn) {
  if (reducedMotion.matches) {
    fn();
    return;
  }
  if (pressPending) return;
  pressPending = true;
  el.classList.remove('is-pressed');
  void el.offsetWidth; // перезапуск анимации при повторном нажатии
  el.classList.add('is-pressed');
  setTimeout(() => {
    pressPending = false;
    fn();
  }, PRESS_DELAY_MS);
}

document.addEventListener('click', (e) => {
  const el = e.target.closest('[data-action]');
  const link = e.target.closest('a[href^="#"]');
  if (!el && link) {
    e.preventDefault();
    afterPress(link, () => navigate(link.getAttribute('href')));
    return;
  }
  if (!el || el.disabled) return;
  const action = ACTIONS[el.dataset.action];
  if (!action) return;
  e.preventDefault();
  if (DELAYED_ACTIONS.has(el.dataset.action)) {
    const data = { ...el.dataset };
    afterPress(el, () => action(data));
  } else {
    action(el.dataset);
  }
});

document.addEventListener('input', (e) => {
  const t = e.target;
  if (t.matches && t.matches('textarea[data-scenario]')) {
    ensureScenarioData(t.dataset.scenario).draft = t.value;
    saveSoon();
  }
});

document.addEventListener('submit', async (e) => {
  if (e.target.id !== 'unlock-form') return;
  e.preventDefault();
  const input = document.getElementById('unlock-password');
  const error = document.getElementById('unlock-error');
  const button = e.target.querySelector('button[type="submit"]');
  if (!input.value) return;

  if (!window.crypto || !crypto.subtle) {
    error.textContent = 'Браузер не поддерживает расшифровку. Откройте приложение по ссылке https:// в Safari.';
    error.hidden = false;
    return;
  }

  button.disabled = true;
  button.textContent = 'Проверяю…';
  error.hidden = true;
  const result = await unlockWithPassword(lockedBank, input.value).catch(() => null);
  if (!result) {
    button.disabled = false;
    button.textContent = 'Открыть';
    error.textContent = 'Неверный пароль';
    error.hidden = false;
    input.select();
    return;
  }
  lockedBank = null;
  setBank(result);
  render(true, 'fade');
});

/* ================= Отклик на нажатия ================= */

// Волна из точки касания в форме нажатого элемента. Слой вынесен в body и привязан
// к странице, а не к экрану: анимация доигрывает после перерисовки и прокручивается с содержимым.
const TAPPABLE = '.btn, .option, .menu-item, a.list-item, .header-back, .header-settings, .attempt summary';
const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
let tapLayer = null;

document.addEventListener('pointerdown', (e) => {
  if (reducedMotion.matches || e.button > 0) return;
  const el = e.target.closest(TAPPABLE);
  if (!el || el.disabled) return;

  const rect = el.getBoundingClientRect();
  const style = getComputedStyle(el);
  const x = e.clientX - rect.left;
  const y = e.clientY - rect.top;
  const size = 2 * Math.hypot(Math.max(x, rect.width - x), Math.max(y, rect.height - y));

  const layer = document.createElement('span');
  layer.className = 'tap-layer';
  Object.assign(layer.style, {
    left: rect.left + window.scrollX + 'px',
    top: rect.top + window.scrollY + 'px',
    width: rect.width + 'px',
    height: rect.height + 'px',
    borderRadius: style.borderRadius,
    color: el.classList.contains('btn-primary') ? '#fff'
      : el.matches('.menu-item, a.list-item') ? getComputedStyle(document.documentElement).getPropertyValue('--accent')
        : style.color,
  });
  const ripple = document.createElement('span');
  ripple.className = 'tap-ripple';
  Object.assign(ripple.style, {
    width: size + 'px',
    height: size + 'px',
    left: x - size / 2 + 'px',
    top: y - size / 2 + 'px',
  });
  layer.appendChild(ripple);
  document.body.appendChild(layer);
  tapLayer = layer;
  ripple.addEventListener('animationend', () => layer.remove());
  setTimeout(() => layer.remove(), 1000);
});

// Экран перерисовался — под волной уже другие элементы, плавно её гасим
function fadeTapLayers() {
  for (const layer of document.querySelectorAll('.tap-layer')) {
    layer.classList.add('is-leaving');
    setTimeout(() => layer.remove(), 160);
  }
}

// Палец пошёл прокручивать страницу — это не нажатие, волну убираем
document.addEventListener('pointercancel', () => {
  if (tapLayer) tapLayer.remove();
  tapLayer = null;
});

// Без этого Safari на iPhone не применяет стили :active
document.addEventListener('touchstart', () => {}, { passive: true });

importInput.addEventListener('change', () => {
  const file = importInput.files && importInput.files[0];
  importInput.value = '';
  if (file) importBackup(file);
});

window.addEventListener('hashchange', () => {
  revealedScenarios.clear();
  const depth = routeDepth();
  render(true, depth > currentDepth ? 'forward' : depth < currentDepth ? 'back' : 'fade');
});

mainEl.addEventListener('animationend', (e) => {
  if (e.target === mainEl) mainEl.classList.remove('enter-forward', 'enter-back', 'enter-next', 'enter-prev', 'enter-fade');
});

window.addEventListener('pagehide', () => { if (saveTimer) save(); });

document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    if (saveTimer) save();
  } else {
    tick();
    // Мог смениться день — обновляем серию на главной
    if (bank && !lockedBank && parseRoute().length === 0) render();
  }
});

/* ================= Запуск ================= */

const SPLASH_MIN_MS = 850; // роза ветров успевает прорисоваться и заполниться

function hideSplash() {
  const el = document.getElementById('splash');
  if (!el) return;
  const wait = reducedMotion.matches ? 0 : Math.max(0, SPLASH_MIN_MS - performance.now());
  setTimeout(() => {
    el.classList.add('is-hidden');
    setTimeout(() => el.remove(), 500);
  }, wait);
}

async function init() {
  await storage.init();
  state = normalizeState(await storage.get('state'));

  try {
    const env = await fetchEncryptedBank();
    const unlocked = await unlockWithSavedKey(env);
    if (unlocked) setBank(unlocked);
    else lockedBank = env;
  } catch (e) {
    console.error('Банк вопросов:', e);
  }

  render(true);
  setInterval(tick, 1000);

  try {
    if (navigator.storage && navigator.storage.persist) {
      navigator.storage.persisted().then((p) => p || navigator.storage.persist()).catch(() => {});
    }
  } catch (e) { /* не критично */ }

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('service-worker.js').catch((e) => console.warn('Service worker:', e));
  }
}

init().catch((e) => console.error(e)).finally(hideSplash);
