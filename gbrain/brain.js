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
