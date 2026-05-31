-- ============================================================
-- gbrain — наполнение (Этап 1а): первые агенты и тестовые задачи.
-- Idempotent: повторный запуск не плодит дубли (on conflict do nothing).
-- ============================================================

-- Первый реальный агент роя — Takopi (существующий Telegram-бот).
insert into public.agents (name, color, tg_bot, role, status)
values
  ('Takopi', '#e879f9', '@my34_takopi_bot', 'Telegram-мост: принимает сообщения и выполняет задачи через Claude', 'idle')
on conflict (name) do nothing;

-- Тестовые задачи на доску, поставлены на Takopi.
insert into public.tasks (title, description, status, priority, assignee_id)
select t.title, t.description, t.status, t.priority, a.id
from (values
  ('Проверить связь с роем', 'Тестовая задача: убедиться, что агент видит доску задач', 'todo', 2),
  ('Поздороваться в мессенджере', 'Тестовая задача: написать первое сообщение в общий мессенджер', 'todo', 3)
) as t(title, description, status, priority)
cross join (select id from public.agents where name = 'Takopi') a
where not exists (
  select 1 from public.tasks x where x.title = t.title
);
