# Système de mémoire — référence détaillée

Le Memory Engine est l'avantage concurrentiel principal du produit. Ce document détaille son modèle de données et son cycle de vie, en complément de `docs/architecture/system-architecture.md`.

## Types de mémoire (un seul schéma, discriminé par `type`)

`profil` (identité, préférences, style), `projet` (objectifs, décisions, statut), `relationnel` (contacts, lien avec l'utilisateur), `épisodique` (événements passés situés dans le temps), `temporaire` (contexte d'une tâche, expire en fin de session), `règles` (permissions, préférences de confidentialité).

## Décision assumée : une table unique, pas six

`memory_items` avec une colonne `structured_content` (JSONB) validée par un schéma par type. Justification : les champs transverses (provenance, confiance, expiration, sensibilité, statut) sont communs à tous les types, et les requêtes traversent souvent plusieurs types à la fois. Le compromis : le contenu spécifique au type n'est pas contraint au niveau base de données, seulement au niveau applicatif.

**Règle non négociable** : tout champ utilisé pour filtrer/trier/joindre (`project_id`, `related_person_ids`, `user_id`, `type`, `status`) est une vraie colonne indexée — jamais enfoui dans le JSONB.

## Champs

`id, user_id, type, content (résumé court, sert à l'affichage et à l'embedding), structured_content (jsonb), source (type: explicite|inféré|résultat_outil|importé + référence au tour d'origine), created_at, event_date, last_confirmed_at, confidence, importance, sensitivity, retention_policy, status (proposed|active|superseded|expired|deleted), supersedes_id, project_id, related_person_ids, embedding, deleted_at`.

## Cycle de vie

`proposed → active → superseded/expired → deleted`. Une correction ne modifie jamais une ligne existante : elle crée une nouvelle ligne avec `supersedes_id`, et l'ancienne bascule en `superseded`. Aucune écriture n'écrase silencieusement une donnée précédente.

## Moteur de décision d'écriture

1. Détection de candidat (explicite ou inféré).
2. Extraction structurée par appel modèle (modèle économique), validée par schéma Zod.
3. Classification déterministe (pas par le LLM) selon type × sensibilité × politique utilisateur → auto-stockage / proposition à l'utilisateur / jamais stocké.
4. Détection de conflit avec les souvenirs actifs existants avant écriture.
5. Commit + journalisation, avec référence au tour d'origine.

**Décision V0.1** : aucune catégorie n'est en auto-stockage. Tout candidat passe par confirmation explicite. Revu une fois la fiabilité de l'extraction mesurée sur des données réelles (voir `docs/decisions/0008-no-auto-store-memory-v01.md`).

## Récupération

Toujours inclus : mémoire de profil active, mémoire du projet actif (filtre structuré via `active_project_id` du Context Engine). Complété par une recherche hybride (embedding + pondération récence/importance/confiance) sur le reste, bornée en top-K. Exclusion stricte : mémoire expirée, supprimée, `temporaire` hors de sa session, ou sensible sans permission pour le device/contexte courant.

## Expiration

Différenciée par type : `temporaire` expire en fin de session ; `épisodique` décroît en importance sans reconfirmation ; `profil`/`règles` ne décroissent pas dans le temps mais peuvent déclencher une reconfirmation proactive si très anciens et à fort enjeu ; `projet` suit le cycle de vie du projet.

## Contrôle utilisateur

Consultation, filtrage par type/projet, édition (crée une nouvelle version, supersède l'ancienne), suppression (soft-delete — retirée de la récupération mais trace conservée dans l'audit, distincte d'une purge RGPD complète qui est une action séparée et plus lourde).
