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

import { getPersona } from './personas.js';

const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions';
const MODEL = process.env.GROQ_MODEL || 'llama-3.3-70b-versatile';

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
export async function callLLM(messages, { temperature = 0.7, maxTokens = 600, model = MODEL, raw = false } = {}) {
  const body = { model, messages, temperature };
  // max_tokens шлём, только если задан (даём возможность не ограничивать ответ).
  if (maxTokens) body.max_tokens = maxTokens;

  const resp = await fetch(GROQ_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${process.env.GROQ_API_KEY}`,
    },
    body: JSON.stringify(body),
  });

  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error(`Groq ${resp.status}: ${errText.slice(0, 200)}`);
  }

  const data = await resp.json();
  // raw=true — вернуть весь ответ (нужно, чтобы прочитать executed_tools у compound).
  if (raw) return data;
  return data?.choices?.[0]?.message?.content?.trim() || '';
}

// Агент думает над задачей в СВОЁМ характере. Возвращает строку-результат.
export async function think(task, agent) {
  // нет ключа — честно работаем «без мозга»
  if (!process.env.GROQ_API_KEY) {
    return `(без LLM) Задача «${task.title}» обработана. Подключи GROQ_API_KEY, чтобы агент думал по-настоящему.`;
  }

  // характер агента: своя роль и стиль
  const persona = getPersona(agent.name);
  const systemPrompt =
    persona.system +
    `\n\nТы работаешь в рое агентов и берёшь задачи с общей доски. ` +
    `Отвечай на русском языке, по существу, без лишних вступлений. ` +
    `Если задача расплывчатая — сделай разумное предположение и предложи конкретику.`;

  const userPrompt =
    `Задача: ${task.title}\n` +
    (task.description ? `Описание: ${task.description}\n` : '') +
    `\nДай результат (5–8 предложений максимум).`;

  try {
    return (
      (await callLLM(
        [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        { temperature: 0.7, maxTokens: 600 }
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
      { temperature: 0.4, maxTokens: 700 }
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
export async function research(task) {
  // нет ключа Tavily — честно работаем без веба
  if (!hasWebSearch()) {
    console.log('ℹ️  Нет TAVILY_API_KEY — Исследователь отвечает без веб-поиска.');
    return think(task, { name: 'Исследователь' });
  }

  const query = task.description ? `${task.title}. ${task.description}` : task.title;

  let sr;
  try {
    sr = await tavilySearch(query);
  } catch (e) {
    console.error('⚠️  Веб-поиск (Tavily) не удался, отвечаю в обычном режиме:', e.message);
    return think(task, { name: 'Исследователь' });
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
    `Задача: ${task.title}\n` +
    (task.description ? `Описание: ${task.description}\n` : '') +
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

// ------------------------------------------------------------
// review(task) — РЕЦЕНЗИЯ на результат задачи (для Критика).
// task.description здесь содержит результат работы другого агента.
// Возвращает { text, verdict }, где verdict = 'accept' | 'rework'.
// Без ключа/при сбое — аккуратная заглушка (verdict='accept', чтобы не зациклить).
// ------------------------------------------------------------
export async function review(task) {
  if (!process.env.GROQ_API_KEY) {
    return {
      text: `(без LLM) Результат задачи «${task.title}» просмотрен. Подключи GROQ_API_KEY для настоящей рецензии.`,
      verdict: 'accept',
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
    `В САМОМ КОНЦЕ отдельной строкой напиши ровно один из вариантов: ` +
    `«ВЕРДИКТ: ПРИНЯТЬ» или «ВЕРДИКТ: ДОРАБОТАТЬ».`;

  try {
    const text =
      (await callLLM(
        [
          { role: 'system', content: system },
          { role: 'user', content: userPrompt },
        ],
        { temperature: 0.4, maxTokens: 500 }
      )) || `(пустая рецензия) по задаче «${task.title}».`;
    return { text, verdict: parseVerdict(text) };
  } catch (e) {
    console.error('⚠️  Критик не смог обратиться к мозгу (Groq):', e.message);
    return { text: `(сбой связи с LLM) Рецензия по «${task.title}» не сформирована.`, verdict: 'accept' };
  }
}
