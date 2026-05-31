// ============================================================
// gbrain — worker-агент (Этап «оживить», режим ДЕЖУРСТВА).
//
// Агент запускается ОДИН раз и работает бесконечно:
//   - каждые POLL_MS секунд заглядывает на доску задач
//   - есть задача "todo"  → берёт, делает (in_progress → done),
//                            пишет в общий мессенджер
//   - задач нет           → тихо ждёт следующего круга
//   - каждый круг «отмечается живым» (last_seen = сейчас)
//
// Запуск:   npm run agent
// Остановка: Ctrl+C
// ============================================================

import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';

const {
  SUPABASE_URL,
  SUPABASE_SERVICE_KEY,
  AGENT_NAME = 'Takopi',
  POLL_MS = '5000', // как часто проверять доску (мс)
} = process.env;

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  console.error('❌ Нет SUPABASE_URL или SUPABASE_SERVICE_KEY. Скопируй .env.example в .env и впиши ключ.');
  process.exit(1);
}

const POLL = Number(POLL_MS) || 5000;

const db = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
  auth: { persistSession: false },
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const now = () => new Date().toISOString();

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

// Один круг дежурства: проверить доску и при наличии — выполнить одну задачу.
// Возвращает true, если задача была выполнена (значит можно сразу проверить ещё).
async function tick(me) {
  // отмечаемся живыми
  await db.from('agents').update({ last_seen: now() }).eq('id', me.id);

  // 1) подсматриваем самую приоритетную todo-задачу
  const { data: tasks, error } = await db
    .from('tasks')
    .select('id, title')
    .eq('status', 'todo')
    .order('priority', { ascending: true })
    .order('created_at', { ascending: true })
    .limit(1);

  if (error) {
    console.error('⚠️  Не смог прочитать доску:', error.message);
    return false;
  }

  if (!tasks || tasks.length === 0) {
    // задач нет — тихо ждём (статус idle)
    await db.from('agents').update({ status: 'idle' }).eq('id', me.id);
    return false;
  }

  const candidate = tasks[0];

  // 2) АТОМАРНОЕ бронирование: помечаем задачу за собой ТОЛЬКО если она всё ещё 'todo'.
  //    Если другой агент успел раньше — условие .eq('status','todo') не сработает,
  //    вернётся пусто, и мы просто попробуем следующий круг. Так двое не возьмут одно.
  const { data: claimed, error: claimErr } = await db
    .from('tasks')
    .update({ status: 'in_progress', assignee_id: me.id })
    .eq('id', candidate.id)
    .eq('status', 'todo') // ← вот это и есть «замок»
    .select('id, title');

  if (claimErr) {
    console.error('⚠️  Ошибка при бронировании задачи:', claimErr.message);
    return false;
  }

  if (!claimed || claimed.length === 0) {
    // не успели — задачу перехватил другой агент. Без паники, идём на новый круг.
    return true; // вернём true, чтобы сразу проверить, нет ли других задач
  }

  const task = claimed[0];
  console.log(`\n📋 [${new Date().toLocaleTimeString()}] Беру задачу: "${task.title}"`);

  await db.from('agents').update({ status: 'working', last_seen: now() }).eq('id', me.id);
  console.log('⚙️  В работе...');

  await sleep(1500); // имитация полезной работы

  await db.from('tasks').update({ status: 'done' }).eq('id', task.id);
  await db.from('messages').insert({
    from_id: me.id,
    to_id: null, // всем в рой
    task_id: task.id,
    body: `Задачу «${task.title}» выполнил ✅`,
  });
  console.log('✅ Готово, написал в мессенджер роя.');

  await db.from('agents').update({ status: 'idle', last_seen: now() }).eq('id', me.id);
  return true;
}

async function main() {
  const me = await findSelf();
  console.log(`\n🤖 Агент "${me.name}" (${me.color}) заступил на дежурство.`);
  console.log(`👀 Проверяю доску каждые ${POLL / 1000} сек. Останов — Ctrl+C.\n`);

  let idleNote = false; // чтобы не спамить "задач нет" каждый круг

  // бесконечный цикл дежурства
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      const did = await tick(me);
      if (did) {
        idleNote = false;
        // выполнили — сразу проверим, нет ли ещё (короткая пауза)
        await sleep(300);
        continue;
      }
      if (!idleNote) {
        console.log(`📭 [${new Date().toLocaleTimeString()}] Задач нет, жду новые...`);
        idleNote = true; // покажем сообщение один раз, пока доска пустая
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
