-- ============================================================
-- gbrain — храним ИТОГ рецензии Критика прямо в задаче.
-- Зачем: по одному rework_count нельзя отличить «доработали и реально
-- приняли» от «приняли, потому что исчерпан лимит доработок» (а это плохо).
-- Теперь Критик при финальной рецензии проставляет:
--   review_verdict — его НАСТОЯЩИЙ последний вердикт ('accept' | 'rework');
--                    если задача done+reviewed, а verdict='rework' — значит
--                    приняли по лимиту (сигнал низкого качества);
--   review_score   — оценка результата 1..10 (непрерывная метрика качества).
-- Только добавление колонок. Существующее не трогаем (старые строки = null).
-- ============================================================

alter table public.tasks
  add column if not exists review_verdict text
    check (review_verdict in ('accept', 'rework')),
  add column if not exists review_score int
    check (review_score between 1 and 10);

comment on column public.tasks.review_verdict is
  'Последний вердикт Критика: accept | rework. done+reviewed при rework = принято по лимиту';
comment on column public.tasks.review_score is
  'Оценка результата Критиком, 1..10 (метрика качества роя)';

-- индекс для отчёта по качеству (метрики читают только отрецензированные)
create index if not exists tasks_reviewed_verdict_idx
  on public.tasks (review_verdict)
  where reviewed_at is not null;
