-- ------------------------------------------------------------
-- Память диалога: связываем задачу с чатом Telegram.
-- chat_id = идентификатор чата (Telegram даёт большое число, иногда
-- отрицательное для групп) → bigint. У задач, пришедших не из Telegram
-- (подзадачи Стратега и т.п.), остаётся NULL.
-- Индекс по (chat_id, created_at) — чтобы быстро доставать недавнюю
-- переписку конкретного чата по порядку.
-- ------------------------------------------------------------
alter table public.tasks
  add column if not exists chat_id bigint;

comment on column public.tasks.chat_id is
  'Telegram chat_id, из которого пришла задача (для памяти диалога); NULL для внутренних задач роя';

create index if not exists tasks_chat_idx
  on public.tasks(chat_id, created_at);
