-- ============================================================
-- gbrain — фундамент роя агентов (Этап 0)
-- Создаёт 4 таблицы: agents, tasks, messages, memory.
-- Это «общий стол», на который смотрят все агенты роя.
-- Только добавление. Ничего существующего не трогаем.
-- ============================================================

-- ------------------------------------------------------------
-- 1) AGENTS — список агентов роя
--    Каждый агент: имя, цвет (для дашборда), свой ТГ-бот, статус.
-- ------------------------------------------------------------
create table if not exists public.agents (
  id          uuid primary key default gen_random_uuid(),
  name        text not null unique,                 -- имя агента (NOVA, ORION, ...)
  color       text not null default '#888888',      -- цвет точки на дашборде (hex)
  tg_bot      text,                                 -- @username телеграм-бота агента
  role        text,                                 -- чем занимается (описание роли)
  status      text not null default 'idle'          -- idle | working | offline
              check (status in ('idle','working','offline')),
  last_seen   timestamptz,                          -- когда агент последний раз был активен
  created_at  timestamptz not null default now()
);

comment on table public.agents is 'Агенты роя gbrain: имя, цвет, ТГ-бот, статус';

-- ------------------------------------------------------------
-- 2) TASKS — доска задач (своя «Jira»)
--    Что сделать, кто делает, в каком статусе.
-- ------------------------------------------------------------
create table if not exists public.tasks (
  id            uuid primary key default gen_random_uuid(),
  title         text not null,                      -- короткое название задачи
  description   text,                               -- подробности
  status        text not null default 'todo'        -- todo | in_progress | done | blocked
                check (status in ('todo','in_progress','done','blocked')),
  priority      int  not null default 3,            -- 1 (срочно) .. 5 (потом)
  assignee_id   uuid references public.agents(id) on delete set null,  -- кто делает
  created_by    uuid references public.agents(id) on delete set null,  -- кто поставил
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

comment on table public.tasks is 'Доска задач роя (Jira): задача, исполнитель, статус';

create index if not exists tasks_status_idx   on public.tasks(status);
create index if not exists tasks_assignee_idx on public.tasks(assignee_id);

-- ------------------------------------------------------------
-- 3) MESSAGES — мессенджер между агентами
--    Кто кому написал, по какой задаче.
-- ------------------------------------------------------------
create table if not exists public.messages (
  id          uuid primary key default gen_random_uuid(),
  from_id     uuid references public.agents(id) on delete set null,  -- кто написал
  to_id       uuid references public.agents(id) on delete set null,  -- кому (null = всем)
  task_id     uuid references public.tasks(id)  on delete set null,  -- по какой задаче
  body        text not null,                                         -- текст сообщения
  read_at     timestamptz,                                           -- когда прочитано
  created_at  timestamptz not null default now()
);

comment on table public.messages is 'Мессенджер: сообщения агент→агент по задачам';

create index if not exists messages_to_idx   on public.messages(to_id);
create index if not exists messages_task_idx on public.messages(task_id);

-- ------------------------------------------------------------
-- 4) MEMORY — общая память роя (вместо Obsidian)
--    Заметки/факты; у каждого свой владелец и цвет на дашборде.
-- ------------------------------------------------------------
create table if not exists public.memory (
  id          uuid primary key default gen_random_uuid(),
  agent_id    uuid references public.agents(id) on delete set null,  -- чей кусочек памяти
  kind        text not null default 'note',         -- note | fact | idea | reference
  title       text,                                 -- короткий заголовок
  content     text not null,                        -- сам текст памяти
  tags        text[] default '{}',                  -- метки для поиска
  created_at  timestamptz not null default now()
);

comment on table public.memory is 'Общая память роя: заметки/факты агентов (свой Obsidian)';

create index if not exists memory_agent_idx on public.memory(agent_id);
create index if not exists memory_kind_idx  on public.memory(kind);

-- ------------------------------------------------------------
-- Авто-обновление tasks.updated_at при любом изменении строки
-- ------------------------------------------------------------
create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists tasks_set_updated_at on public.tasks;
create trigger tasks_set_updated_at
  before update on public.tasks
  for each row execute function public.set_updated_at();
