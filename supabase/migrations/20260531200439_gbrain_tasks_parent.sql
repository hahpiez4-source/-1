-- ============================================================
-- gbrain — подзадачи: связь «подзадача → родительская цель».
--
-- Стратег/Планировщик берёт большую ЦЕЛЬ и раскладывает её на
-- несколько конкретных подзадач. Чтобы видеть, из какой цели
-- выросла подзадача, добавляем самоссылку parent_task_id.
--
-- Только добавление колонки. Существующие задачи не трогаем
-- (у них parent_task_id останется NULL = это «корневые» задачи).
-- ============================================================

alter table public.tasks
  add column if not exists parent_task_id uuid
    references public.tasks(id) on delete cascade;

comment on column public.tasks.parent_task_id is
  'Если задача — подзадача, здесь id её родительской цели (NULL = корневая задача)';

-- быстро находить подзадачи конкретной цели
create index if not exists tasks_parent_idx on public.tasks(parent_task_id);
