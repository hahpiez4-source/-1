// ============================================================
// metrics.js — ОТЧЁТ О КАЧЕСТВЕ РОЯ (читает БД, ничего не меняет).
//
// Считает качество работы роя из данных, которые УЖЕ копит Критик:
//   • сколько задач принято с первого раза (rework_count = 0);
//   • сколько прошло через доработки и сколько принято «по лимиту» (плохо);
//   • средняя оценка Критика (1..10), если она уже проставляется;
//   • разбивка по агентам — кто чаще попадает на доработку.
//
// Запуск:  npm run metrics      (или node metrics.js)
// Только ЧТЕНИЕ — безопасно запускать на боевой БД в любой момент.
// ============================================================

import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
import { ROSTER } from './roster.js';

const { SUPABASE_URL, SUPABASE_SERVICE_KEY } = process.env;
if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  console.error('❌ Нет SUPABASE_URL / SUPABASE_SERVICE_KEY в .env');
  process.exit(1);
}
const db = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, { auth: { persistSession: false } });

const pct = (n, total) => (total ? Math.round((n / total) * 100) : 0);
const bar = (p, width = 20) => '█'.repeat(Math.round((p / 100) * width)).padEnd(width, '·');

// имя агента по id — из таблицы agents
async function agentNames() {
  const { data } = await db.from('agents').select('id, name, color');
  const map = new Map();
  for (const a of data || []) map.set(a.id, a.name);
  return map;
}

async function main() {
  // тянем все отрецензированные задачи (это и есть «оценённые» Критиком)
  const { data: tasks, error } = await db
    .from('tasks')
    .select('id, assignee_id, rework_count, reviewed_at, review_verdict, review_score, created_at')
    .eq('status', 'done')
    .not('reviewed_at', 'is', null);

  if (error) {
    console.error('❌ Не смог прочитать доску:', error.message);
    process.exit(1);
  }

  const names = await agentNames();
  const reviewed = tasks || [];
  const total = reviewed.length;

  console.log('\n📊 КАЧЕСТВО РОЯ — отчёт (gbrain)');
  console.log('═'.repeat(48));

  if (!total) {
    console.log('Отрецензированных задач пока нет — Критику нечего считать.\n');
    return;
  }

  // --- 1) Приёмка ---
  const firstTry = reviewed.filter((t) => (t.rework_count || 0) === 0);
  const reworked = reviewed.filter((t) => (t.rework_count || 0) > 0);
  // «принято по лимиту» = финальный вердикт всё ещё 'rework' (есть только в новых данных)
  const forced = reviewed.filter((t) => t.review_verdict === 'rework');
  const avgRework = (reviewed.reduce((s, t) => s + (t.rework_count || 0), 0) / total).toFixed(2);

  console.log(`\nОтрецензировано задач: ${total}`);
  console.log(`\n✅ Принято с первого раза   ${String(firstTry.length).padStart(3)} / ${total}  ${pct(firstTry.length, total)}%  ${bar(pct(firstTry.length, total))}`);
  console.log(`🔧 Прошли доработку          ${String(reworked.length).padStart(3)} / ${total}  ${pct(reworked.length, total)}%  ${bar(pct(reworked.length, total))}`);
  console.log(`⛔ Принято «по лимиту» (плохо) ${String(forced.length).padStart(2)} / ${total}  ${pct(forced.length, total)}%  ${bar(pct(forced.length, total))}`);
  console.log(`\nСреднее число доработок на задачу: ${avgRework}`);

  // распределение по числу доработок
  const dist = {};
  for (const t of reviewed) dist[t.rework_count || 0] = (dist[t.rework_count || 0] || 0) + 1;
  const distLine = Object.keys(dist).sort().map((k) => `${k}→${dist[k]}`).join('  ');
  console.log(`Распределение доработок:           ${distLine}`);

  // --- 2) Оценка Критика (если уже копится) ---
  const scored = reviewed.filter((t) => typeof t.review_score === 'number');
  if (scored.length) {
    const avgScore = (scored.reduce((s, t) => s + t.review_score, 0) / scored.length).toFixed(1);
    console.log(`\n⭐ Средняя оценка Критика: ${avgScore}/10  (по ${scored.length} задач${scored.length === total ? '' : ` из ${total}`})`);
  } else {
    console.log(`\n⭐ Оценка Критика (1..10) пока не копится — появится на новых задачах после деплоя.`);
  }

  // --- 3) Разбивка по агентам ---
  console.log(`\n👥 ПО АГЕНТАМ (доля принятых с первого раза):`);
  const byAgent = new Map();
  for (const t of reviewed) {
    const key = t.assignee_id || 'нет';
    if (!byAgent.has(key)) byAgent.set(key, { total: 0, first: 0, scoreSum: 0, scoreN: 0 });
    const a = byAgent.get(key);
    a.total++;
    if ((t.rework_count || 0) === 0) a.first++;
    if (typeof t.review_score === 'number') { a.scoreSum += t.review_score; a.scoreN++; }
  }
  // от лучших к худшим по доле «с первого раза»
  const rows = [...byAgent.entries()]
    .map(([id, a]) => ({ name: names.get(id) || '—', ...a, rate: pct(a.first, a.total) }))
    .sort((x, y) => y.rate - x.rate);
  for (const r of rows) {
    const score = r.scoreN ? `  ⭐${(r.scoreSum / r.scoreN).toFixed(1)}` : '';
    console.log(`  ${r.name.padEnd(14)} ${String(r.rate).padStart(3)}%  (${r.first}/${r.total})  ${bar(r.rate, 12)}${score}`);
  }

  console.log('\n' + '═'.repeat(48));
  console.log('💡 Цель: растить «принято с первого раза» и среднюю оценку,');
  console.log('   гнать к нулю «принято по лимиту». Запускай после изменений.\n');
}

main().catch((e) => {
  console.error('💥 Ошибка:', e.message);
  process.exit(1);
});
