// ============================================================
// Добавить задачу на доску роя.
//
// Запуск:
//   node add-task.js "Название задачи" "Описание (необязательно)" [приоритет]
//
// Пример:
//   node add-task.js "Посчитать что-нибудь" "тестовая задача" 1
//
// Приоритет: меньше число = важнее (по умолчанию 3).
// ============================================================

import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';

const { SUPABASE_URL, SUPABASE_SERVICE_KEY } = process.env;
if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  console.error('❌ Нет SUPABASE_URL или SUPABASE_SERVICE_KEY в .env');
  process.exit(1);
}

const title = process.argv[2];
const description = process.argv[3] ?? null;
const priority = Number(process.argv[4]) || 3;

if (!title) {
  console.error('❌ Укажи название: node add-task.js "Название" "Описание" [приоритет]');
  process.exit(1);
}

const db = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, { auth: { persistSession: false } });

const { data, error } = await db
  .from('tasks')
  .insert({ title, description, status: 'todo', priority })
  .select('id, title, priority')
  .single();

if (error) {
  console.error('❌ Не удалось добавить задачу:', error.message);
  process.exit(1);
}
console.log(`✅ Задача добавлена на доску: "${data.title}" (приоритет ${data.priority})`);
