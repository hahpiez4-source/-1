-- ============================================================
-- gbrain — УМНАЯ ПАМЯТЬ: полнотекстовый поиск по общей памяти роя.
--
-- Раньше агенты только ПИСАЛИ в память, но не читали её. Теперь они
-- смогут ПЕРЕД задачей искать похожий прошлый опыт и учитывать его —
-- рой становится умнее со временем.
--
-- Добавляем:
--   1) GIN-индекс по русскому полнотекстовому представлению (title+content)
--      — чтобы поиск был быстрым;
--   2) функцию search_memory(q, max_results) — ищет записи по смыслу слов
--      (русская морфология: «установка» найдёт «установить» и т.п.),
--      ранжирует по релевантности и свежести.
-- Только добавление, ничего существующего не трогаем.
-- ============================================================

-- 1) Индекс для быстрого полнотекстового поиска (русская конфигурация).
--    Объединяем заголовок и содержимое в один поисковый документ.
create index if not exists memory_fts_idx on public.memory
  using gin (
    to_tsvector('russian', coalesce(title, '') || ' ' || coalesce(content, ''))
  );

-- 2) Функция поиска. q — поисковый запрос (можно с операторами and/or, как в
--    обычном поисковике); max_results — сколько записей вернуть (1..20).
--    Возвращает совпавшие записи памяти + поле rank (чем выше — тем релевантнее).
create or replace function public.search_memory(q text, max_results int default 5)
returns table (
  id          uuid,
  agent_id    uuid,
  kind        text,
  title       text,
  content     text,
  tags        text[],
  created_at  timestamptz,
  rank        real
)
language sql
stable
set search_path = public, pg_temp
as $$
  select
    m.id, m.agent_id, m.kind, m.title, m.content, m.tags, m.created_at,
    ts_rank(
      to_tsvector('russian', coalesce(m.title, '') || ' ' || coalesce(m.content, '')),
      websearch_to_tsquery('russian', q)
    ) as rank
  from public.memory m
  where to_tsvector('russian', coalesce(m.title, '') || ' ' || coalesce(m.content, ''))
        @@ websearch_to_tsquery('russian', q)
    and length(coalesce(q, '')) > 0
  order by rank desc, m.created_at desc
  limit greatest(1, least(coalesce(max_results, 5), 20));
$$;

comment on function public.search_memory(text, int)
  is 'Полнотекстовый поиск по общей памяти роя (русская морфология), ранжир по релевантности+свежести';
