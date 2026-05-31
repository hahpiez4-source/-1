// ============================================================
// brain.js — «мозг» агента: обращение к LLM через Groq.
//
// Groq отдаёт OpenAI-совместимый API, поэтому ходим обычным fetch,
// без лишних библиотек. Нужен только GROQ_API_KEY в .env.
//
// Экспортируем одну функцию think(task, agent) — агент «думает» над
// задачей и возвращает текстовый результат. Если ключа нет или
// случилась ошибка — возвращаем аккуратную заглушку, чтобы рой
// не падал (агент продолжит работать «без мозга»).
// ============================================================

const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions';
const MODEL = process.env.GROQ_MODEL || 'llama-3.3-70b-versatile';

// Есть ли вообще мозг (ключ)?
export function hasBrain() {
  return Boolean(process.env.GROQ_API_KEY);
}

// Агент думает над задачей. Возвращает строку-результат.
export async function think(task, agent) {
  // нет ключа — честно работаем «без мозга»
  if (!process.env.GROQ_API_KEY) {
    return `(без LLM) Задача «${task.title}» обработана. Подключи GROQ_API_KEY, чтобы агент думал по-настоящему.`;
  }

  const systemPrompt =
    `Ты — ИИ-агент по имени «${agent.name}» в рое из нескольких агентов. ` +
    `Тебе дали задачу с общей доски. Выполни её по существу: дай краткий, ` +
    `полезный результат на русском языке. Без воды и лишних вступлений. ` +
    `Если задача расплывчатая — сделай разумное предположение и предложи конкретику.`;

  const userPrompt =
    `Задача: ${task.title}\n` +
    (task.description ? `Описание: ${task.description}\n` : '') +
    `\nДай результат (5–8 предложений максимум).`;

  try {
    const resp = await fetch(GROQ_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${process.env.GROQ_API_KEY}`,
      },
      body: JSON.stringify({
        model: MODEL,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        temperature: 0.7,
        max_tokens: 600,
      }),
    });

    if (!resp.ok) {
      const errText = await resp.text();
      console.error(`⚠️  Groq ответил ошибкой ${resp.status}: ${errText.slice(0, 200)}`);
      return `(ошибка LLM ${resp.status}) Задача «${task.title}» помечена выполненной без результата.`;
    }

    const data = await resp.json();
    const answer = data?.choices?.[0]?.message?.content?.trim();
    return answer || `(пустой ответ LLM) по задаче «${task.title}».`;
  } catch (e) {
    console.error('⚠️  Не смог обратиться к мозгу (Groq):', e.message);
    return `(сбой связи с LLM) Задача «${task.title}» помечена выполненной без результата.`;
  }
}
