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
import { think, plan, research, review, act, secretary, hasBrain, hasWebSearch } from './brain.js';
import { getAgent, roleHolder, isOrganizerTask } from './roster.js';

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
// Кто у нас Архивариус (хранитель памяти) — берём из реестра, не зашиваем имя.
// Ему агенты шлют итоги работы «в память». Роли остальных агентов проверяем
// по флагам/handler из реестра (getAgent), а не по сравнению имён.
const ARCHIVIST = roleHolder('archivist') || 'Архивариус';
const MAX_REWORK = 2; // сколько раз максимум возвращать задачу на доработку

// Чем агент ВЫПОЛНЯЕТ задачу — по его handler из реестра. Сигнатуры у функций
// мозга разные, поэтому оборачиваем каждую под единый вызов (task → результат).
function runHandler(meDef, me, task, memContext, dialog) {
  switch (meDef.handler) {
    case 'research':
      console.log(hasWebSearch() ? '🔎 Ищу информацию в интернете (Tavily)...' : '🧠 Думаю над задачей (без веб-поиска)...');
      return research(task, memContext, dialog);
    case 'act':
      console.log('🛠️  Берусь за дело с инструментами (веб + код, compound)...');
      return act(task, memContext, dialog);
    case 'secretary':
      console.log('📅 Берусь за дело в Google (Календарь / Задачи / Диск)...');
      return secretary(task, memContext, dialog);
    default:
      console.log(hasBrain() ? '🧠 Думаю над задачей (LLM)...' : '⚙️  Обрабатываю (без LLM)...');
      return think(task, me, memContext, dialog);
  }
}

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

// --- УМНАЯ ПАМЯТЬ: достать из задачи ключевые слова и поискать в общей памяти ---

// Частые слова, которые не несут смысла для поиска — отбрасываем.
const STOPWORDS = new Set([
  'как', 'что', 'для', 'это', 'или', 'при', 'над', 'под', 'без', 'про', 'так',
  'вот', 'еще', 'ещё', 'уже', 'все', 'всё', 'был', 'быть', 'есть', 'нет', 'там',
  'тут', 'тот', 'эта', 'эти', 'нужно', 'надо', 'сделай', 'сделать', 'пожалуйста',
  'рамках', 'цели', 'задача', 'задачи', 'результат', 'the', 'and', 'for', 'you',
  'your', 'with', 'this', 'that',
]);

// Выделить до 6 значимых ключевых слов из текста задачи.
function keywords(text) {
  const words = String(text).toLowerCase().match(/[a-zа-яё0-9]+/gi) || [];
  const seen = new Set();
  const out = [];
  for (const w of words) {
    if (w.length < 3) continue;
    if (STOPWORDS.has(w)) continue;
    if (seen.has(w)) continue;
    seen.add(w);
    out.push(w);
    if (out.length >= 6) break;
  }
  return out;
}

// Найти в общей памяти роя записи, релевантные задаче. Возвращает готовый
// текстовый блок для промпта (или '' если ничего полезного не нашлось).
async function recallContext(task) {
  const kw = keywords(`${task.title} ${task.description || ''}`);
  if (!kw.length) return '';

  // объединяем ключевые слова через OR — так находим записи по ЛЮБОМУ из слов.
  // Берём с запасом (6), затем отсекаем слабые по релевантности и оставляем топ-3.
  const q = kw.join(' or ');
  const { data, error } = await db.rpc('search_memory', { q, max_results: 6 });
  if (error) {
    console.error('⚠️  Поиск в памяти не удался:', error.message);
    return '';
  }
  if (!data || !data.length) return '';

  const MIN_RANK = 0.01; // отсекаем почти-нулевые совпадения (шум)
  const lines = [];
  for (const m of data) {
    if (typeof m.rank === 'number' && m.rank < MIN_RANK) continue;
    const body = (m.content || '').replace(/\s+/g, ' ').trim();
    if (!body) continue;
    // не подсовываем агенту его же текущий результат (он уже в описании задачи)
    if (task.description && task.description.includes(body.slice(0, 80))) continue;
    lines.push(`• ${m.title ? m.title + ': ' : ''}${body.slice(0, 280)}`);
    if (lines.length >= 3) break; // не больше трёх самых релевантных
  }
  if (!lines.length) return '';

  console.log(`📚 Нашёл в памяти ${lines.length} релевантн. запис(ь/и) — учту в работе.`);
  return lines.join('\n');
}

// Из описания выполненной задачи достаём ИСХОДНОЕ сообщение пользователя —
// это всё, что идёт ДО первой пометки «--- Результат ... ---» / «--- План ... ---»
// (её дописывает агент, когда складывает итог в описание).
function userPartOf(desc) {
  if (!desc) return '';
  const m = desc.match(/\n+---\s*(Результат|План)[^\n]*---/);
  return (m ? desc.slice(0, m.index) : desc).trim();
}

// Из описания достаём ОТВЕТ роя — содержимое ПОСЛЕДНЕЙ секции «--- Результат/План ---».
function botPartOf(desc) {
  if (!desc) return '';
  const re = /---\s*(Результат|План)[^\n]*---\n/g;
  let m;
  let last = null;
  while ((m = re.exec(desc)) !== null) last = m;
  if (!last) return '';
  return desc.slice(last.index + last[0].length).trim();
}

// --- ПАМЯТЬ ДИАЛОГА: недавняя переписка ЭТОГО чата Telegram ---
// Берём последние выполненные задачи с тем же chat_id и восстанавливаем из них
// пары «пользователь → рой». Возвращаем готовый текст для подсказки агенту
// (или пусто: задача не из Telegram, либо разговор ещё пуст).
async function recallDialog(task, limit = 4) {
  if (!task.chat_id) return '';
  const { data, error } = await db
    .from('tasks')
    .select('title, description, created_at')
    .eq('chat_id', task.chat_id)
    .eq('status', 'done')
    .neq('id', task.id)
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) {
    console.error('⚠️  Не смог поднять историю диалога:', error.message);
    return '';
  }
  if (!data || !data.length) return '';

  // были от новых к старым — переворачиваем в хронологический порядок
  const turns = [];
  for (const t of data.reverse()) {
    const user = userPartOf(t.description) || t.title;
    const bot = botPartOf(t.description);
    if (!user && !bot) continue;
    turns.push(`🧑 Пользователь: ${user}\n🤖 Рой: ${bot || '(без ответа)'}`);
  }
  if (!turns.length) return '';

  console.log(`💬 Помню ${turns.length} реплик(у/и) из этого чата — учту в ответе.`);
  return turns.join('\n\n');
}

// --- ЗАПИСЬ В ОБЩУЮ ПАМЯТЬ: с защитой от мусора и дублей ---
// Память роя должна копить ЗНАНИЯ (принятые результаты), а не черновики,
// сбои и повторы. Поэтому:
//   • Критик передаёт Архивариусу только ПРИНЯТЫЙ результат — письмом с этим
//     маркером в первой строке;
//   • saveMemory отсекает явный мусор и дубли перед записью.
const MEMORY_MARKER = '[В ПАМЯТЬ]';

// Признаки «мусора»: записи-сбои и слишком короткие — пользы ноль.
function isJunkMemory(content) {
  const c = String(content || '').trim();
  if (c.length < 25) return true;
  return /\(сбой связи с LLM\)|\(без LLM\)|\(пустая рецензия\)|GROQ_API_KEY|\(сбой\b/i.test(c);
}

// Сохранить запись в память роя. Возвращает true, если реально записали.
async function saveMemory(db, { agent_id, kind = 'fact', title, content, tags = [] }) {
  const c = String(content || '').trim();
  if (isJunkMemory(c)) {
    console.log('🗑️  В память не кладу: мусор/слишком коротко.');
    return false;
  }
  // дедуп: уже есть запись с таким же началом содержимого? (ловит повторные
  // сохранения того же результата при доработках). % и _ из шаблона убираем.
  const head = c.slice(0, 80).replace(/[%_]/g, ' ');
  const { data: dupes } = await db
    .from('memory').select('id').ilike('content', `${head}%`).limit(1);
  if (dupes && dupes.length) {
    console.log('♻️  В память не кладу: похожая запись уже есть (дубль).');
    return false;
  }
  const { error } = await db.from('memory').insert({ agent_id, kind, title, content: c, tags });
  if (error) {
    console.error('⚠️  Не смог записать память:', error.message);
    return false;
  }
  console.log('🗄️  Записал в общую память.');
  return true;
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
    if (getAgent(me.name).archivist) {
      let saved;
      if (letter.body.startsWith(MEMORY_MARKER)) {
        // структурированное письмо от Критика: «[В ПАМЯТЬ]\n<заголовок>\n<текст>».
        // Это ПРИНЯТЫЙ результат — кладём как знание (kind=fact, tag=result).
        const rest = letter.body.slice(MEMORY_MARKER.length).trim();
        const nl = rest.indexOf('\n');
        const title = (nl === -1 ? rest : rest.slice(0, nl)).trim().slice(0, 200);
        const content = (nl === -1 ? '' : rest.slice(nl + 1)).trim();
        saved = await saveMemory(db, {
          agent_id: me.id, kind: 'fact', title, content, tags: ['result', fromName],
        });
      } else {
        // обычное письмо — сохраняем как заметку (с фильтром мусора и дедупом).
        saved = await saveMemory(db, {
          agent_id: me.id, kind: 'note',
          title: `Из письма от «${fromName}»`,
          content: letter.body, tags: ['inbox', fromName],
        });
      }

      // ответ отправителю (личное письмо обратно)
      await db.from('messages').insert({
        from_id: me.id,
        to_id: letter.from_id,
        task_id: letter.task_id ?? null,
        body: saved ? `Принял, записал в память ✅` : `Принял (в память не клал — мусор/дубль).`,
      });
      console.log(`✉️  Ответил «${fromName}».`);
    }
  }
}

// --- СТРАТЕГ: разложить цель на подзадачи и положить их на доску ---
// Возвращает true, если цель была разложена (tick завершён),
// false — если разбить не удалось (тогда задачу выполняем как обычную).
async function decompose(me, task) {
  console.log(hasBrain() ? '🧭 Планирую: разбиваю цель на подзадачи...' : '⚙️  Нет LLM — план не построить.');
  const subtasks = await plan(task);

  if (!subtasks.length) {
    console.log('🤔 Не получилось разложить на подзадачи — выполню как обычную задачу.');
    return false;
  }

  // кладём подзадачи на доску: ничьи (assignee_id null) → ядро раздаст их;
  // priority чуть выше родителя, чтобы делались раньше следующих целей.
  const childPriority = Math.max(1, (task.priority ?? 3) - 1);
  // вшиваем исходную цель в описание каждой подзадачи: исполнитель берёт её
  // в отрыве от родителя и иначе теряет тему (LLM начинает фантазировать).
  const goalContext = `(в рамках цели: «${task.title}»)`;
  const rows = subtasks.map((s) => ({
    title: s.title,
    description: `${goalContext}\n${s.description || ''}`.trim(),
    status: 'todo',
    priority: childPriority,
    parent_task_id: task.id,
    created_by: me.id,
  }));

  const { error: insErr } = await db.from('tasks').insert(rows);
  if (insErr) {
    console.error('⚠️  Не смог создать подзадачи:', insErr.message);
    return false;
  }

  const planText = subtasks.map((s, i) => `${i + 1}. ${s.title}${s.description ? ` — ${s.description}` : ''}`).join('\n');
  console.log(`🗂️  Создал ${subtasks.length} подзадач(и):\n${planText}\n`);

  // саму цель помечаем выполненной (план построен) и сохраняем план в описание
  const stamped =
    (task.description ? task.description + '\n\n' : '') +
    `--- План (${me.name}, ${ts()}) ---\n${planText}`;
  await db.from('tasks').update({ status: 'done', description: stamped }).eq('id', task.id);

  // сообщаем план рою (в общий мессенджер). В память план не идёт — память
  // копит только ПРИНЯТЫЕ Критиком результаты, а не промежуточные планы.
  await db.from('messages').insert({
    from_id: me.id,
    to_id: null,
    task_id: task.id,
    body: `Разложил цель «${task.title}» на ${subtasks.length} подзадач:\n${planText}`,
  });
  console.log(`🗂️  Сообщил план рою.`);

  await db.from('agents').update({ status: 'idle', last_seen: now() }).eq('id', me.id);
  return true;
}

// --- КРИТИК: найти одну выполненную, но ещё не отрецензированную задачу
// (сделанную НЕ нами) и написать рецензию. Возвращает true, если рецензировал.
async function reviewDoneTasks(me) {
  const { data: rows, error } = await db
    .from('tasks')
    .select('id, title, description, assignee_id, rework_count')
    .eq('status', 'done')
    .is('reviewed_at', null)
    .not('assignee_id', 'is', null) // только реально кем-то сделанные
    .neq('assignee_id', me.id) // не рецензируем сами себя
    .order('updated_at', { ascending: true })
    .limit(5);

  if (error) {
    console.error('⚠️  Не смог прочитать доску для ревью:', error.message);
    return false;
  }
  // НЕ рецензируем секретарские задачи (Google): возврат «на доработку» заставил бы
  // Секретаря повторить действие и создать ДУБЛИКАТ события/задачи. Помечаем их
  // отрецензированными, чтобы не висели, и пропускаем.
  // ВАЖНО: органайзерность определяем по ИСХОДНОМУ запросу пользователя
  // (userPartOf), а НЕ по всему описанию — иначе слово «календарь/напоминание»,
  // случайно попавшее в РЕЗУЛЬТАТ, ложно метит обычную задачу как секретарскую
  // и она остаётся без рецензии (а значит и без записи в память).
  const isOrganizer = (r) => isOrganizerTask(`${r.title} ${userPartOf(r.description)}`);
  for (const r of rows || []) {
    if (isOrganizer(r)) {
      await db.from('tasks').update({ reviewed_at: now() }).eq('id', r.id).is('reviewed_at', null);
    }
  }
  const task = (rows || []).find((r) => !isOrganizer(r));
  if (!task) return false;

  // АТОМАРНО «застолбим» рецензию: ставим reviewed_at только если он ещё пуст,
  // чтобы два Критика не отрецензировали одну задачу дважды.
  const { data: claimed, error: claimErr } = await db
    .from('tasks')
    .update({ reviewed_at: now() })
    .eq('id', task.id)
    .is('reviewed_at', null)
    .select('id');

  if (claimErr) {
    console.error('⚠️  Ошибка при бронировании рецензии:', claimErr.message);
    return false;
  }
  if (!claimed || claimed.length === 0) return true; // успел другой — на новый круг

  console.log(`\n🔍 [${ts()}] Рецензирую результат задачи: "${task.title}"`);
  await db.from('agents').update({ status: 'working', last_seen: now() }).eq('id', me.id);

  console.log(hasBrain() ? '🧠 Разбираю результат (LLM)...' : '⚙️  Просматриваю (без LLM)...');
  const { text, verdict, score } = await review(task);
  console.log(`📝 Рецензия (${verdict === 'rework' ? 'доработать' : 'принять'}${score ? `, оценка ${score}/10` : ''}):\n${text}\n`);

  // Рецензию в память НЕ кладём — это мета-шум (оценка одной задачи, не знание).
  // В память попадёт сам ПРИНЯТЫЙ результат (ниже, в ветке «принято»).

  // ЦИКЛ ДОРАБОТКИ: вердикт «доработать» и лимит ещё не исчерпан →
  // возвращаем задачу на доску тому же автору, подшив замечания в описание.
  if (verdict === 'rework' && task.rework_count < MAX_REWORK) {
    const round = task.rework_count + 1;
    const newDescription =
      (task.description ? task.description + '\n\n' : '') +
      `--- На доработку (замечания Критика, раунд ${round}) ---\n${text}`;

    await db
      .from('tasks')
      .update({
        status: 'todo', // снова на доску
        reviewed_at: null, // после новой версии Критик отрецензирует заново
        rework_count: round,
        description: newDescription,
        review_verdict: verdict, // последний вердикт (промежуточный — reviewed_at сброшен)
        review_score: score, // оценка этой версии (1..10 или null)
      })
      .eq('id', task.id);

    await db.from('messages').insert({
      from_id: me.id,
      to_id: task.assignee_id,
      task_id: task.id,
      body: `Вернул «${task.title}» на доработку (раунд ${round}/${MAX_REWORK}). Замечания:\n${text}`,
    });
    console.log(`↩️  Вернул задачу на доработку автору (раунд ${round}/${MAX_REWORK}).`);
  } else {
    // принято (хорошо ИЛИ исчерпан лимит доработок) — задача остаётся done.
    // Сохраняем ФИНАЛЬНЫЙ вердикт+оценку: verdict='rework' при done+reviewed
    // означает «принято по лимиту» — сигнал низкого качества для метрик.
    await db
      .from('tasks')
      .update({ review_verdict: verdict, review_score: score })
      .eq('id', task.id);

    const note =
      verdict === 'rework'
        ? ` (лимит доработок ${MAX_REWORK} исчерпан — принимаю как есть)`
        : '';
    await db.from('messages').insert({
      from_id: me.id,
      to_id: task.assignee_id,
      task_id: task.id,
      body: `Рецензия на «${task.title}» — принято${note}:\n${text}`,
    });

    // В ПАМЯТЬ — только честно принятые результаты (verdict='accept', НЕ по лимиту).
    // Передаём принятый результат Архивариусу структурированным письмом.
    if (verdict === 'accept') {
      const result = botPartOf(task.description);
      const archivist = await findAgentByName(ARCHIVIST);
      if (result && archivist && archivist.id !== me.id) {
        await db.from('messages').insert({
          from_id: me.id,
          to_id: archivist.id,
          task_id: task.id,
          body: `${MEMORY_MARKER}\n${task.title}\n${result}`,
        });
        console.log('✉️  Передал принятый результат Архивариусу — в память.');
      }
    }
    console.log(`✅ Принято${note}. Отправил рецензию автору.`);
  }

  await db.from('agents').update({ status: 'idle', last_seen: now() }).eq('id', me.id);
  return true;
}

// Один круг дежурства. Возвращает true, если была активность (можно сразу повторить).
async function tick(me) {
  const meDef = getAgent(me.name); // моя запись в реестре: роль, handler, флаги
  await db.from('agents').update({ last_seen: now() }).eq('id', me.id);

  // 0) сначала разбираем почту
  await checkMailbox(me);

  // 0.5) КРИТИК: его главная работа — рецензировать чужие готовые результаты.
  //      Если есть что рецензировать — делаем это и идём на новый круг.
  if (meDef.critic) {
    const reviewed = await reviewDoneTasks(me);
    if (reviewed) return true;
    // нечего рецензировать — Критик ниже может взять обычную задачу (если назначат)
  }

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
      .select('id, title, description')
      .eq('status', 'todo')
      .is('assignee_id', null)
      .order('priority', { ascending: true })
      .order('created_at', { ascending: true })
      .limit(5);
    if (free.error) {
      console.error('⚠️  Не смог прочитать доску:', free.error.message);
      return false;
    }
    // «Ничьи» задачи про Google (календарь/события/напоминания/Диск) берёт ТОЛЬКО
    // Секретарь — у остальных нет рук в Google, иначе они выдумают результат.
    const pool =
      meDef.organizer
        ? free.data || []
        : (free.data || []).filter((t) => !isOrganizerTask(`${t.title} ${userPartOf(t.description)}`));
    candidate = pool[0] ?? null;
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
    .select('id, title, description, parent_task_id, priority, chat_id');

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

  // 🧭 СТРАТЕГ: если это КОРНЕВАЯ цель (без родителя) — раскладываем её на подзадачи.
  //    Подзадачи (у которых parent_task_id уже задан) Стратег выполняет как обычные —
  //    это защита от бесконечного дробления.
  if (meDef.planner && !task.parent_task_id) {
    const handled = await decompose(me, task);
    if (handled) return true;
    // если разложить не удалось — падаем ниже в обычный режим
  }

  // 📚 УМНАЯ ПАМЯТЬ: перед работой ищем в общей памяти роя похожий прошлый
  //    опыт и передаём его агенту как справку (только если есть LLM — иначе
  //    контекст некому учитывать).
  const memContext = hasBrain() ? await recallContext(task) : '';

  // 💬 ПАМЯТЬ ДИАЛОГА: если задача пришла из чата Telegram — поднимаем недавнюю
  //    переписку этого чата, чтобы агент отвечал с учётом разговора, а не с нуля.
  const dialog = hasBrain() ? await recallDialog(task) : '';

  // 🧠 РАБОТАЕМ над задачей способом из реестра (handler): Исследователь ищет в
  //    интернете, Мастер берётся руками (веб+код), Секретарь — в Google, остальные
  //    «думают» обычной LLM (или заглушка, если ключа нет).
  const result = await runHandler(meDef, me, task, memContext, dialog);
  console.log(`📝 Результат:\n${result}\n`);

  // сохраняем результат прямо в задачу (в описание дописываем итог)
  const stamped =
    (task.description ? task.description + '\n\n' : '') +
    `--- Результат (${me.name}, ${ts()}) ---\n${result}`;
  await db.from('tasks').update({ status: 'done', description: stamped }).eq('id', task.id);
  console.log('✅ Готово.');

  // 3) отчитываемся в общий мессенджер роя. В память результат сейчас НЕ кладём —
  //    это сделает Критик, и только если ПРИМЕТ результат (чтобы память копила
  //    проверенные знания, а не черновики и промежуточные версии доработок).
  await db.from('messages').insert({
    from_id: me.id,
    to_id: null, // всем в рой
    task_id: task.id,
    body: `Задачу «${task.title}» выполнил ✅\nРезультат:\n${result}`,
  });
  console.log('💬 Написал результат в общий мессенджер роя.');

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
