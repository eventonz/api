-- 012: v2.search_athletes rewritten for speed (v2 schema only).
-- The SQL-function UNION ran all four branch scans on every call and the fuzzy
-- branch's word_similarity() >= 0.5 could not use the trigram index: ~300-400 ms
-- per search on a 27k-athlete event. Now plpgsql: one branch per call, every WHERE
-- index-usable (<% = word_similarity at the threshold set on the function).
-- Results and ranking verified identical on Run Melbourne / Swiss Epic / Youghal Bay.

CREATE OR REPLACE FUNCTION v2.search_athletes(q text, event_id_arg text, race_id_arg bigint DEFAULT NULL::bigint, limit_rows integer DEFAULT 20, offset_rows integer DEFAULT 0)
 RETURNS TABLE(id bigint, race_id bigint, race_name text, contest text, athlete_id text, raceno text, disraceno text, name text, first_name text, last_name text, info text, country text, category text, gender text, entry_type text, profile_image text, athlete_details jsonb, rank real, total_count bigint)
 LANGUAGE plpgsql
 STABLE
 SET pg_trgm.word_similarity_threshold = 0.5
AS $function$
DECLARE
  q_raw     text := btrim(q);
  q_lower   text := lower(btrim(q));
  is_bib    boolean := btrim(q) ~ '^[0-9]+(-[0-9]+)?$';
  is_two    boolean := btrim(q) ~ '^\S+\s+\S+$';
  p1        text := lower(split_part(btrim(q), ' ', 1));
  p2        text := lower(split_part(btrim(q), ' ', 2));
  ts_prefix tsquery;
BEGIN
  -- Only ONE branch runs per call (the old SQL-function UNION evaluated all
  -- four scans every time). Every branch's WHERE is index-usable: GIN on
  -- search_tsv, trigram GIN on search_text / lower(name), btree on raceno.
  SELECT to_tsquery('simple', string_agg(w || ':*', ' & '))
    INTO ts_prefix
    FROM regexp_split_to_table(q_lower, '\s+') w WHERE w <> '';

  IF q_raw = '' THEN
    -- 0. browse: numeric bib order
    RETURN QUERY
    SELECT a.id, a.race_id, r.name::text, a.contest::text, a.athlete_id, a.raceno, a.disraceno, a.name, a.first_name, a.last_name,
           a.info, a.country_name, a.category, a.gender, a.entry_type, a.profile_image, a.athlete_details,
           0::real, COUNT(*) OVER()
      FROM v2.athletes a JOIN v2.races r ON r.id = a.race_id
     WHERE r.event_id = event_id_arg AND (race_id_arg IS NULL OR a.race_id = race_id_arg)
     ORDER BY NULLIF(regexp_replace(a.raceno, '\D', '', 'g'), '')::bigint NULLS LAST, a.raceno, a.name
     LIMIT limit_rows OFFSET offset_rows;

  ELSIF is_bib THEN
    -- 1. bib: exact team bib, exact display/rider bib, then bib-prefix ("12" → 120…129)
    RETURN QUERY
    SELECT x.id, x.race_id, x.race_name, x.contest, x.athlete_id, x.raceno, x.disraceno, x.name, x.first_name, x.last_name,
           x.info, x.country, x.category, x.gender, x.entry_type, x.profile_image, x.athlete_details,
           x.rank, COUNT(*) OVER()
      FROM (
        SELECT a.id, a.race_id, r.name::text AS race_name, a.contest::text AS contest, a.athlete_id, a.raceno, a.disraceno, a.name, a.first_name, a.last_name,
               a.info, a.country_name AS country, a.category, a.gender, a.entry_type, a.profile_image, a.athlete_details,
               (CASE WHEN a.raceno = q_raw THEN 3
                     WHEN a.disraceno = q_raw
                       OR (a.entry_type <> 'Individual' AND v2.member_names(a.athlete_details) ~ ('(^|\s)' || q_raw || '(\s|$)')) THEN 2
                     ELSE 1 END)::real AS rank
          FROM v2.athletes a JOIN v2.races r ON r.id = a.race_id
         WHERE r.event_id = event_id_arg AND (race_id_arg IS NULL OR a.race_id = race_id_arg)
           AND (a.raceno = q_raw OR a.disraceno = q_raw OR a.raceno LIKE q_raw || '%'
                OR (a.entry_type <> 'Individual' AND v2.member_names(a.athlete_details) ~ ('(^|\s)' || q_raw || '(\s|$)')))
      ) x
     ORDER BY x.rank DESC, NULLIF(regexp_replace(x.raceno, '\D', '', 'g'), '')::bigint NULLS LAST, x.raceno, x.name
     LIMIT limit_rows OFFSET offset_rows;

  ELSIF is_two THEN
    -- 2. "first last": prefix words, trigram on the flattened text (rider names included)
    RETURN QUERY
    SELECT x.id, x.race_id, x.race_name, x.contest, x.athlete_id, x.raceno, x.disraceno, x.name, x.first_name, x.last_name,
           x.info, x.country, x.category, x.gender, x.entry_type, x.profile_image, x.athlete_details,
           x.rank, COUNT(*) OVER()
      FROM (
        SELECT a.id, a.race_id, r.name::text AS race_name, a.contest::text AS contest, a.athlete_id, a.raceno, a.disraceno, a.name, a.first_name, a.last_name,
               a.info, a.country_name AS country, a.category, a.gender, a.entry_type, a.profile_image, a.athlete_details,
               (2 * ts_rank_cd(a.search_tsv, ts_prefix)
                + similarity(a.search_text, q_lower)
                + (CASE WHEN a.search_text LIKE '%' || p1 || '%' AND a.search_text LIKE '%' || p2 || '%' THEN 1 ELSE 0 END))::real AS rank
          FROM v2.athletes a JOIN v2.races r ON r.id = a.race_id
         WHERE r.event_id = event_id_arg AND (race_id_arg IS NULL OR a.race_id = race_id_arg)
           AND (a.search_tsv @@ ts_prefix OR a.search_text % q_lower
                OR (a.search_text LIKE '%' || p1 || '%' AND a.search_text LIKE '%' || p2 || '%'))
      ) x
     ORDER BY x.rank DESC, NULLIF(regexp_replace(x.raceno, '\D', '', 'g'), '')::bigint NULLS LAST, x.raceno, x.name
     LIMIT limit_rows OFFSET offset_rows;

  ELSE
    -- 3. single token: word-prefix, substring anywhere, or typo-tolerant trigram.
    --    `<%` is word_similarity() >= threshold (0.5, set above) but index-aware.
    RETURN QUERY
    SELECT x.id, x.race_id, x.race_name, x.contest, x.athlete_id, x.raceno, x.disraceno, x.name, x.first_name, x.last_name,
           x.info, x.country, x.category, x.gender, x.entry_type, x.profile_image, x.athlete_details,
           x.rank, COUNT(*) OVER()
      FROM (
        SELECT a.id, a.race_id, r.name::text AS race_name, a.contest::text AS contest, a.athlete_id, a.raceno, a.disraceno, a.name, a.first_name, a.last_name,
               a.info, a.country_name AS country, a.category, a.gender, a.entry_type, a.profile_image, a.athlete_details,
               (ts_rank_cd(a.search_tsv, ts_prefix)
                + similarity(lower(a.name), q_lower)
                + word_similarity(q_lower, a.search_text)
                + (CASE WHEN a.search_text LIKE '%' || q_lower || '%' THEN 0.5 ELSE 0 END))::real AS rank
          FROM v2.athletes a JOIN v2.races r ON r.id = a.race_id
         WHERE r.event_id = event_id_arg AND (race_id_arg IS NULL OR a.race_id = race_id_arg)
           AND (a.search_tsv @@ ts_prefix OR a.search_text LIKE '%' || q_lower || '%'
                OR lower(a.name) % q_lower
                OR q_lower <% a.search_text)
      ) x
     ORDER BY x.rank DESC, NULLIF(regexp_replace(x.raceno, '\D', '', 'g'), '')::bigint NULLS LAST, x.raceno, x.name
     LIMIT limit_rows OFFSET offset_rows;
  END IF;
END
$function$;
