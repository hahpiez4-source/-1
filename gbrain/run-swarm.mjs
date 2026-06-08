// ============================================================
// run-swarm.mjs — ЗАПУСКАЛКА всего роя одной командой.
//
// Поднимает разом:
//   • ЯДРО (дирижёр)        — раздаёт задачи агентам
//   • 6 агентов             — Takopi, Архивариус, Стратег, Исследователь, Мастер, Критик
//   • Telegram-мост         — приём сообщений из Telegram
//
// Логи всех процессов идут сюда же, помечены цветным значком и именем.
// Останов всего роя — один раз Ctrl+C.
//
// Запуск:   npm run swarm
// ============================================================

import { spawn } from 'node:child_process';
import { AGENT_PROCS } from './roster.js';

// Что запускаем: ЯДРО (дирижёр) + все агенты ИЗ РЕЕСТРА (roster.js) + Telegram-мост.
// Список агентов больше НЕ дублируется здесь — он берётся из реестра, поэтому
// новый агент появляется в запуске автоматически, как только добавлен в roster.js.
const PROCS = [
  { name: 'ЯДРО', emoji: '🧩', file: 'gbrain.js', env: {} },
  ...AGENT_PROCS,
  { name: 'Telegram', emoji: '📨', file: 'telegram.js', env: {} },
];

const children = [];
let stopping = false;

// Печать строки лога с меткой процесса (пустые строки пропускаем).
function printLines(label, chunk, isErr) {
  for (const line of chunk.toString().split('\n')) {
    if (line.trim() === '') continue;
    (isErr ? process.stderr : process.stdout).write(`${label} │ ${line}\n`);
  }
}

// Запустить один процесс и САМ перезапускать его, если он внезапно упал
// (для режима 24/7). При штатной остановке (stopping) — не перезапускаем.
function launch(p) {
  const label = `${p.emoji} ${p.name.padEnd(13)}`;
  const child = spawn('node', [p.file], { env: { ...process.env, ...p.env } });
  child.stdout.on('data', (d) => printLines(label, d, false));
  child.stderr.on('data', (d) => printLines(label, d, true));
  child.on('exit', (code) => {
    if (stopping) return;
    console.log(`${label} │ ⚠️  упал (код ${code}) — перезапускаю через 3 сек...`);
    setTimeout(() => {
      const i = children.indexOf(child);
      const fresh = launch(p);
      if (i !== -1) children[i] = fresh;
      else children.push(fresh);
    }, 3000);
  });
  return child;
}

for (const p of PROCS) {
  children.push(launch(p));
  console.log(`▶️  Запущен: ${p.emoji} ${p.name}`);
}

console.log('\n✅ Рой поднят целиком. Останов всего роя — Ctrl+C.\n');

function stopAll() {
  if (stopping) return;
  stopping = true;
  console.log('\n👋 Останавливаю весь рой...');
  // SIGINT — чтобы агенты успели корректно отметиться offline
  for (const c of children) {
    try {
      c.kill('SIGINT');
    } catch {}
  }
  setTimeout(() => process.exit(0), 1500);
}

process.on('SIGINT', stopAll);
process.on('SIGTERM', stopAll);
