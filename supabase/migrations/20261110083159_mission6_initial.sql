begin;
create table public.workspaces (
 id uuid primary key default gen_random_uuid(), kind text not null check(kind in ('guest','user')),
 upstream_user_id text unique, created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
alter table public.workspaces enable row level security;
revoke all on public.workspaces from anon, authenticated;
grant all on public.workspaces to service_role;
create table public.app_sessions (
 id uuid primary key default gen_random_uuid(), token_hash text not null unique check(token_hash ~ '^[a-f0-9]{64}$'),
 workspace_id uuid not null references public.workspaces(id) on delete cascade,
 expires_at timestamptz not null, last_seen_at timestamptz not null default now()
);
create index app_sessions_workspace_idx on public.app_sessions(workspace_id);
create index app_sessions_expiry_idx on public.app_sessions(expires_at);
alter table public.app_sessions enable row level security;
revoke all on public.app_sessions from anon, authenticated;
grant all on public.app_sessions to service_role;

create function public.drt_touch_record() returns trigger language plpgsql security invoker set search_path = '' as $$
begin new.version := old.version + 1; new.updated_at := now(); return new; end;
$$;
revoke all on function public.drt_touch_record() from public, anon, authenticated;
grant execute on function public.drt_touch_record() to service_role;

do $$
declare tab text;
begin
 foreach tab in array array['scrap_folders','scraps','drafts','editor_sessions','personas','comment_templates','accounts','assets','insight_snapshots','affiliate_items','affiliate_links','publish_jobs','revenue_entries','generation_jobs','sync_events','api_cache','extension_keys'] loop
  execute format('create table public.%I (
   id uuid primary key default gen_random_uuid(), workspace_id uuid not null references public.workspaces(id) on delete cascade,
   title text not null default '''' check(char_length(title)<=200), content text not null default '''' check(char_length(content)<=50000),
   source_url text not null default '''' check(char_length(source_url)<=8192), folder_id uuid,
   assets jsonb not null default ''[]''::jsonb check(jsonb_typeof(assets)=''array'' and jsonb_array_length(assets)<=9),
   metadata jsonb not null default ''{}''::jsonb check(jsonb_typeof(metadata)=''object''),
   upstream_id text, status text not null default ''active'', version integer not null default 1 check(version>=1),
   created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
   unique(workspace_id,id), unique(workspace_id,upstream_id))',tab);
  execute format('alter table public.%I enable row level security',tab);
  execute format('revoke all on public.%I from anon, authenticated',tab);
  execute format('grant all on public.%I to service_role',tab);
  execute format('create index %I on public.%I(workspace_id,updated_at desc,id)',tab||'_workspace_updated_idx',tab);
  execute format('create index %I on public.%I(workspace_id,folder_id)',tab||'_workspace_folder_idx',tab);
  execute format('create trigger drt_touch before update on public.%I for each row execute function public.drt_touch_record()',tab);
 end loop;
 foreach tab in array array['scrap_folders','scraps','drafts','editor_sessions','personas','comment_templates','accounts','assets','insight_snapshots','affiliate_items','affiliate_links','publish_jobs','revenue_entries','generation_jobs','sync_events','api_cache','extension_keys'] loop
  execute format('alter table public.%I add constraint %I foreign key(workspace_id,folder_id) references public.scrap_folders(workspace_id,id) on delete set null(folder_id)',tab,tab||'_owned_folder_fk');
 end loop;
end $$;

create function public.drt_list_records(p_table text,p_workspace uuid,p_page integer default 1,p_limit integer default 15,
 p_search text default '',p_sort text default 'updated_desc',p_folder uuid default null,p_filter_folder boolean default false,p_upstream text default null)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare ordering text; result jsonb; total bigint;
begin
 if p_table <> all(array['scrap_folders','scraps','drafts','editor_sessions','personas','comment_templates','accounts','assets','insight_snapshots','affiliate_items','affiliate_links','publish_jobs','revenue_entries','generation_jobs','sync_events','api_cache','extension_keys']) then raise exception 'Invalid table' using errcode='22023'; end if;
 if p_page<1 or p_page>100000 or p_limit<1 or p_limit>100 or char_length(p_search)>500 then raise exception 'Invalid pagination' using errcode='22023'; end if;
 ordering := case p_sort when 'created_asc' then 'created_at asc,id asc' when 'created_desc' then 'created_at desc,id desc' when 'title_asc' then 'title asc,id asc' when 'updated_desc' then 'updated_at desc,id desc' else null end;
 if ordering is null then raise exception 'Invalid sort' using errcode='22023'; end if;
 execute format('select count(*) from public.%I where workspace_id=$1 and ($2='''' or position(lower($2) in lower(title||'' ''||content))>0) and (not $3 or folder_id is not distinct from $4) and ($5 is null or upstream_id=$5)',p_table)
 into total using p_workspace,p_search,p_filter_folder,p_folder,p_upstream;
 execute format('select coalesce(jsonb_agg(to_jsonb(rows)),''[]''::jsonb) from (select * from public.%I where workspace_id=$1 and ($2='''' or position(lower($2) in lower(title||'' ''||content))>0) and (not $3 or folder_id is not distinct from $4) and ($5 is null or upstream_id=$5) order by %s limit $6 offset $7) rows',p_table,ordering)
 into result using p_workspace,p_search,p_filter_folder,p_folder,p_upstream,p_limit,(p_page-1)*p_limit;
 return jsonb_build_object('data',result,'total',total,'page',p_page,'limit',p_limit);
end $$;
revoke all on function public.drt_list_records(text,uuid,integer,integer,text,text,uuid,boolean,text) from public,anon,authenticated;
grant execute on function public.drt_list_records(text,uuid,integer,integer,text,text,uuid,boolean,text) to service_role;

create function public.drt_asset_references(p_workspace uuid,p_asset uuid) returns bigint
language plpgsql security invoker set search_path = '' as $$
declare tab text; amount bigint; total bigint:=0;
begin
 foreach tab in array array['scrap_folders','scraps','drafts','editor_sessions','personas','comment_templates','accounts','insight_snapshots','affiliate_items','affiliate_links','publish_jobs','revenue_entries','generation_jobs','sync_events','api_cache','extension_keys'] loop
  execute format('select count(*) from public.%I where workspace_id=$1 and assets @> jsonb_build_array(jsonb_build_object(''id'',$2::text))',tab) into amount using p_workspace,p_asset;
  total:=total+amount;
 end loop;return total;
end $$;
revoke all on function public.drt_asset_references(uuid,uuid) from public,anon,authenticated;
grant execute on function public.drt_asset_references(uuid,uuid) to service_role;

insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
values('drt-assets','drt-assets',false,52428800,array['image/png','image/jpeg','image/webp','image/gif','video/mp4','video/webm','video/quicktime']);
notify pgrst, 'reload schema';
commit;
