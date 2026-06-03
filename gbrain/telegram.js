// ============================================================
// telegram.js — МОСТ между Telegram и роем gbrain.
//
// Что делает:
//   1) слушает сообщения твоего бота (long-polling getUpdates);
//   2) каждое сообщение кладёт ЗАДАЧЕЙ на общую доску (без исполнителя),
//      чтобы ЯДРО gbrain само отдало её подходящему агенту;
//   3) дожидается, пока задача станет «done», и присылает РЕЗУЛЬТАТ обратно
//      в тот же чат.
//
// Важно: чтобы задачи реально выполнялись, параллельно должны работать
//   ядро и агенты:  npm run gbrain   и   npm run agent (для нужных агентов).
//
// Запуск:   npm run telegram
// Остановка: Ctrl+C
// ============================================================

import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';

const {
  SUPABASE_URL,
  SUPABASE_SERVICE_KEY,
  TELEGRAM_BOT_TOKEN,
  TELEGRAM_ALLOWED_CHAT_ID, // (необязательно) пускать только этот чат
} = process.env;

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  console.error('❌ Нет SUPABASE_URL или SUPABASE_SERVICE_KEY в .env');
  process.exit(1);
}
if (!TELEGRAM_BOT_TOKEN) {
  console.error('❌ Нет TELEGRAM_BOT_TOKEN в .env. Получи токен у @BotFather и впиши его.');
  process.exit(1);
}

const API = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}`;
const db = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, { auth: { persistSession: false } });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ts = () => new Date().toLocaleTimeString();

// task_id -> { chatId }: какие задачи ждём и куда вернуть результат.
const pending = new Map();

// Временные сбои на стороне Telegram/сети, при которых имеет смысл просто
// подождать и повторить запрос (а не падать с ошибкой).
const TRANSIENT_CODES = new Set([429, 500, 502, 503, 504]);

// --- вызов Telegram API (с авто-повтором при временных сбоях) ---
async function tg(method, payload, attempt = 1) {
  const MAX_ATTEMPTS = 5; // дальше уже бросаем ошибку наверх
  try {
    const resp = await fetch(`${API}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const data = await resp.json();
    if (!data.ok) {
      // Временный сбой (502 Bad Gateway и т.п.) — тихо подождём и повторим.
      if (TRANSIENT_CODES.has(data.error_code) && attempt < MAX_ATTEMPTS) {
        const wait = data.parameters?.retry_after // Telegram сам просит подождать N сек
          ? data.parameters.retry_after * 1000
          : Math.min(1000 * 2 ** (attempt - 1), 15000); // 1s, 2s, 4s, 8s…
        console.log(`🔁 Telegram ${method}: ${data.error_code} — повтор ${attempt}/${MAX_ATTEMPTS} через ${Math.round(wait / 1000)}с`);
        await sleep(wait);
        return tg(method, payload, attempt + 1);
      }
      throw new Error(`Telegram ${method}: ${JSON.stringify(data).slice(0, 200)}`);
    }
    return data.result;
  } catch (e) {
    // Обрыв сети/DNS (fetch бросил исключение, а не вернул ответ) — тоже повторяем.
    if (e.name === 'TypeError' && attempt < MAX_ATTEMPTS) {
      const wait = Math.min(1000 * 2 ** (attempt - 1), 15000);
      console.log(`🔁 Telegram ${method}: сеть недоступна — повтор ${attempt}/${MAX_ATTEMPTS} через ${Math.round(wait / 1000)}с`);
      await sleep(wait);
      return tg(method, payload, attempt + 1);
    }
    throw e;
  }
}

async function send(chatId, text) {
  try {
    await tg('sendMessage', { chat_id: chatId, text });
  } catch (e) {
    console.error('⚠️  Не смог отправить в Telegram:', e.message);
  }
}

// Достать из описания задачи именно РЕЗУЛЬТАТ (или ПЛАН), игнорируя замечания
// Критика. Берём содержимое последней секции «--- Результат ... ---» / «--- План ... ---».
function extractResult(desc) {
  if (!desc) return 'Готово ✅';
  const re = /---\s*(Результат|План)[^\n]*---\n/g;
  let m;
  let last = null;
  while ((m = re.exec(desc)) !== null) last = m;
  if (!last) return desc.trim();
  let rest = desc.slice(last.index + last[0].length);
  // обрезать по следующему маркеру (если за результатом идут замечания и т.п.)
  const nextMarker = rest.search(/\n*---\s.*?\s---/);
  if (nextMarker !== -1) rest = rest.slice(0, nextMarker);
  return rest.trim() || 'Готово ✅';
}

// --- следим за выполнением: шлём результат в чат СРАЗУ, как только задача
//     стала ГОТОВА (status === 'done'). Шаг ревью Критиком в чате отключён —
//     ответ не ждёт принятия. ---
async function watchResults() {
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      if (pending.size) {
        const ids = [...pending.keys()];
        const { data, error } = await db
          .from('tasks')
          .select('id, status, description, reviewed_at')
          .in('id', ids);
        if (!error) {
          for (const t of data || []) {
            const entry = pending.get(t.id);
            if (!entry) continue;

            if (t.status === 'done') {
              // ревью отключено: отправляем сразу, как только задача готова
              pending.delete(t.id);
              await send(entry.chatId, extractResult(t.description));
              console.log(`📤 [${ts()}] Результат задачи ${t.id} → чат ${entry.chatId}.`);
            }
          }
        }
      }
    } catch (e) {
      console.error('⚠️  Ошибка слежения за результатами:', e.message);
    }
    await sleep(2500);
  }
}

// --- разобрать одно входящее сообщение ---
async function handleMessage(msg) {
  if (!msg || !msg.text) return;
  const chatId = msg.chat.id;
  const text = msg.text.trim();

  if (text.startsWith('/start')) {
    await send(
      chatId,
      'Привет! Я — мост к рою gbrain 🧠\n' +
        'Напиши мне любую задачу или вопрос — рой возьмёт её в работу и пришлёт результат.\n\n' +
        `Твой chat_id: ${chatId}\n` +
        '(чтобы пускать только себя — впиши его в TELEGRAM_ALLOWED_CHAT_ID в .env)'
    );
    return;
  }

  // фильтр чужих чатов (если задан разрешённый)
  if (TELEGRAM_ALLOWED_CHAT_ID && String(chatId) !== String(TELEGRAM_ALLOWED_CHAT_ID)) {
    console.log(`⛔ [${ts()}] Сообщение от постороннего чата ${chatId} — игнор.`);
    return;
  }

  // кладём задачу на доску БЕЗ исполнителя — ядро само раздаст
  const title = text.length > 80 ? text.slice(0, 77) + '…' : text;
  const { data: task, error } = await db
    .from('tasks')
    .insert({ title, description: text, status: 'todo', priority: 2, chat_id: chatId })
    .select('id')
    .single();

  if (error || !task) {
    console.error('⚠️  Не смог создать задачу:', error?.message);
    await send(chatId, 'Не получилось поставить задачу рою 😕 Попробуй ещё раз.');
    return;
  }

  pending.set(task.id, { chatId });
  console.log(`📥 [${ts()}] Telegram (чат ${chatId}): "${title}" → задача ${task.id}`);
  await send(chatId, '🧠 Принял! Рой работает над задачей, пришлю ответ, как только будет готово…');
}

// --- основной цикл: long-polling getUpdates ---
async function main() {
  // узнаём имя бота (и заодно проверяем токен)
  const me = await tg('getMe', {});
  console.log(`\n🤖 Мост Telegram ↔ gbrain запущен. Бот: @${me.username}`);
  console.log('👀 Жду сообщений. Напиши боту в Telegram. Останов — Ctrl+C.');
  console.log('ℹ️  Не забудь параллельно запустить ядро (npm run gbrain) и агентов (npm run agent).\n');

  // сбрасываем «хвост» старых сообщений, чтобы не отвечать на них при старте
  let offset = 0;
  try {
    const backlog = await tg('getUpdates', { timeout: 0 });
    if (backlog.length) offset = backlog[backlog.length - 1].update_id + 1;
  } catch (e) {
    console.error('⚠️  Не смог получить стартовые обновления:', e.message);
  }

  // следим за результатами в фоне
  watchResults();

  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      const updates = await tg('getUpdates', { offset, timeout: 30 });
      for (const u of updates) {
        offset = u.update_id + 1;
        await handleMessage(u.message);
      }
    } catch (e) {
      console.error('⚠️  Ошибка getUpdates:', e.message);
      await sleep(3000);
    }
  }
}

process.on('SIGINT', () => {
  console.log('\n👋 Мост Telegram остановлен.');
  process.exit(0);
});

main().catch((e) => {
  console.error('💥 Ошибка моста:', e.message);
  process.exit(1);
});
