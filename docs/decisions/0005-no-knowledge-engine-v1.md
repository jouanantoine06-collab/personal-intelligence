# ADR-0005 — Pas de Knowledge Engine en V1

## Statut
Accepté (figé).

## Contexte
Distinction envisagée entre Mémoire (faits sur l'utilisateur) et Connaissance (documentation, PDF, contenu du monde). La distinction est jugée conceptuellement valide mais aucun cas d'usage V0.1 ne la requiert.

## Décision
Aucun composant Knowledge Engine n'est construit ni même schématisé en détail pour la V1. C'est un point d'extension documenté, pas une brique. Il ne sera introduit que lorsqu'un cas d'usage réel (fichiers V0.3, vision/documents V0.4) l'exigera.

## Conséquences
Simplicité immédiate. Discipline requise : le Memory Engine ne doit jamais absorber de contenu documentaire générique en attendant — son périmètre reste strictement personnel.
