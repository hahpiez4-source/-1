// ============================================================
// brain.js — «мозг»: обращение к LLM через Groq.
//
// Groq отдаёт OpenAI-совместимый API, поэтому ходим обычным fetch,
// без лишних библиотек. Нужен только GROQ_API_KEY в .env.
//
// Экспортируем:
//   hasBrain()            — есть ли ключ (мозг)
//   callLLM(messages,opts)— низкоуровневый вызов LLM (для ядра gbrain)
//   think(task, agent)    — агент думает над задачей в своём характере
// При отсутствии ключа/ошибке — аккуратная заглушка, рой не падает.
// ============================================================

import { getPersona } from './roster.js';
import {
  hasGoogle,
  createCalendarEvent,
  listCalendarEvents,
  createTask,
  listTasks,
  createDriveFolder,
  createDriveDoc,
  GOOGLE_TZ,
} from './google.js';

const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions';
const MODEL = process.env.GROQ_MODEL || 'llama-3.3-70b-versatile';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Веб-поиск для Исследователя — через Tavily (поисковый API для ИИ-агентов).
// Возвращает короткие выжимки + ссылки, поэтому надёжно укладывается в лимиты.
const TAVILY_URL = 'https://api.tavily.com/search';

// Есть ли вообще мозг (ключ Groq)?
export function hasBrain() {
  return Boolean(process.env.GROQ_API_KEY);
}

// Есть ли веб-поиск (ключ Tavily)?
export function hasWebSearch() {
  return Boolean(process.env.TAVILY_API_KEY);
}

// Низкоуровневый вызов LLM. messages = [{role, content}, ...].
// Возвращает строку-ответ или бросает ошибку (вызывающий решает, что делать).
// Убираем СЛУЧАЙНЫЕ одиночные иероглифы (CJK), которые llama изредка роняет
// в русский текст. Чистим ТОЛЬКО одиночный знак Han, не окружённый другими
// иероглифами, — настоящие фрагменты на китайском (2+ знака подряд) не трогаем.
// Заодно не плодим двойной пробел, если знак стоял между пробелами.
function dropStrayCJK(text) {
  if (!text) return text;
  return text
    // знак между пробелами на одной строке → оставляем РОВНО один пробел
    .replace(/(?<![\p{Script=Han}]) [\p{Script=Han}] (?![\p{Script=Han}])/gu, ' ')
    // знак, прилипший к тексту → просто удаляем (отступы/таблицы не трогаем)
    .replace(/(?<![\p{Script=Han}])[\p{Script=Han}](?![\p{Script=Han}])/gu, '');
}

export async function callLLM(messages, { temperature = 0.7, maxTokens = 600, model = MODEL, raw = false, reasoningEffort, tools, toolChoice } = {}) {
  const body = { model, messages, temperature };
  // max_tokens шлём, только если задан (даём возможность не ограничивать ответ).
  if (maxTokens) body.max_tokens = maxTokens;
  // function-calling: список инструментов (для агента с «руками», напр. Секретарь).
  if (tools) body.tools = tools;
  if (toolChoice) body.tool_choice = toolChoice;
  // ВАЖНО: gpt-oss «думает» перед ответом, и эти токены-размышления ТОЖЕ
  // считаются в max_tokens. Если лимит маленький — размышления съедают его и
  // ответ приходит ПУСТОЙ. Поэтому для gpt-oss по умолчанию просим низкое
  // усилие на размышления (можно переопределить через reasoningEffort).
  const effort = reasoningEffort ?? (model.includes('gpt-oss') ? 'low' : undefined);
  if (effort) body.reasoning_effort = effort;

  const MAX_ATTEMPTS = 5;
  for (let attempt = 1; ; attempt++) {
    const resp = await fetch(GROQ_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${process.env.GROQ_API_KEY}`,
      },
      body: JSON.stringify(body),
    });

    if (resp.ok) {
      const data = await resp.json();
      // raw=true — вернуть весь ответ (нужно, чтобы прочитать executed_tools у compound).
      if (raw) return data;
      return dropStrayCJK((data?.choices?.[0]?.message?.content || '').trim());
    }

    const errText = await resp.text();
    // Временные сбои, при которых стоит подождать и повторить:
    //   429 — упёрлись в лимит токенов/минуту (бесплатный Groq);
    //   5xx — сбой на стороне Groq;
    //   400 «Tool choice is none» — редкий баг compound.
    const transient =
      resp.status === 429 ||
      resp.status >= 500 ||
      (resp.status === 400 && /tool choice is none/i.test(errText));
    if (transient && attempt < MAX_ATTEMPTS) {
      // сколько ждать: заголовок retry-after → подсказка Groq в тексте → экспонента
      const ra = Number(resp.headers.get('retry-after'));
      const hint = errText.match(/try again in ([\d.]+)s/i);
      const waitMs = ra
        ? ra * 1000
        : hint
          ? Math.ceil(parseFloat(hint[1]) * 1000) + 250
          : Math.min(1500 * 2 ** (attempt - 1), 12000);
      console.log(`🔁 Groq ${resp.status} — повтор ${attempt}/${MAX_ATTEMPTS} через ${Math.round(waitMs / 1000)}с`);
      await sleep(waitMs);
      continue;
    }
    throw new Error(`Groq ${resp.status}: ${errText.slice(0, 200)}`);
  }
}

// Блок «что рой уже знает по теме» (из общей памяти) для вставки в промпт.
// memContext — готовый текст из памяти (или пусто). Возвращает абзац или ''.
function memoryBlock(memContext) {
  if (!memContext || !memContext.trim()) return '';
  return (
    `\nЧто рой УЖЕ знает по этой теме (из общей памяти прошлых задач). ` +
    `Используй как справку: опирайся на проверенное, не противоречь без причины, ` +
    `НЕ копируй вслепую — дополняй и улучшай:\n${memContext}\n`
  );
}

// Блок «о чём этот чат говорил раньше» (память диалога) для вставки в промпт.
// dialog — готовый текст недавней переписки (или пусто). Возвращает абзац или ''.
function dialogBlock(dialog) {
  if (!dialog || !dialog.trim()) return '';
  return (
    `\nПредыдущий разговор с этим пользователем (для контекста — НЕ отвечай ` +
    `на старые реплики заново, просто помни, о чём шла речь, и держи нить беседы):\n${dialog}\n`
  );
}

// Агент думает над задачей в СВОЁМ характере. Возвращает строку-результат.
// memContext (необязательно) — релевантные записи из общей памяти роя.
// dialog (необязательно) — недавняя переписка этого чата (память диалога).
export async function think(task, agent, memContext = '', dialog = '') {
  // нет ключа — честно работаем «без мозга»
  if (!process.env.GROQ_API_KEY) {
    return `(без LLM) Задача «${task.title}» обработана. Подключи GROQ_API_KEY, чтобы агент думал по-настоящему.`;
  }

  // характер агента: своя роль и стиль
  const persona = getPersona(agent.name);
  const systemPrompt =
    persona.system +
    `\n\nТы работаешь в рое агентов и берёшь задачи с общей доски. ` +
    `Отвечай на русском — живо, дерзко и с колким юмором, как остроумный нагловатый друг, а не вежливый робот. ` +
    `Сарказм, ирония, лёгкие подколы и «токсик-нотки» приветствуются — но ГЛАВНОЕ: сначала ты реально и точно отвечаешь на вопрос/делаешь задачу, а перчинка идёт приправой сверху, НЕ вместо ответа. ` +
    `Подкалывай тему, ситуацию или самого себя — но не самого пользователя зло: без настоящих оскорблений и перехода на личности, без грубости про внешность, нацию, религию и подобное. Дерзко, но по-дружески. ` +
    `Без занудства, морализаторства и «воды», не растекайся. Эмодзи — в меру. ` +
    `Если задача расплывчатая — не докапывайся уточнениями, а сделай разумное предположение и сразу выдай конкретику (можно с подколом).`;

  const userPrompt =
    dialogBlock(dialog) +
    `\nЗадача (новое сообщение пользователя — отвечай именно на него): ${task.title}\n` +
    (task.description ? `Описание: ${task.description}\n` : '') +
    memoryBlock(memContext) +
    `\nДай результат (5–8 предложений максимум).`;

  try {
    return (
      (await callLLM(
        [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        { temperature: 0.7, maxTokens: 1000 }
      )) || `(пустой ответ LLM) по задаче «${task.title}».`
    );
  } catch (e) {
    console.error('⚠️  Не смог обратиться к мозгу (Groq):', e.message);
    return `(сбой связи с LLM) Задача «${task.title}» помечена выполненной без результата.`;
  }
}

// ------------------------------------------------------------
// plan(task) — РАЗБИТЬ большую цель на 3–5 конкретных подзадач.
// Используется Стратегом. Возвращает массив { title, description }.
// Если мозга нет или разбор не удался — пустой массив (вызывающий решит,
// что делать: например, оставит цель как обычную задачу).
// ------------------------------------------------------------
export async function plan(task) {
  if (!process.env.GROQ_API_KEY) return [];

  const persona = getPersona('Стратег');
  const system =
    persona.system +
    `\n\nРазбей цель на 3–5 КОНКРЕТНЫХ подзадач для других агентов роя. ` +
    `Каждая подзадача — самодостаточный шаг с понятным результатом. ` +
    `Ответь СТРОГО валидным JSON-массивом без какого-либо текста вокруг, в формате: ` +
    `[{"title":"кратко","description":"что именно сделать"}]. ` +
    `Только русский язык.`;

  const user =
    `Цель: ${task.title}\n` +
    (task.description ? `Подробности: ${task.description}\n` : '') +
    `\nВерни JSON-массив подзадач.`;

  let raw = '';
  try {
    raw = await callLLM(
      [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      { temperature: 0.4, maxTokens: 1100 }
    );
  } catch (e) {
    console.error('⚠️  Стратег не смог обратиться к мозгу (Groq):', e.message);
    return [];
  }

  // вырезаем JSON-массив из ответа (LLM иногда добавляет ```json или пояснения)
  const start = raw.indexOf('[');
  const end = raw.lastIndexOf(']');
  if (start === -1 || end === -1 || end <= start) return [];

  let parsed;
  try {
    parsed = JSON.parse(raw.slice(start, end + 1));
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];

  // нормализуем и отбрасываем мусор; не больше 5 подзадач
  return parsed
    .map((p) => ({
      title: String(p?.title ?? '').trim(),
      description: String(p?.description ?? '').trim(),
    }))
    .filter((p) => p.title)
    .slice(0, 5);
}

// Низкоуровневый веб-поиск через Tavily. Возвращает { answer, results[] }.
// results[i] = { title, url, content }. Бросает ошибку при сбое.
async function tavilySearch(query) {
  const resp = await fetch(TAVILY_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${process.env.TAVILY_API_KEY}`,
    },
    body: JSON.stringify({
      query,
      search_depth: 'basic', // basic = 1 кредит (экономим бесплатные 1000/мес)
      max_results: 5,
      include_answer: 'advanced', // Tavily вернёт и краткий синтез-ответ
      topic: 'general',
    }),
  });

  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error(`Tavily ${resp.status}: ${errText.slice(0, 200)}`);
  }
  return resp.json();
}

// ------------------------------------------------------------
// research(task) — настоящий ВЕБ-ПОИСК (для Исследователя).
// 1) ищет в интернете через Tavily (короткие выжимки + ссылки);
// 2) суммирует найденное нашей LLM в характере Исследователя, со ссылками.
// Аккуратные откаты: нет ключа Tavily → обычное think(); нет Groq → отдаём
// сырые результаты Tavily; сбой суммаризации → тоже сырые результаты.
// ------------------------------------------------------------
export async function research(task, memContext = '', dialog = '') {
  // нет ключа Tavily — честно работаем без веба
  if (!hasWebSearch()) {
    console.log('ℹ️  Нет TAVILY_API_KEY — Исследователь отвечает без веб-поиска.');
    return think(task, { name: 'Исследователь' }, memContext, dialog);
  }

  // Tavily ограничивает запрос 400 символами. Заголовок (он короткий) берём
  // целиком, описание добавляем, сколько влезет в лимит — иначе Tavily вернёт
  // 400 «Query is too long» (бывало на доработках, где в описании копятся
  // замечания Критика) и веб-поиск зря откатывался в режим без интернета.
  const MAX_TAVILY_QUERY = 400;
  const query = (task.description ? `${task.title}. ${task.description}` : task.title).slice(0, MAX_TAVILY_QUERY);

  let sr;
  try {
    sr = await tavilySearch(query);
  } catch (e) {
    console.error('⚠️  Веб-поиск (Tavily) не удался, отвечаю в обычном режиме:', e.message);
    return think(task, { name: 'Исследователь' }, memContext, dialog);
  }

  const results = Array.isArray(sr?.results) ? sr.results : [];
  console.log(`🔎 Tavily нашёл источников: ${results.length}.`);

  const sourcesList = results.map((r, i) => `${i + 1}. ${r.title} — ${r.url}`).join('\n');

  // нет нашей LLM для красивой сводки — отдаём ответ Tavily + ссылки как есть
  if (!hasBrain()) {
    return `${sr.answer || 'Найдены источники по запросу.'}\n\nИсточники:\n${sourcesList}`.trim();
  }

  // материалы для модели: короткие выжимки из найденных страниц
  const snippets = results
    .map((r, i) => `[${i + 1}] ${r.title}\n${r.url}\n${(r.content || '').slice(0, 500)}`)
    .join('\n\n');

  const persona = getPersona('Исследователь');
  const system =
    persona.system +
    '\n\nТебе дали свежие материалы из интернета (выжимки и ссылки). ' +
    'На их основе дай сжатую полезную сводку на русском: ключевые факты, варианты, на что обратить внимание. ' +
    'Опирайся ТОЛЬКО на эти материалы, ничего не выдумывай. ' +
    'В конце ОБЯЗАТЕЛЬНО добавь раздел «Источники:» со списком ссылок.';

  const userMsg =
    dialogBlock(dialog) +
    `\nЗадача: ${task.title}\n` +
    (task.description ? `Описание: ${task.description}\n` : '') +
    memoryBlock(memContext) +
    `\nМатериалы из интернета:\n${snippets}\n\n` +
    (sr.answer ? `Краткий ответ поисковика: ${sr.answer}\n\n` : '') +
    `Сделай сводку.`;

  try {
    const text = await callLLM(
      [
        { role: 'system', content: system },
        { role: 'user', content: userMsg },
      ],
      { temperature: 0.3, maxTokens: 800 }
    );
    // подстрахуемся: если модель забыла ссылки — добавим их сами
    return text && text.includes('http') ? text : `${text || ''}\n\nИсточники:\n${sourcesList}`.trim();
  } catch (e) {
    console.error('⚠️  Не смог суммировать (Groq), отдаю сырые результаты:', e.message);
    return `${sr.answer || ''}\n\nИсточники:\n${sourcesList}`.trim();
  }
}

// ------------------------------------------------------------
// act(task) — РУКИ роя через groq/compound. Эта модель Groq умеет САМА
// искать в интернете и запускать Python-код в песочнице Groq (безопасно,
// не на нашем сервере). Для агента «Мастер».
// Откаты: нет ключа Groq или сбой/пустой ответ → обычное think().
// ------------------------------------------------------------
export async function act(task, memContext = '', dialog = '') {
  if (!process.env.GROQ_API_KEY) {
    return think(task, { name: 'Мастер' }, memContext, dialog);
  }

  const persona = getPersona('Мастер');
  const system =
    persona.system +
    '\n\nУ тебя есть РЕАЛЬНЫЕ инструменты: веб-поиск и запуск Python-кода. ' +
    'Пользуйся ими, когда задача требует свежих данных из интернета, точных вычислений или обработки данных — ' +
    'не выдумывай, а проверь/посчитай. ' +
    'Отвечай на русском, по делу и с нашим дерзким тоном. В конце коротко: что сделал и какой результат.';

  const user =
    dialogBlock(dialog) +
    `\nЗадача: ${task.title}\n` +
    (task.description ? `Описание: ${task.description}\n` : '') +
    memoryBlock(memContext) +
    `\nСделай задачу. Если нужно — ищи в интернете и считай кодом.`;

  try {
    const data = await callLLM(
      [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      { model: 'groq/compound', temperature: 0.5, maxTokens: 900, raw: true }
    );
    const msg = data?.choices?.[0]?.message || {};
    const tools = (msg.executed_tools || []).map((t) => t.type);
    if (tools.length) console.log(`🛠️  Мастер применил инструменты: ${tools.join(', ')}`);
    const text = (msg.content || '').trim();
    return text || think(task, { name: 'Мастер' }, memContext, dialog);
  } catch (e) {
    console.error('⚠️  Мастер (compound) не смог, отвечаю обычным режимом:', e.message);
    return think(task, { name: 'Мастер' }, memContext, dialog);
  }
}

// ------------------------------------------------------------
// secretary(task) — РУКИ роя в Google (для агента «Секретарь»).
// Через function-calling Groq модель сама решает, какое действие в Google
// выполнить (создать событие/задачу/папку/документ или показать список),
// мы РЕАЛЬНО его выполняем через google.js и отдаём модели результат, после
// чего она пишет человеку короткий ответ. Без ключей Google — откат в think().
// ------------------------------------------------------------

export function hasGoogleHands() {
  return hasGoogle();
}

// Описание инструментов для модели (OpenAI-совместимый формат function-calling).
const GOOGLE_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'create_calendar_event',
      description:
        'Создать событие в Google Календаре пользователя. Время указывай как локальное ' +
        'в формате ГГГГ-ММ-ДДTЧЧ:ММ:СС (например 2026-06-05T15:00:00). Для события на весь день ' +
        'ставь all_day=true и start как ГГГГ-ММ-ДД.',
      parameters: {
        type: 'object',
        properties: {
          summary: { type: 'string', description: 'Название события' },
          start: { type: 'string', description: 'Начало: ГГГГ-ММ-ДДTЧЧ:ММ:СС или ГГГГ-ММ-ДД (для all_day)' },
          end: { type: 'string', description: 'Конец (необязательно; по умолчанию +1 час)' },
          description: { type: 'string', description: 'Заметка к событию (необязательно)' },
          all_day: { type: 'boolean', description: 'Событие на весь день' },
        },
        required: ['summary', 'start'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_calendar_events',
      description: 'Показать ближайшие события из Google Календаря (по умолчанию на 7 дней вперёд).',
      parameters: {
        type: 'object',
        properties: { max: { type: 'integer', description: 'Сколько событий максимум (по умолч. 10)' } },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'create_task',
      description:
        'Создать задачу/напоминание в Google Задачах. Внимание: у задачи хранится только ДАТА срока ' +
        '(время игнорируется). Если нужно напоминание на конкретное ВРЕМЯ — используй create_calendar_event.',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'Текст задачи' },
          notes: { type: 'string', description: 'Подробности (необязательно)' },
          due: { type: 'string', description: 'Срок — дата ГГГГ-ММ-ДД (необязательно)' },
        },
        required: ['title'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_tasks',
      description: 'Показать текущие (невыполненные) задачи из Google Задач.',
      parameters: { type: 'object', properties: { max: { type: 'integer' } } },
    },
  },
  {
    type: 'function',
    function: {
      name: 'create_drive_folder',
      description: 'Создать папку на Google Диске.',
      parameters: {
        type: 'object',
        properties: { name: { type: 'string', description: 'Имя папки' } },
        required: ['name'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'create_drive_doc',
      description: 'Создать Google-документ на Диске с текстом.',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Имя документа' },
          content: { type: 'string', description: 'Текст документа (необязательно)' },
        },
        required: ['name'],
      },
    },
  },
];

// Реальное выполнение инструмента. Возвращает объект-результат (его увидит модель).
async function runGoogleTool(name, args) {
  switch (name) {
    case 'create_calendar_event':
      return await createCalendarEvent({
        summary: args.summary,
        start: args.start,
        end: args.end,
        description: args.description,
        allDay: Boolean(args.all_day),
      });
    case 'list_calendar_events':
      return { events: await listCalendarEvents({ max: args.max || 10 }) };
    case 'create_task':
      return await createTask({ title: args.title, notes: args.notes, due: args.due });
    case 'list_tasks':
      return { tasks: await listTasks({ max: args.max || 20 }) };
    case 'create_drive_folder':
      return await createDriveFolder({ name: args.name });
    case 'create_drive_doc':
      return await createDriveDoc({ name: args.name, content: args.content || '' });
    default:
      throw new Error(`неизвестный инструмент: ${name}`);
  }
}

// Текущая дата/время в часовом поясе пользователя — чтобы модель верно понимала
// «завтра», «в пятницу», «через час» и т.п.
function nowInTz() {
  try {
    const f = new Intl.DateTimeFormat('ru-RU', {
      timeZone: GOOGLE_TZ,
      weekday: 'long', year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hour12: false,
    });
    return f.format(new Date());
  } catch {
    return new Date().toISOString();
  }
}

export async function secretary(task, memContext = '', dialog = '') {
  // нет ключей Google — честно работаем как обычный агент
  if (!hasGoogle()) {
    console.log('ℹ️  Нет ключей Google — Секретарь отвечает без доступа к Календарю/Задачам/Диску.');
    return think(task, { name: 'Секретарь' }, memContext, dialog);
  }
  if (!process.env.GROQ_API_KEY) {
    return think(task, { name: 'Секретарь' }, memContext, dialog);
  }

  const persona = getPersona('Секретарь');
  const system =
    persona.system +
    `\n\nУ тебя есть РЕАЛЬНЫЙ доступ к Google пользователя через инструменты: ` +
    `Календарь (создать/показать события), Задачи (создать/показать напоминания), Диск (создать папку/документ). ` +
    `Когда просьба про события, встречи, напоминания, задачи, папки или документы — НЕ описывай словами, ` +
    `а ВЫЗОВИ нужный инструмент и реально сделай. ` +
    `Часовой пояс пользователя: ${GOOGLE_TZ}. Сейчас: ${nowInTz()}. ` +
    `Считай относительные даты («завтра», «в пятницу», «через час») от этого момента и передавай инструменту точное время. ` +
    `Для напоминания на конкретное ВРЕМЯ создавай событие в календаре (у Задач хранится только дата). ` +
    `После действия дай человеку короткий ответ на русском в нашем дерзком тоне: что именно сделал ` +
    `(с названием и временем), без воды. Если включал ссылку — добавь её.`;

  const userMsg =
    dialogBlock(dialog) +
    `\nПросьба пользователя: ${task.title}\n` +
    (task.description ? `Описание: ${task.description}\n` : '') +
    memoryBlock(memContext);

  const messages = [
    { role: 'system', content: system },
    { role: 'user', content: userMsg },
  ];

  const actionsLog = [];
  const MAX_STEPS = 5; // максимум вызовов инструментов за одну задачу
  try {
    for (let step = 0; step < MAX_STEPS; step++) {
      const data = await callLLM(messages, {
        model: 'llama-3.3-70b-versatile', // надёжно поддерживает function-calling
        temperature: 0.3,
        maxTokens: 900,
        raw: true,
        tools: GOOGLE_TOOLS,
      });
      const msg = data?.choices?.[0]?.message || {};
      const calls = msg.tool_calls || [];

      // модель не зовёт инструменты — значит выдала финальный текст
      if (!calls.length) {
        const text = (msg.content || '').trim();
        if (actionsLog.length) console.log(`📅 Секретарь сделал: ${actionsLog.join('; ')}`);
        return text || (actionsLog.length ? `Готово: ${actionsLog.join('; ')}.` : `Не понял, что сделать с «${task.title}».`);
      }

      // кладём ответ модели (с tool_calls) в историю, затем выполняем каждый вызов
      messages.push(msg);
      for (const call of calls) {
        let args = {};
        try {
          args = JSON.parse(call.function.arguments || '{}');
        } catch {}
        let resultObj;
        try {
          resultObj = await runGoogleTool(call.function.name, args);
          actionsLog.push(`${call.function.name}(${args.summary || args.title || args.name || ''})`.trim());
          console.log(`🔧 ${call.function.name}:`, JSON.stringify(resultObj).slice(0, 160));
        } catch (e) {
          resultObj = { error: e.message };
          console.error(`⚠️  Инструмент ${call.function.name} упал:`, e.message);
        }
        messages.push({
          role: 'tool',
          tool_call_id: call.id,
          content: JSON.stringify(resultObj),
        });
      }
    }
    // исчерпали лимит шагов — попросим модель подвести итог без инструментов
    const finalText = await callLLM(messages, {
      model: 'llama-3.3-70b-versatile',
      temperature: 0.3,
      maxTokens: 500,
    });
    return finalText || (actionsLog.length ? `Готово: ${actionsLog.join('; ')}.` : 'Готово.');
  } catch (e) {
    console.error('⚠️  Секретарь не смог (Google/Groq):', e.message);
    return think(task, { name: 'Секретарь' }, memContext, dialog);
  }
}

// Распознать вердикт из текста рецензии: 'rework' (доработать) или 'accept' (принять).
// Ориентируемся на финальную строку «ВЕРДИКТ: ...»; при неоднозначности — 'accept'
// (безопаснее: не гоняем задачу по кругу зря).
function parseVerdict(text) {
  const matches = [...String(text).matchAll(/вердикт\s*[:\-]?\s*«?\s*(принять|доработать)/gi)];
  if (matches.length) {
    return matches[matches.length - 1][1].toLowerCase() === 'доработать' ? 'rework' : 'accept';
  }
  return /доработать/i.test(text) ? 'rework' : 'accept';
}

// Распознать ОЦЕНКУ результата (1..10) из строки «ОЦЕНКА: N/10» / «ОЦЕНКА: N».
// Берём последнее совпадение, зажимаем в диапазон 1..10. Нет числа → null
// (метрика просто не учтёт эту задачу, логика роя от этого не зависит).
function parseScore(text) {
  const matches = [...String(text).matchAll(/оценк[аи]\s*[:\-]?\s*«?\s*(\d{1,2})\s*(?:\/\s*10)?/gi)];
  if (!matches.length) return null;
  const n = parseInt(matches[matches.length - 1][1], 10);
  if (Number.isNaN(n)) return null;
  return Math.min(10, Math.max(1, n));
}

// ------------------------------------------------------------
// review(task) — РЕЦЕНЗИЯ на результат задачи (для Критика).
// task.description здесь содержит результат работы другого агента.
// Возвращает { text, verdict, score }, где verdict = 'accept' | 'rework',
// score = оценка 1..10 (или null, если Критик её не указал).
// Без ключа/при сбое — аккуратная заглушка (verdict='accept', чтобы не зациклить).
// ------------------------------------------------------------
export async function review(task) {
  if (!process.env.GROQ_API_KEY) {
    return {
      text: `(без LLM) Результат задачи «${task.title}» просмотрен. Подключи GROQ_API_KEY для настоящей рецензии.`,
      verdict: 'accept',
      score: null,
    };
  }

  const persona = getPersona('Критик');
  const system =
    persona.system +
    '\n\nТебе дают РЕЗУЛЬТАТ работы другого агента роя. Дай короткую конкретную рецензию на русском. ' +
    'Не выполняй задачу заново — именно оцени присланный результат.';

  const userPrompt =
    `Задача: ${task.title}\n` +
    `Результат работы:\n${task.description || '(результат пустой)'}\n\n` +
    `Дай рецензию по пунктам: 1) что хорошо; 2) что слабо/неточно; 3) что конкретно улучшить. ` +
    `В САМОМ КОНЦЕ двумя отдельными строками напиши ровно так:\n` +
    `«ОЦЕНКА: N/10» (целое число от 1 до 10 — насколько результат хорош);\n` +
    `«ВЕРДИКТ: ПРИНЯТЬ» или «ВЕРДИКТ: ДОРАБОТАТЬ».`;

  try {
    const text =
      (await callLLM(
        [
          { role: 'system', content: system },
          { role: 'user', content: userPrompt },
        ],
        { temperature: 0.4, maxTokens: 800 }
      )) || `(пустая рецензия) по задаче «${task.title}».`;
    return { text, verdict: parseVerdict(text), score: parseScore(text) };
  } catch (e) {
    console.error('⚠️  Критик не смог обратиться к мозгу (Groq):', e.message);
    return { text: `(сбой связи с LLM) Рецензия по «${task.title}» не сформирована.`, verdict: 'accept', score: null };
  }
}
