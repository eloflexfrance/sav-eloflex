-- Migration : entité de facturation distincte du distributeur
-- À exécuter une seule fois sur la base PostgreSQL (ex: via la console Render,
-- psql, ou un script scripts/migrate-*.js si c'est ainsi que tu gères tes migrations).

ALTER TABLE clients ADD COLUMN IF NOT EXISTS entite_facturation_id INTEGER REFERENCES clients(id);

-- Explication :
-- Sur la fiche d'un distributeur, ce champ pointe (optionnellement) vers la fiche
-- d'une autre entité (déjà existante dans "clients") qui doit être facturée à sa
-- place — ex: le siège, la centrale d'achat, la holding du réseau.
-- NULL = comportement actuel inchangé (le distributeur est facturé directement).
