-- 2025.01.28 init --
create table history (
    id integer primary key autoincrement,
    speed real not null default 0,
    altitude real not null default 0,
    latitude real not null default 0,
    longitude real not null default 0
);
-- 2026.03.13 add time --
alter table history add column time datetime not null default '';
