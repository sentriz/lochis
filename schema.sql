-- 2026.03.13 init --
create table history (
    id integer primary key,
    time datetime not null,
    speed real not null default 0,
    altitude real not null default 0,
    latitude real not null default 0,
    longitude real not null default 0
);

create index history_time on history (time);

create index history_lat_lng on history (latitude, longitude, altitude);

-- 2026.03.30 add tags --
create table tags (
    id integer primary key,
    name text not null default "",
    colour text not null default ""
);

create unique index tags_name on tags (name);

alter table history
    add column tag_id integer default null references tags (id) on delete set null;
