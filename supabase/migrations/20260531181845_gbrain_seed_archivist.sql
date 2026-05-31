-- Второй агент роя: «Архивариус».
-- Идемпотентно: при повторном применении ничего не дублируется.

insert into public.agents (name, color, tg_bot, role, status)
values (
  'Архивариус',
  '#38bdf8',
  null,
  'Хранитель памяти роя: фиксирует результаты задач в общей памяти',
  'idle'
)
on conflict (name) do nothing;
