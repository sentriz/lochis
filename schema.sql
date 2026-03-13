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

create virtual table history_rtree using rtree(
    id,
    min_lat, max_lat,
    min_lng, max_lng
);

create trigger history_rtree_insert after insert on history begin
    insert into history_rtree values (new.id, new.latitude, new.latitude, new.longitude, new.longitude);
end;
