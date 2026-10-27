-- Platzierung der Topologie: ältere Plattformen hatten freie Positionen (Komponenten-ID -> x/y). Sie werden in die Ebenen übernommen;
-- neue Komponenten erscheinen künftig nie von selbst in der Topologie.
update platforms p
set layout = jsonb_build_object(
  'placed', coalesce((
    select jsonb_object_agg(t.layer, t.ids)
    from (
      select case e.kind when 'datacenter' then 'datacenter' when 'server' then 'server' when 'interconnect' then 'interconnect'
               when 'kubernetes' then 'orchestration' when 'llm' then 'inference' when 'ai_proxy' then 'gateway' when 'mcp' then 'mcp'
               when 'vector_db' then 'database' when 'observability' then 'observability' when 'iam' then 'iam' end as layer,
             jsonb_agg(e.id order by e.name) as ids
      from endpoints e
      where e.platform_id = p.id and e.kind <> 'gpu' and coalesce(p.layout, '{}'::jsonb) ? e.id::text
      group by 1
    ) t
    where t.layer is not null
  ), '{}'::jsonb),
  'collapsed', '{}'::jsonb)
where not (coalesce(layout, '{}'::jsonb) ? 'placed');
