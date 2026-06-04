// ============================================================
// gbrain.js — ЯДРО роя (дирижёр / диспетчер).
//
// Это «общий мозг»: он сам НЕ выполняет задачи, а РАЗДАЁТ их
// нужным агентам по их характеру/роли.
//
// Каждый круг:
//   1) находит на доске задачи "todo" БЕЗ исполнителя (assignee_id is null);
//   2) для каждой думает (LLM): какому агенту она лучше подходит;
//   3) назначает задачу этому агенту (ставит assignee_id, статус остаётся todo);
//   4) агенты сами берут СВОИ назначенные задачи (см. agent.js).
//
// Если мозга (ключа) нет — раздаёт по очереди (round-robin), чтобы рой работал.
//
// Запуск:   npm run gbrain
// Остановка: Ctrl+C
// ============================================================

import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
import { callLLM, hasBrain, looksLikeOrganizerTask } from './brain.js';
import { getPersona } from './personas.js';

const { SUPABASE_URL, SUPABASE_SERVICE_KEY, POLL_MS = '4000' } = process.env;

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  console.error('❌ Нет SUPABASE_URL или SUPABASE_SERVICE_KEY в .env');
  process.exit(1);
}

const POLL = Number(POLL_MS) || 4000;
const db = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, { auth: { persistSession: false } });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ts = () => new Date().toLocaleTimeString();

let rrIndex = 0; // указатель для round-robin (запасной режим без LLM)

// Спрашиваем у LLM, какому агенту отдать задачу. Возвращает имя агента или null.
async function chooseAgent(task, agents) {
  // описываем кандидатов их ролями/характерами
  const roster = agents
    .map((a) => {
      const p = getPersona(a.name);
      return `- ${a.name}: ${p.role}`;
    })
    .join('\n');

  const system =
    'Ты — диспетчер роя ИИ-агентов. Твоя работа — выбрать ОДНОГО агента, ' +
    'которому задача подходит лучше всего по его роли и характеру. ' +
    'Ответь СТРОГО одним словом — именем агента из списка, без пояснений.';

  const user =
    `Агенты роя:\n${roster}\n\n` +
    `Задача: ${task.title}\n` +
    (task.description ? `Описание: ${task.description}\n` : '') +
    `\nКому поручить? Ответь только именем.`;

  const answer = await callLLM(
    [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
    // отдельная модель для роутинга (свой лимит токенов/минуту — разгружаем
    // основной мозг gpt-oss). 70b выбирает агента заметно точнее, чем 8b.
    { temperature: 0, maxTokens: 30, model: 'llama-3.3-70b-versatile' }
  );

  // ищем имя агента внутри ответа (LLM может добавить лишнее)
  const hit = agents.find((a) => answer.toLowerCase().includes(a.name.toLowerCase()));
  return hit ? hit.name : null;
}

async function tick() {
  // берём актуальный список агентов (кому вообще можно поручать)
  const { data: agents, error: aErr } = await db
    .from('agents')
    .select('id, name')
    .order('created_at', { ascending: true });

  if (aErr) {
    console.error('⚠️  Не смог прочитать список агентов:', aErr.message);
    return false;
  }
  if (!agents || agents.length === 0) {
    console.log('🤷 В рое нет агентов — некому раздавать.');
    return false;
  }

  // нераспределённые задачи: todo и без исполнителя
  const { data: tasks, error: tErr } = await db
    .from('tasks')
    .select('id, title, description')
    .eq('status', 'todo')
    .is('assignee_id', null)
    .order('priority', { ascending: true })
    .order('created_at', { ascending: true });

  if (tErr) {
    console.error('⚠️  Не смог прочитать доску:', tErr.message);
    return false;
  }
  if (!tasks || tasks.length === 0) return false;

  // есть ли в рое Секретарь (агент с руками в Google)
  const secretary = agents.find((a) => a.name === 'Секретарь');

  for (const task of tasks) {
    let chosenName = null;

    // ДЕТЕРМИНИРОВАННО: задачи про календарь/события/напоминания/Диск — Секретарю,
    // без LLM-гадания (иначе их перехватывает случайный агент и выдумывает результат).
    if (secretary && looksLikeOrganizerTask(`${task.title} ${task.description || ''}`)) {
      chosenName = secretary.name;
    }

    if (!chosenName && hasBrain()) {
      try {
        chosenName = await chooseAgent(task, agents);
      } catch (e) {
        console.error('⚠️  LLM-маршрутизация не удалась, перехожу на очередь:', e.message);
      }
    }

    // запасной режим: round-robin по агентам
    if (!chosenName) {
      chosenName = agents[rrIndex % agents.length].name;
      rrIndex++;
    }

    const chosen = agents.find((a) => a.name === chosenName);

    // назначаем задачу (статус остаётся todo — агент сам возьмёт «свою»)
    const { error: upErr } = await db
      .from('tasks')
      .update({ assignee_id: chosen.id })
      .eq('id', task.id)
      .is('assignee_id', null); // не перетираем, если кто-то уже назначил

    if (upErr) {
      console.error(`⚠️  Не смог назначить задачу "${task.title}":`, upErr.message);
      continue;
    }

    const how = hasBrain() ? '🧠' : '🔁';
    console.log(`${how} [${ts()}] «${task.title}» → ${chosen.name}`);
  }

  return true;
}

async function main() {
  console.log(`\n🧩 Ядро gbrain запущено. Режим маршрутизации: ${hasBrain() ? '🧠 по характеру (LLM)' : '🔁 по очереди (без LLM)'}.`);
  console.log(`👀 Слежу за доской каждые ${POLL / 1000} сек. Останов — Ctrl+C.\n`);

  let idleNote = false;

  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      const did = await tick();
      if (did) {
        idleNote = false;
        await sleep(300);
        continue;
      }
      if (!idleNote) {
        console.log(`📭 [${ts()}] Нераспределённых задач нет, жду...`);
        idleNote = true;
      }
    } catch (e) {
      console.error('💥 Ошибка в круге ядра:', e.message);
    }
    await sleep(POLL);
  }
}

process.on('SIGINT', () => {
  console.log('\n👋 Ядро gbrain остановлено.');
  process.exit(0);
});

main().catch((e) => {
  console.error('💥 Ошибка ядра:', e.message);
  process.exit(1);
});
