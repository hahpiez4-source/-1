// ============================================================
// cleanup-memory.js — РАЗОВАЯ чистка общей памяти роя (2026-06-11).
//
// Удаляет накопившийся мусор, чтобы recall перестал подмешивать хлам:
//   • записи-сбои (сбой связи с LLM / без LLM / упоминания ключа);
//   • служебные «Вернул … на доработку»;
//   • рецензии-мета (tag 'review') — оценки отдельных задач, не знание;
//   • дубли (оставляем самую раннюю копию по началу содержимого).
// Остаются только осмысленные результаты-знания.
//
// Перед запуском сделан бэкап: memory-backup-2026-06-11-before-cleanup.json
// Запуск (ОДИН раз): node cleanup-memory.js
// ============================================================

import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';

const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, {
  auth: { persistSession: false },
});

const isJunk = (c) =>
  /\(сбой связи с LLM\)|\(без LLM\)|\(пустая рецензия\)|GROQ_API_KEY/i.test(c || '');
const isReworkReturn = (c) => /^Вернул .*на доработку/i.test((c || '').trim());

async function main() {
  const { data: rows, error } = await db
    .from('memory')
    .select('id, content, tags, created_at')
    .order('created_at', { ascending: true });
  if (error) throw error;

  const toDelete = new Set();
  const reasons = { мусор: 0, возврат: 0, рецензия: 0, дубль: 0 };

  // 1) категории-под-снос
  const survivors = [];
  for (const r of rows) {
    if (isJunk(r.content)) { toDelete.add(r.id); reasons.мусор++; continue; }
    if (isReworkReturn(r.content)) { toDelete.add(r.id); reasons.возврат++; continue; }
    if ((r.tags || []).includes('review')) { toDelete.add(r.id); reasons.рецензия++; continue; }
    survivors.push(r);
  }

  // 2) дедуп среди оставшихся: оставляем самую РАННЮЮ (rows уже по возрастанию даты)
  const seen = new Set();
  for (const r of survivors) {
    const head = (r.content || '').slice(0, 80).trim();
    if (seen.has(head)) { toDelete.add(r.id); reasons.дубль++; continue; }
    seen.add(head);
  }

  const ids = [...toDelete];
  console.log(`Под удаление: ${ids.length} из ${rows.length}`);
  console.log(`  мусор: ${reasons.мусор}, возвраты: ${reasons.возврат}, рецензии: ${reasons.рецензия}, дубли: ${reasons.дубль}`);
  console.log(`Останется: ${rows.length - ids.length} чистых записей.`);

  if (!ids.length) { console.log('Нечего удалять.'); return; }

  const { error: delErr } = await db.from('memory').delete().in('id', ids);
  if (delErr) throw delErr;
  console.log('✅ Удалено.');
}

main().catch((e) => { console.error('💥', e.message); process.exit(1); });
