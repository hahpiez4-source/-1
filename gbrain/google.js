// ============================================================
// google.js — «руки» роя в Google: Календарь, Задачи, Диск.
//
// Ходим в Google REST API обычным fetch (без тяжёлых библиотек).
// Авторизация — по refresh-токену: он не протухает, меняем его на
// короткоживущий access-токен и кэшируем в памяти до истечения.
//
// Нужны в .env (НЕ в git):
//   GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REFRESH_TOKEN
//   GOOGLE_TZ (необязательно, по умолчанию Europe/Moscow)
//
// Доступ выдан один раз через OAuth (scopes: calendar, tasks, drive).
// ============================================================

const TZ = process.env.GOOGLE_TZ || 'Europe/Moscow';

// Есть ли вообще доступ к Google (заданы ли ключи)?
export function hasGoogle() {
  return Boolean(
    process.env.GOOGLE_CLIENT_ID &&
      process.env.GOOGLE_CLIENT_SECRET &&
      process.env.GOOGLE_REFRESH_TOKEN
  );
}

// --- access-токен с кэшем в памяти ---
let _token = null; // { value, exp } exp = время истечения в мс
async function getAccessToken() {
  if (_token && Date.now() < _token.exp - 60_000) return _token.value; // ещё свежий
  const body = new URLSearchParams({
    client_id: process.env.GOOGLE_CLIENT_ID,
    client_secret: process.env.GOOGLE_CLIENT_SECRET,
    refresh_token: process.env.GOOGLE_REFRESH_TOKEN,
    grant_type: 'refresh_token',
  });
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  const data = await r.json();
  if (!data.access_token) {
    throw new Error(`Google OAuth: не дали токен — ${JSON.stringify(data).slice(0, 200)}`);
  }
  _token = { value: data.access_token, exp: Date.now() + (data.expires_in || 3600) * 1000 };
  return _token.value;
}

// Универсальный запрос к Google API. Бросает понятную ошибку при сбое.
async function gfetch(url, { method = 'GET', body, headers } = {}) {
  const at = await getAccessToken();
  const r = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${at}`,
      ...(body && !headers ? { 'Content-Type': 'application/json' } : {}),
      ...(headers || {}),
    },
    body: body ? (typeof body === 'string' ? body : JSON.stringify(body)) : undefined,
  });
  const text = await r.text();
  let data;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { raw: text };
  }
  if (!r.ok) {
    const msg = data?.error?.message || data?.error_description || text.slice(0, 200);
    throw new Error(`Google API ${r.status}: ${msg}`);
  }
  return data;
}

// ------------------------------------------------------------
// КАЛЕНДАРЬ
// ------------------------------------------------------------

// Создать событие. start/end — ISO-строки локального времени ("2026-06-05T15:00:00").
// Если end не задан — длительность 1 час. allDay=true → событие на весь день
// (тогда start = "ГГГГ-ММ-ДД").
export async function createCalendarEvent({ summary, description, start, end, allDay = false }) {
  if (!summary) throw new Error('createCalendarEvent: нужен summary (название события)');
  if (!start) throw new Error('createCalendarEvent: нужно start (когда)');

  let startObj, endObj;
  if (allDay) {
    const d = String(start).slice(0, 10);
    startObj = { date: d };
    endObj = { date: end ? String(end).slice(0, 10) : d };
  } else {
    // start/end — «голое» локальное время без зоны; саму зону передаём отдельно
    // в timeZone, поэтому арифметику делаем по компонентам, без участия зоны сервера.
    startObj = { dateTime: String(start), timeZone: TZ };
    endObj = { dateTime: end ? String(end) : addHoursNaive(String(start), 1), timeZone: TZ };
  }

  const ev = await gfetch(
    'https://www.googleapis.com/calendar/v3/calendars/primary/events',
    { method: 'POST', body: { summary, description, start: startObj, end: endObj } }
  );
  return { id: ev.id, htmlLink: ev.htmlLink, summary: ev.summary, start: ev.start };
}

// Список ближайших событий. По умолчанию — на 7 дней вперёд, до 10 штук.
export async function listCalendarEvents({ timeMin, timeMax, max = 10 } = {}) {
  const now = new Date();
  const tMin = timeMin || now.toISOString();
  const tMax = timeMax || new Date(now.getTime() + 7 * 24 * 3600 * 1000).toISOString();
  const url =
    'https://www.googleapis.com/calendar/v3/calendars/primary/events?' +
    new URLSearchParams({
      timeMin: tMin,
      timeMax: tMax,
      singleEvents: 'true',
      orderBy: 'startTime',
      maxResults: String(max),
    });
  const data = await gfetch(url);
  return (data.items || []).map((e) => {
    const startRaw = e.start?.dateTime || e.start?.date;
    const endRaw = e.end?.dateTime || e.end?.date;
    return {
      summary: e.summary || '(без названия)',
      // когда — уже в часовом поясе пользователя, человекочитаемо (чтобы модель
      // отвечала местным временем, а не UTC)
      when: fmtLocal(startRaw, e.start?.date ? true : false),
      ends: fmtLocal(endRaw, e.end?.date ? true : false),
      htmlLink: e.htmlLink,
    };
  });
}

// Человекочитаемое время в часовом поясе пользователя.
// allDay=true → только дата. iso может быть с 'Z' или без.
function fmtLocal(iso, allDay = false) {
  if (!iso) return '';
  try {
    const d = new Date(iso.length <= 10 ? iso + 'T00:00:00Z' : iso);
    const opts = allDay
      ? { timeZone: TZ, day: '2-digit', month: '2-digit', year: 'numeric' }
      : { timeZone: TZ, day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false };
    return new Intl.DateTimeFormat('ru-RU', opts).format(d);
  } catch {
    return iso;
  }
}

// ------------------------------------------------------------
// ЗАДАЧИ (напоминания)
// Примечание: Google Tasks хранит только ДАТУ срока (время игнорируется).
// Для напоминания на КОНКРЕТНОЕ время лучше создавать событие в календаре.
// ------------------------------------------------------------

export async function createTask({ title, notes, due }) {
  if (!title) throw new Error('createTask: нужен title (текст задачи)');
  const body = { title };
  if (notes) body.notes = notes;
  if (due) body.due = new Date(String(due).slice(0, 10) + 'T00:00:00.000Z').toISOString();
  const t = await gfetch('https://tasks.googleapis.com/tasks/v1/lists/@default/tasks', {
    method: 'POST',
    body,
  });
  return { id: t.id, title: t.title, due: t.due, status: t.status };
}

export async function listTasks({ max = 20 } = {}) {
  const url =
    'https://tasks.googleapis.com/tasks/v1/lists/@default/tasks?' +
    new URLSearchParams({ showCompleted: 'false', maxResults: String(max) });
  const data = await gfetch(url);
  return (data.items || []).map((t) => ({ title: t.title, due: t.due, notes: t.notes }));
}

// ------------------------------------------------------------
// ДИСК
// ------------------------------------------------------------

export async function createDriveFolder({ name }) {
  if (!name) throw new Error('createDriveFolder: нужно name (имя папки)');
  const f = await gfetch('https://www.googleapis.com/drive/v3/files', {
    method: 'POST',
    body: { name, mimeType: 'application/vnd.google-apps.folder' },
  });
  return { id: f.id, name: f.name, link: `https://drive.google.com/drive/folders/${f.id}` };
}

// Создать Google-документ из текста (Drive сам сконвертирует text/plain в Документ).
export async function createDriveDoc({ name, content = '' }) {
  if (!name) throw new Error('createDriveDoc: нужно name (имя документа)');
  const boundary = 'gbrain' + Math.random().toString(36).slice(2);
  const metadata = { name, mimeType: 'application/vnd.google-apps.document' };
  const multipart =
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n` +
    JSON.stringify(metadata) +
    `\r\n--${boundary}\r\nContent-Type: text/plain; charset=UTF-8\r\n\r\n` +
    content +
    `\r\n--${boundary}--`;
  const f = await gfetch(
    'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name',
    {
      method: 'POST',
      headers: { 'Content-Type': `multipart/related; boundary=${boundary}` },
      body: multipart,
    }
  );
  return { id: f.id, name: f.name, link: `https://docs.google.com/document/d/${f.id}/edit` };
}

// Прибавить часы к «голому» локальному времени "ГГГГ-ММ-ДДTЧЧ:ММ[:СС]" по
// компонентам (через Date.UTC, чтобы зона сервера не вмешивалась), вернуть тот же формат.
function addHoursNaive(s, hours) {
  const m = String(s).match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?/);
  if (!m) return s;
  const [, Y, Mo, D, H, Mi, Se] = m;
  const d = new Date(Date.UTC(+Y, +Mo - 1, +D, +H, +Mi, +(Se || 0)));
  d.setUTCHours(d.getUTCHours() + hours);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}T${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`;
}

export const GOOGLE_TZ = TZ;
