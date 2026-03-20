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
