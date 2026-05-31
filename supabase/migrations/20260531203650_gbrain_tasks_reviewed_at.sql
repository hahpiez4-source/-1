-- ============================================================
-- gbrain — отметка о рецензии: tasks.reviewed_at.
--
-- Критик-ревьюер просматривает выполненные (done) задачи и пишет отзыв.
-- Чтобы не рецензировать одно и то же дважды, ставим время рецензии.
-- NULL = ещё не рецензировалась.
-- ============================================================

alter table public.tasks
  add column if not exists reviewed_at timestamptz;

comment on column public.tasks.reviewed_at is
  'Когда Критик отрецензировал результат задачи (NULL = ещё не рецензировалась)';

-- быстро находить готовые, но ещё не отрецензированные задачи
create index if not exists tasks_reviewed_idx
  on public.tasks(reviewed_at)
  where reviewed_at is null;
