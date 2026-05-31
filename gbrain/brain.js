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

// Есть ли вообще мозг (ключ)?
export function hasBrain() {
  return Boolean(process.env.GROQ_API_KEY);
}

// Низкоуровневый вызов LLM. messages = [{role, content}, ...].
// Возвращает строку-ответ или бросает ошибку (вызывающий решает, что делать).
export async function callLLM(messages, { temperature = 0.7, maxTokens = 600 } = {}) {
  const resp = await fetch(GROQ_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${process.env.GROQ_API_KEY}`,
    },
    body: JSON.stringify({
      model: MODEL,
      messages,
      temperature,
      max_tokens: maxTokens,
    }),
  });

  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error(`Groq ${resp.status}: ${errText.slice(0, 200)}`);
  }

  const data = await resp.json();
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
