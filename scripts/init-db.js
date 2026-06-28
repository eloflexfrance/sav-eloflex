// scripts/init-db.js — initialisation PostgreSQL
require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
});

async function init() {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS clients (
        id SERIAL PRIMARY KEY,
        nom TEXT NOT NULL,
        contact TEXT, email TEXT, tel TEXT, ville TEXT,
        type TEXT DEFAULT 'Distributeur',
        token_portail TEXT UNIQUE,
        vf_id INTEGER UNIQUE,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS fauteuils (
        id SERIAL PRIMARY KEY,
        client_id INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
        modele TEXT NOT NULL, serie TEXT NOT NULL UNIQUE, annee INTEGER,
        couleur TEXT, duree_garantie_mois INTEGER DEFAULT 24,
        date_achat TEXT, num_facture TEXT, vf_facture_id INTEGER, notes TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW(), updated_at TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS interventions (
        id SERIAL PRIMARY KEY,
        fauteuil_id INTEGER NOT NULL REFERENCES fauteuils(id) ON DELETE CASCADE,
        client_id INTEGER NOT NULL REFERENCES clients(id),
        date TEXT NOT NULL, type TEXT NOT NULL,
        garantie BOOLEAN NOT NULL DEFAULT FALSE,
        garantie_auto BOOLEAN DEFAULT FALSE,
        statut TEXT NOT NULL DEFAULT 'Ouvert',
        description TEXT, notes TEXT, technicien TEXT,
        envoi_transporteur TEXT, envoi_numero TEXT, envoi_date TEXT,
        retour_transporteur TEXT, retour_numero TEXT, retour_date TEXT,
        relance_envoyee BOOLEAN DEFAULT FALSE,
        created_at TIMESTAMPTZ DEFAULT NOW(), updated_at TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS intervention_produits (
        id SERIAL PRIMARY KEY,
        intervention_id INTEGER NOT NULL REFERENCES interventions(id) ON DELETE CASCADE,
        ref TEXT, designation TEXT NOT NULL,
        qte INTEGER NOT NULL DEFAULT 1,
        pxht NUMERIC NOT NULL DEFAULT 0,
        vf_product_id INTEGER
      );
      CREATE TABLE IF NOT EXISTS intervention_photos (
        id SERIAL PRIMARY KEY,
        intervention_id INTEGER NOT NULL REFERENCES interventions(id) ON DELETE CASCADE,
        filename TEXT NOT NULL, filename_thumb TEXT,
        legende TEXT, taille INTEGER, mime TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS intervention_commentaires (
        id SERIAL PRIMARY KEY,
        intervention_id INTEGER NOT NULL REFERENCES interventions(id) ON DELETE CASCADE,
        auteur TEXT NOT NULL, texte TEXT NOT NULL,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS intervention_historique (
        id SERIAL PRIMARY KEY,
        intervention_id INTEGER NOT NULL REFERENCES interventions(id) ON DELETE CASCADE,
        auteur TEXT NOT NULL, champ TEXT NOT NULL,
        ancienne_valeur TEXT, nouvelle_valeur TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS catalogue (
        id SERIAL PRIMARY KEY,
        ref TEXT NOT NULL UNIQUE, designation TEXT NOT NULL,
        fournisseur TEXT, ref_fournisseur TEXT,
        pxht NUMERIC NOT NULL DEFAULT 0,
        stock INTEGER DEFAULT 0, stock_alerte INTEGER DEFAULT 2,
        vf_product_id INTEGER UNIQUE,
        created_at TIMESTAMPTZ DEFAULT NOW(), updated_at TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS sync_log (
        id SERIAL PRIMARY KEY, type TEXT NOT NULL,
        status TEXT NOT NULL, message TEXT, records INTEGER DEFAULT 0,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS alertes (
        id SERIAL PRIMARY KEY, type TEXT NOT NULL,
        reference_id INTEGER, message TEXT NOT NULL,
        lue BOOLEAN DEFAULT FALSE,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS parametres (
        cle TEXT PRIMARY KEY, valeur TEXT
      );
    `);

    // Paramètres par défaut
    const defaults = [
      ['relance_jours','7'], ['stock_alerte_defaut','2'],
      ['mode_sombre','0'], ['email_notifications',''],
      ['nom_societe','Éloflex France'], ['portail_actif','1']
    ];
    for (const [cle, valeur] of defaults) {
      await client.query(
        'INSERT INTO parametres (cle,valeur) VALUES ($1,$2) ON CONFLICT (cle) DO NOTHING',
        [cle, valeur]
      );
    }

    // Données de démo
    const c1 = await client.query(
      "INSERT INTO clients (nom,contact,email,tel,ville,type,token_portail) VALUES ($1,$2,$3,$4,$5,$6,md5(random()::text)) ON CONFLICT DO NOTHING RETURNING id",
      ['Orthopédic Sud','Marie Dupont','marie@orthosud.fr','04 91 23 45 67','Marseille','Distributeur']
    );
    const c2 = await client.query(
      "INSERT INTO clients (nom,contact,email,tel,ville,type,token_portail) VALUES ($1,$2,$3,$4,$5,$6,md5(random()::text)) ON CONFLICT DO NOTHING RETURNING id",
      ['MobilAide Nord','Pierre Lambert','pierre@mobilaide.fr','03 20 98 76 54','Lille','Distributeur']
    );
    const c3 = await client.query(
      "INSERT INTO clients (nom,contact,email,tel,ville,type,token_portail) VALUES ($1,$2,$3,$4,$5,$6,md5(random()::text)) ON CONFLICT DO NOTHING RETURNING id",
      ['HandiConfort','Sophie Martin','sophie@handi.fr','05 56 12 34 56','Bordeaux','Distributeur']
    );

    const id1 = c1.rows[0]?.id, id2 = c2.rows[0]?.id, id3 = c3.rows[0]?.id;
    if (id1) {
      await client.query("INSERT INTO fauteuils (client_id,modele,serie,annee,couleur,date_achat,num_facture,duree_garantie_mois) VALUES ($1,'Eloflex L','EL-2021-0042',2021,'Anthracite','2021-04-15','VF-2021-0089',24) ON CONFLICT DO NOTHING",[id1]);
      await client.query("INSERT INTO fauteuils (client_id,modele,serie,annee,couleur,date_achat,num_facture,duree_garantie_mois) VALUES ($1,'Eloflex M+','EM-2023-0118',2023,'Noir','2023-09-02','VF-2023-0312',24) ON CONFLICT DO NOTHING",[id1]);
    }
    if (id2) await client.query("INSERT INTO fauteuils (client_id,modele,serie,annee,couleur,date_achat,num_facture,duree_garantie_mois) VALUES ($1,'Eloflex L','EL-2022-0087',2022,'Gris','2022-06-20','VF-2022-0201',24) ON CONFLICT DO NOTHING",[id2]);
    if (id3) await client.query("INSERT INTO fauteuils (client_id,modele,serie,annee,couleur,date_achat,num_facture,duree_garantie_mois) VALUES ($1,'Eloflex S','ES-2024-0005',2024,'Bleu','2024-01-10','VF-2024-0014',24) ON CONFLICT DO NOTHING",[id3]);

    const pieces = [
      ['MOT-L-001','Moteur électrique gauche 24V','Eloflex AB','ELO-M24-G',245,3,2],
      ['MOT-D-001','Moteur électrique droit 24V','Eloflex AB','ELO-M24-D',245,3,2],
      ['BAT-25AH-01','Batterie Li-Ion 25Ah','Eloflex AB','ELO-BAT25',380,2,2],
      ['CHG-240V-01','Chargeur 24V 8A','Eloflex AB','ELO-CHG8A',67,5,3],
      ['KIT-REV-001','Kit révision complet','Eloflex AB','ELO-KIT-REV',89,10,3],
      ['VIS-M5-010','Kit visserie M5','Local','VIS-M5-10PK',8.5,20,5],
      ['JOY-V2-001','Joystick de remplacement V2','Eloflex AB','ELO-JOY-V2',130,4,2],
      ['ROU-FRN-01','Roue avant gauche+droite','Eloflex AB','ELO-ROA-KIT',55,8,3],
    ];
    for (const [ref,des,fou,reffou,px,stock,alerte] of pieces) {
      await client.query(
        'INSERT INTO catalogue (ref,designation,fournisseur,ref_fournisseur,pxht,stock,stock_alerte) VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING',
        [ref,des,fou,reffou,px,stock,alerte]
      );
    }

    console.log('✅ Base de données PostgreSQL initialisée avec succès');
  } finally {
    client.release();
    await pool.end();
  }
}

init().catch(e => { console.error('❌ Erreur init-db :', e.message); process.exit(1); });
