// ============================================================
// gbrain — worker-агент (режим ДЕЖУРСТВА + переписка агентов).
//
// Каждый круг дежурства агент:
//   0) проверяет свой ПОЧТОВЫЙ ЯЩИК — есть ли письма лично ему,
//      и реагирует на них (Архивариус — сохраняет в общую память);
//   1) заглядывает на доску задач;
//   2) есть "todo" → атомарно бронирует, делает (in_progress → done);
//   3) по итогу пишет ЛИЧНО Архивариусу: «запиши результат в память»
//      (если Архивариуса нет — пишет всем в общий мессенджер);
//   4) каждый круг «отмечается живым» (last_seen = сейчас).
//
// Запуск:   npm run agent           (по умолчанию AGENT_NAME=Takopi)
//           AGENT_NAME=Архивариус npm run agent
// Остановка: Ctrl+C
// ============================================================

import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
import { think, hasBrain } from './brain.js';

const {
  SUPABASE_URL,
  SUPABASE_SERVICE_KEY,
  AGENT_NAME = 'Takopi',
  POLL_MS = '5000', // как часто проверять доску и почту (мс)
} = process.env;

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  console.error('❌ Нет SUPABASE_URL или SUPABASE_SERVICE_KEY. Скопируй .env.example в .env и впиши ключ.');
  process.exit(1);
}

const POLL = Number(POLL_MS) || 5000;
const ARCHIVIST = 'Архивариус'; // агент-хранитель памяти

const db = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
  auth: { persistSession: false },
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const now = () => new Date().toISOString();
const ts = () => new Date().toLocaleTimeString();

// Находим себя в таблице agents (один раз при старте).
async function findSelf() {
  const { data: me, error } = await db
    .from('agents')
    .select('id, name, color')
    .eq('name', AGENT_NAME)
    .single();
  if (error || !me) {
    console.error(`❌ Не нашёл агента "${AGENT_NAME}" в таблице agents.`, error?.message ?? '');
    process.exit(1);
  }
  return me;
}

// Найти агента по имени (возвращает {id, name} или null).
async function findAgentByName(name) {
  const { data } = await db.from('agents').select('id, name').eq('name', name).maybeSingle();
  return data ?? null;
}

// --- ПОЧТОВЫЙ ЯЩИК: читаем письма лично нам (to_id = me.id, ещё не прочитанные) ---
async function checkMailbox(me) {
  const { data: inbox, error } = await db
    .from('messages')
    .select('id, from_id, body, task_id')
    .eq('to_id', me.id)
    .is('read_at', null)
    .order('created_at', { ascending: true });

  if (error) {
    console.error('⚠️  Не смог проверить почту:', error.message);
    return;
  }
  if (!inbox || inbox.length === 0) return;

  for (const letter of inbox) {
    // от кого письмо
    const { data: sender } = await db.from('agents').select('name').eq('id', letter.from_id).maybeSingle();
    const fromName = sender?.name ?? 'неизвестный';
    console.log(`📨 [${ts()}] Письмо от «${fromName}»: ${letter.body}`);

    // помечаем прочитанным
    await db.from('messages').update({ read_at: now() }).eq('id', letter.id);

    // РЕАКЦИЯ: если я Архивариус — сохраняю содержимое в общую память и отвечаю отправителю.
    if (me.name === ARCHIVIST) {
      await db.from('memory').insert({
        agent_id: me.id,
        kind: 'note',
        title: `Из письма от «${fromName}»`,
        content: letter.body,
        tags: ['inbox', fromName],
      });
      console.log(`🗄️  Записал в общую память.`);

      // ответ отправителю (личное письмо обратно)
      await db.from('messages').insert({
        from_id: me.id,
        to_id: letter.from_id,
        task_id: letter.task_id ?? null,
        body: `Принял, записал в память ✅`,
      });
      console.log(`✉️  Ответил «${fromName}».`);
    }
  }
}

// Один круг дежурства. Возвращает true, если была активность (можно сразу повторить).
async function tick(me) {
  await db.from('agents').update({ last_seen: now() }).eq('id', me.id);

  // 0) сначала разбираем почту
  await checkMailbox(me);

  // 1) Ищем задачу. Приоритет: СВОИ назначенные ядром gbrain (assignee_id = я).
  //    Если таких нет — берём ничью (assignee_id is null), чтобы рой работал
  //    и без ядра. Так агент уважает решения диспетчера, но не простаивает.
  let candidate = null;

  const mine = await db
    .from('tasks')
    .select('id, title')
    .eq('status', 'todo')
    .eq('assignee_id', me.id)
    .order('priority', { ascending: true })
    .order('created_at', { ascending: true })
    .limit(1);

  if (mine.error) {
    console.error('⚠️  Не смог прочитать доску:', mine.error.message);
    return false;
  }
  candidate = mine.data?.[0] ?? null;

  if (!candidate) {
    const free = await db
      .from('tasks')
      .select('id, title')
      .eq('status', 'todo')
      .is('assignee_id', null)
      .order('priority', { ascending: true })
      .order('created_at', { ascending: true })
      .limit(1);
    if (free.error) {
      console.error('⚠️  Не смог прочитать доску:', free.error.message);
      return false;
    }
    candidate = free.data?.[0] ?? null;
  }

  if (!candidate) {
    // ни своих, ни ничьих задач — тихо ждём
    await db.from('agents').update({ status: 'idle' }).eq('id', me.id);
    return false;
  }

  // 2) АТОМАРНОЕ бронирование: берём задачу ТОЛЬКО если она всё ещё 'todo'.
  const { data: claimed, error: claimErr } = await db
    .from('tasks')
    .update({ status: 'in_progress', assignee_id: me.id })
    .eq('id', candidate.id)
    .eq('status', 'todo') // ← «замок»: второй агент сюда уже не пройдёт
    .select('id, title');

  if (claimErr) {
    console.error('⚠️  Ошибка при бронировании задачи:', claimErr.message);
    return false;
  }
  if (!claimed || claimed.length === 0) {
    return true; // перехватил другой агент — идём на новый круг
  }

  const task = claimed[0];
  console.log(`\n📋 [${ts()}] Беру задачу: "${task.title}"`);

  await db.from('agents').update({ status: 'working', last_seen: now() }).eq('id', me.id);

  // 🧠 ДУМАЕМ над задачей через LLM (если есть мозг — реальный результат; иначе заглушка)
  console.log(hasBrain() ? '🧠 Думаю над задачей (LLM)...' : '⚙️  Обрабатываю (без LLM)...');
  const result = await think(task, me);
  console.log(`📝 Результат:\n${result}\n`);

  // сохраняем результат прямо в задачу (в описание дописываем итог)
  const stamped =
    (task.description ? task.description + '\n\n' : '') +
    `--- Результат (${me.name}, ${ts()}) ---\n${result}`;
  await db.from('tasks').update({ status: 'done', description: stamped }).eq('id', task.id);
  console.log('✅ Готово.');

  // 3) отчитываемся. Если есть Архивариус (и это не я сам) — пересылаем ему РЕЗУЛЬТАТ в память.
  const archivist = me.name === ARCHIVIST ? null : await findAgentByName(ARCHIVIST);
  if (archivist) {
    await db.from('messages').insert({
      from_id: me.id,
      to_id: archivist.id, // личное письмо конкретному агенту
      task_id: task.id,
      body: `Выполнил задачу «${task.title}». Результат:\n${result}`,
    });
    console.log(`✉️  Отправил результат лично «${ARCHIVIST}» — в память.`);
  } else {
    await db.from('messages').insert({
      from_id: me.id,
      to_id: null, // всем в рой
      task_id: task.id,
      body: `Задачу «${task.title}» выполнил ✅\nРезультат:\n${result}`,
    });
    console.log('💬 Написал результат в общий мессенджер роя.');
  }

  await db.from('agents').update({ status: 'idle', last_seen: now() }).eq('id', me.id);
  return true;
}

async function main() {
  const me = await findSelf();
  console.log(`\n🤖 Агент "${me.name}" (${me.color}) заступил на дежурство.`);
  console.log(`👀 Проверяю доску и почту каждые ${POLL / 1000} сек. Останов — Ctrl+C.\n`);

  let idleNote = false;

  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      const did = await tick(me);
      if (did) {
        idleNote = false;
        await sleep(300);
        continue;
      }
      if (!idleNote) {
        console.log(`📭 [${ts()}] Задач и писем нет, жду...`);
        idleNote = true;
      }
    } catch (e) {
      console.error('💥 Ошибка в круге:', e.message);
    }
    await sleep(POLL);
  }
}

// аккуратное завершение по Ctrl+C: пометить агента offline
async function shutdown() {
  console.log('\n👋 Останавливаюсь, отмечаю агента offline...');
  try {
    const { data: me } = await db.from('agents').select('id').eq('name', AGENT_NAME).single();
    if (me) await db.from('agents').update({ status: 'offline', last_seen: now() }).eq('id', me.id);
  } catch {}
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

main().catch((e) => {
  console.error('💥 Ошибка:', e.message);
  process.exit(1);
});
