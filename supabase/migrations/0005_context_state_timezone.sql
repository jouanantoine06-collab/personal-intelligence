-- V1.3b — fuseau horaire IANA de l'utilisateur (jamais un simple offset
-- fixe), consulté par le Context Engine et injecté dans le prompt système
-- pour résoudre les expressions de date/heure relatives. Nullable : tant
-- qu'il n'est pas configuré, le modèle ne doit jamais deviner (voir
-- system-prompt.ts).
alter table context_state add column timezone text;
