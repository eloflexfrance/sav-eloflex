// scripts/init-db.js
require('dotenv').config();
const { pool } = require('../server/db');

async function initDB() {
  console.log('⏳ Connexion à PostgreSQL...');
  console.log('   DATABASE_URL définie :', !!process.env.DATABASE_URL);

  const client = await pool.connect();
  try {
    console.log('✅ Connecté à PostgreSQL');

    await client.query(`
      CREATE TABLE IF NOT EXISTS clients (
        id SERIAL PRIMARY KEY,
        nom TEXT NOT NULL, contact TEXT, email TEXT, tel TEXT, ville TEXT,
        type TEXT DEFAULT 'Distributeur',
        token_portail TEXT UNIQUE, vf_id BIGINT UNIQUE, vf_ignore BOOLEAN DEFAULT FALSE,
        created_at TIMESTAMPTZ DEFAULT NOW(), updated_at TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS fauteuils (
        id SERIAL PRIMARY KEY,
        client_id INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
        modele TEXT NOT NULL, serie TEXT NOT NULL UNIQUE, annee INTEGER,
        couleur TEXT, duree_garantie_mois INTEGER DEFAULT 24,
        date_achat TEXT, num_facture TEXT, vf_facture_id BIGINT, notes TEXT,
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
        retour_transporteur TEXT, retour_numero TEXT, retour_date TEXT, num_sav TEXT,
        num_bordereau_vf TEXT,
        relance_envoyee BOOLEAN DEFAULT FALSE,
        created_at TIMESTAMPTZ DEFAULT NOW(), updated_at TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS intervention_produits (
        id SERIAL PRIMARY KEY,
        intervention_id INTEGER NOT NULL REFERENCES interventions(id) ON DELETE CASCADE,
        ref TEXT, designation TEXT NOT NULL,
        qte INTEGER NOT NULL DEFAULT 1, pxht NUMERIC NOT NULL DEFAULT 0,
        vf_product_id BIGINT
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
        stock INTEGER DEFAULT 0, stock_alerte INTEGER DEFAULT 2, stock_actif BOOLEAN DEFAULT TRUE,
        vf_product_id BIGINT UNIQUE,
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
        lue BOOLEAN DEFAULT FALSE, created_at TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS parametres (
        cle TEXT PRIMARY KEY, valeur TEXT
      );
    `);
    // Migration BIGINT (idempotente)
    try {
      await client.query(`ALTER TABLE catalogue ALTER COLUMN vf_product_id TYPE BIGINT`);
      await client.query(`ALTER TABLE clients ALTER COLUMN vf_id TYPE BIGINT`);
      await client.query(`ALTER TABLE fauteuils ALTER COLUMN vf_facture_id TYPE BIGINT`);
      await client.query(`ALTER TABLE intervention_produits ALTER COLUMN vf_product_id TYPE BIGINT`);
      await client.query(`ALTER TABLE catalogue ADD COLUMN IF NOT EXISTS stock_actif BOOLEAN DEFAULT TRUE`);
      await client.query(`ALTER TABLE clients ADD COLUMN IF NOT EXISTS vf_ignore BOOLEAN DEFAULT FALSE`);
      await client.query(`ALTER TABLE clients ADD COLUMN IF NOT EXISTS edi BOOLEAN DEFAULT FALSE`);
      await client.query(`ALTER TABLE interventions ADD COLUMN IF NOT EXISTS num_bordereau_vf TEXT`);
      await client.query(`ALTER TABLE interventions ADD COLUMN IF NOT EXISTS num_sav TEXT`);
      await client.query(`ALTER TABLE interventions ADD COLUMN IF NOT EXISTS num_facture TEXT`);
      // Nettoyer les date_achat mal formées (pas au format YYYY-MM-DD)
      await client.query(`UPDATE fauteuils SET date_achat = NULL WHERE date_achat IS NOT NULL AND date_achat !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'`);
      // Nettoyer les dates aberrantes (avant 2010 = numéro BDC mal interprété)
      await client.query(`UPDATE fauteuils SET date_achat = NULL WHERE date_achat IS NOT NULL AND date_achat ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' AND EXTRACT(YEAR FROM date_achat::date) < 2010`);
      // Nettoyer les envoi_date mal formées
      await client.query(`UPDATE interventions SET envoi_date = NULL WHERE envoi_date IS NOT NULL AND envoi_date !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'`);
    } catch(e) { /* déjà en BIGINT */ }

    // Table retours pièces vers Suède
    await client.query(`CREATE TABLE IF NOT EXISTS retours_suede (
      id SERIAL PRIMARY KEY,
      num_retour TEXT,
      date_envoi TEXT,
      description TEXT,
      statut TEXT DEFAULT 'En attente',
      montant NUMERIC DEFAULT 0,
      notes TEXT,
      interventions_ids INTEGER[],
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )`);

    // Table transferts de fauteuils (modèles d'exposition) entre distributeurs
    await client.query(`CREATE TABLE IF NOT EXISTS transferts_fauteuils (
      id SERIAL PRIMARY KEY,
      fauteuil_id INTEGER REFERENCES fauteuils(id) ON DELETE SET NULL,
      client_depart_id INTEGER REFERENCES clients(id) ON DELETE SET NULL,
      client_arrivee_id INTEGER REFERENCES clients(id) ON DELETE SET NULL,
      date_depart TEXT,
      date_arrivee TEXT,
      transporteur TEXT,
      num_suivi TEXT,
      statut TEXT DEFAULT 'En préparation',
      notes TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )`);

    // Table commandes (suivi distributeurs, import historique Excel + VosFactures)
    await client.query(`CREATE TABLE IF NOT EXISTS commandes (
      id SERIAL PRIMARY KEY,
      client_id INTEGER REFERENCES clients(id) ON DELETE SET NULL,
      fauteuil_id INTEGER REFERENCES fauteuils(id) ON DELETE SET NULL,
      annee_onglet INTEGER,
      groupe TEXT,
      distributeur_nom TEXT NOT NULL,
      modele TEXT,
      quantite INTEGER DEFAULT 1,
      accessoire TEXT,
      bdc TEXT,
      date_commande TEXT,
      vf_order_id TEXT,
      client_final TEXT,
      num_suivi TEXT,
      transporteur TEXT,
      date_livraison TEXT,
      num_serie TEXT,
      num_facture TEXT,
      vf_invoice_id BIGINT,
      invoice_se TEXT,
      informations TEXT,
      statut TEXT DEFAULT 'Auto',
      num_bordereau TEXT,
      reliquat BOOLEAN DEFAULT FALSE,
      reliquat_description TEXT,
      modele_demo BOOLEAN DEFAULT FALSE,
      preuve_livraison_filename TEXT,
      preuve_livraison_url TEXT,
      preuve_livraison_mime TEXT,
      preuve_livraison_taille INTEGER,
      preuve_livraison_storage TEXT,
      preuve_livraison_uploaded_at TIMESTAMPTZ,
      import_key TEXT UNIQUE,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_commandes_client ON commandes(client_id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_commandes_distrib ON commandes(distributeur_nom)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_commandes_bdc ON commandes(bdc)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_commandes_serie ON commandes(num_serie)`);
    try {
      await client.query(`ALTER TABLE commandes ADD COLUMN IF NOT EXISTS vf_commande_id BIGINT UNIQUE`);
      await client.query(`ALTER TABLE commandes ADD COLUMN IF NOT EXISTS quantite INTEGER DEFAULT 1`);
      await client.query(`ALTER TABLE commandes ADD COLUMN IF NOT EXISTS transporteur TEXT`);
      await client.query(`ALTER TABLE commandes ADD COLUMN IF NOT EXISTS num_bordereau TEXT`);
      await client.query(`ALTER TABLE commandes ADD COLUMN IF NOT EXISTS reliquat BOOLEAN DEFAULT FALSE`);
      await client.query(`ALTER TABLE commandes ADD COLUMN IF NOT EXISTS reliquat_description TEXT`);
      await client.query(`ALTER TABLE commandes ADD COLUMN IF NOT EXISTS modele_demo BOOLEAN DEFAULT FALSE`);
      await client.query(`ALTER TABLE commandes ADD COLUMN IF NOT EXISTS num_retour TEXT`);
      await client.query(`ALTER TABLE commandes ADD COLUMN IF NOT EXISTS num_commande_distrib TEXT`);
      await client.query(`ALTER TABLE commandes ADD COLUMN IF NOT EXISTS preuve_livraison_data TEXT`);
      await client.query(`ALTER TABLE commandes ADD COLUMN IF NOT EXISTS commande_type TEXT`);
      await client.query(`ALTER TABLE commandes ADD COLUMN IF NOT EXISTS type_fauteuil_neuf BOOLEAN DEFAULT FALSE`);
      await client.query(`ALTER TABLE commandes ADD COLUMN IF NOT EXISTS type_fauteuil_demo BOOLEAN DEFAULT FALSE`);
      await client.query(`ALTER TABLE commandes ADD COLUMN IF NOT EXISTS type_pieces BOOLEAN DEFAULT FALSE`);
      await client.query(`ALTER TABLE commandes ADD COLUMN IF NOT EXISTS confirmation_mode TEXT`);
      await client.query(`ALTER TABLE commandes ADD COLUMN IF NOT EXISTS num_avoir TEXT`);
      await client.query(`ALTER TABLE commandes ADD COLUMN IF NOT EXISTS vf_avoir_id BIGINT`);
      await client.query(`ALTER TABLE commandes ADD COLUMN IF NOT EXISTS num_facture_pennylane TEXT`);
      await client.query(`ALTER TABLE commandes ADD COLUMN IF NOT EXISTS pays TEXT DEFAULT 'France'`);
      await client.query(`ALTER TABLE commandes ADD COLUMN IF NOT EXISTS demo_origine_nom TEXT`);
      await client.query(`ALTER TABLE commandes ADD COLUMN IF NOT EXISTS demo_localisation_actuelle TEXT`);
      await client.query(`ALTER TABLE commandes ADD COLUMN IF NOT EXISTS tracking_statut TEXT`);
      await client.query(`ALTER TABLE commandes ADD COLUMN IF NOT EXISTS tracking_events JSONB DEFAULT '[]'`);
      await client.query(`ALTER TABLE commandes ADD COLUMN IF NOT EXISTS tracking_derniere_verif TIMESTAMPTZ`);
      await client.query(`ALTER TABLE commandes ADD COLUMN IF NOT EXISTS tracking_transporter TEXT`);
      await client.query(`ALTER TABLE commandes ADD COLUMN IF NOT EXISTS facture_paiement_statut TEXT`);
      await client.query(`ALTER TABLE commandes ADD COLUMN IF NOT EXISTS facture_date_echeance TEXT`);
      await client.query(`ALTER TABLE commandes ADD COLUMN IF NOT EXISTS facture_vf_id BIGINT`);
      await client.query(`ALTER TABLE commandes ADD COLUMN IF NOT EXISTS client_final_type TEXT`);
      await client.query(`ALTER TABLE clients ADD COLUMN IF NOT EXISTS lat NUMERIC(10,7)`);
      await client.query(`ALTER TABLE clients ADD COLUMN IF NOT EXISTS lng NUMERIC(10,7)`);
      await client.query(`ALTER TABLE clients ADD COLUMN IF NOT EXISTS geocoded_at TIMESTAMPTZ`);
      await client.query(`CREATE TABLE IF NOT EXISTS distributeurs_carte (
        id SERIAL PRIMARY KEY,
        reseau TEXT NOT NULL,
        nom TEXT NOT NULL,
        description TEXT,
        adresse TEXT, cp TEXT, ville TEXT, tel TEXT, email TEXT,
        lat NUMERIC(10,7) NOT NULL,
        lng NUMERIC(10,7) NOT NULL,
        note_interne TEXT,
        client_id INTEGER REFERENCES clients(id) ON DELETE SET NULL,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      )`);
      await client.query(`CREATE INDEX IF NOT EXISTS idx_dc_reseau ON distributeurs_carte(reseau)`);
      await client.query(`CREATE INDEX IF NOT EXISTS idx_dc_nom ON distributeurs_carte(nom)`);
      // Affichage d'un client sur la carte distributeurs
      await client.query(`ALTER TABLE clients ADD COLUMN IF NOT EXISTS sur_carte BOOLEAN DEFAULT FALSE`);
      await client.query(`ALTER TABLE clients ADD COLUMN IF NOT EXISTS reseau_carte TEXT`);
      // Adresse postale complète des clients / distributeurs
      await client.query(`ALTER TABLE clients ADD COLUMN IF NOT EXISTS adresse TEXT`);
      await client.query(`ALTER TABLE clients ADD COLUMN IF NOT EXISTS adresse2 TEXT`);
      await client.query(`ALTER TABLE clients ADD COLUMN IF NOT EXISTS cp TEXT`);
      await client.query(`ALTER TABLE clients ADD COLUMN IF NOT EXISTS pays TEXT`);
      await client.query(`CREATE INDEX IF NOT EXISTS idx_dc_client ON distributeurs_carte(client_id)`);
      await client.query(`ALTER TABLE commandes ADD COLUMN IF NOT EXISTS cf_nom TEXT`);
      await client.query(`ALTER TABLE commandes ADD COLUMN IF NOT EXISTS cf_prenom TEXT`);
      await client.query(`ALTER TABLE commandes ADD COLUMN IF NOT EXISTS cf_adresse TEXT`);
      await client.query(`ALTER TABLE commandes ADD COLUMN IF NOT EXISTS cf_cp TEXT`);
      await client.query(`ALTER TABLE commandes ADD COLUMN IF NOT EXISTS cf_ville TEXT`);
      await client.query(`ALTER TABLE commandes ADD COLUMN IF NOT EXISTS cf_tel TEXT`);
      await client.query(`ALTER TABLE commandes ADD COLUMN IF NOT EXISTS cf_email TEXT`);
      await client.query(`CREATE TABLE IF NOT EXISTS clients_finaux (
        id SERIAL PRIMARY KEY,
        type TEXT NOT NULL,
        nom TEXT, prenom TEXT, adresse TEXT, cp TEXT, ville TEXT, tel TEXT, email TEXT,
        nb_commandes INTEGER DEFAULT 1,
        derniere_commande TIMESTAMPTZ DEFAULT NOW(),
        created_at TIMESTAMPTZ DEFAULT NOW()
      )`);
      await client.query(`CREATE INDEX IF NOT EXISTS idx_cf_nom ON clients_finaux(nom)`);
      await client.query(`CREATE INDEX IF NOT EXISTS idx_cf_ville ON clients_finaux(ville)`);
      await client.query(`CREATE TABLE IF NOT EXISTS commande_notes (
        id SERIAL PRIMARY KEY,
        commande_id INTEGER REFERENCES commandes(id) ON DELETE CASCADE,
        user_id INTEGER,
        user_nom TEXT,
        texte TEXT NOT NULL,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )`);
      await client.query(`CREATE INDEX IF NOT EXISTS idx_notes_commande ON commande_notes(commande_id)`);
      await client.query(`CREATE INDEX IF NOT EXISTS idx_notes_created ON commande_notes(created_at DESC)`);

      // ── Devis VosFactures ──────────────────────────────────────────
      await client.query(`CREATE TABLE IF NOT EXISTS devis (
        id SERIAL PRIMARY KEY,
        vf_id BIGINT UNIQUE,
        numero TEXT,
        distributeur_nom TEXT,
        client_email TEXT,
        date_devis TEXT,
        date_expiration TEXT,
        montant NUMERIC(12,2),
        devise TEXT DEFAULT 'EUR',
        statut TEXT DEFAULT 'ouvert',
        vf_statut TEXT,
        lignes JSONB DEFAULT '[]',
        notes TEXT,
        nb_relances INTEGER DEFAULT 0,
        derniere_relance TIMESTAMPTZ,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      )`);
      await client.query(`CREATE TABLE IF NOT EXISTS devis_relances (
        id SERIAL PRIMARY KEY,
        devis_id INTEGER REFERENCES devis(id) ON DELETE CASCADE,
        date_envoi TIMESTAMPTZ DEFAULT NOW(),
        email_dest TEXT,
        statut TEXT DEFAULT 'envoyé',
        notes TEXT
      )`);
      await client.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS pays TEXT`);
      // pays NULL sur users = admin global (voit tous les pays)
      await client.query(`ALTER TABLE commandes ADD COLUMN IF NOT EXISTS ref_suede TEXT`);
      await client.query(`ALTER TABLE commandes ADD COLUMN IF NOT EXISTS date_envoi_suede TEXT`);
      await client.query(`ALTER TABLE commandes ADD COLUMN IF NOT EXISTS confirmation_recue BOOLEAN DEFAULT FALSE`);
      await client.query(`ALTER TABLE commandes ADD COLUMN IF NOT EXISTS date_confirmation TEXT`);
      await client.query(`ALTER TABLE commandes ADD COLUMN IF NOT EXISTS transporteur_retour TEXT`);
      await client.query(`ALTER TABLE commandes ADD COLUMN IF NOT EXISTS date_retour TEXT`);
      await client.query(`ALTER TABLE commandes ADD COLUMN IF NOT EXISTS preuve_livraison_filename TEXT`);
      await client.query(`ALTER TABLE commandes ADD COLUMN IF NOT EXISTS preuve_livraison_url TEXT`);
      await client.query(`ALTER TABLE commandes ADD COLUMN IF NOT EXISTS preuve_livraison_mime TEXT`);
      await client.query(`ALTER TABLE commandes ADD COLUMN IF NOT EXISTS preuve_livraison_taille INTEGER`);
      await client.query(`ALTER TABLE commandes ADD COLUMN IF NOT EXISTS preuve_livraison_storage TEXT`);
      await client.query(`ALTER TABLE commandes ADD COLUMN IF NOT EXISTS preuve_livraison_uploaded_at TIMESTAMPTZ`);
    } catch(e) { /* déjà présentes */ }

    // ── Utilisateurs et sessions ─────────────────────────────────
    await client.query(`CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      nom TEXT NOT NULL,
      email TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL CHECK (role IN ('admin','operateur','consultation','utilisateur')),
      permissions JSONB NOT NULL DEFAULT '{}',
      actif BOOLEAN DEFAULT TRUE,
      last_login TIMESTAMPTZ,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )`);
    try {
      await client.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS permissions JSONB NOT NULL DEFAULT '{}'`);
      await client.query(`ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check`);
      await client.query(`ALTER TABLE users ADD CONSTRAINT users_role_check CHECK (role IN ('admin','operateur','consultation','utilisateur'))`);
      await client.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS langue TEXT NOT NULL DEFAULT 'fr'`);
    } catch(e) { /* migration silencieuse */ }

    // Table de sessions PostgreSQL (connect-pg-simple)
    await client.query(`CREATE TABLE IF NOT EXISTS "user_sessions" (
      "sid" varchar NOT NULL COLLATE "default",
      "sess" json NOT NULL,
      "expire" timestamp(6) NOT NULL,
      CONSTRAINT "session_pkey" PRIMARY KEY ("sid") NOT DEFERRABLE INITIALLY IMMEDIATE
    )`);
    await client.query(`CREATE INDEX IF NOT EXISTS "IDX_session_expire" ON "user_sessions" ("expire")`);

    // Table des lignes de commande (désignation, référence, quantité — comme intervention_produits)
    await client.query(`CREATE TABLE IF NOT EXISTS commandes_lignes (
      id SERIAL PRIMARY KEY,
      commande_id INTEGER NOT NULL REFERENCES commandes(id) ON DELETE CASCADE,
      designation TEXT NOT NULL,
      reference TEXT,
      quantite INTEGER NOT NULL DEFAULT 1,
      ordre INTEGER DEFAULT 0
    )`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_commandes_lignes_cmd ON commandes_lignes(commande_id)`);

    await client.query(`CREATE TABLE IF NOT EXISTS commandes_retour_lignes (
      id SERIAL PRIMARY KEY,
      commande_id INTEGER NOT NULL REFERENCES commandes(id) ON DELETE CASCADE,
      designation TEXT NOT NULL,
      reference TEXT,
      quantite INTEGER NOT NULL DEFAULT 1,
      ordre INTEGER DEFAULT 0
    )`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_retour_lignes_cmd ON commandes_retour_lignes(commande_id)`);

    console.log("✅ Tables créées");

    // Paramètres par défaut
    for (const [cle, valeur] of [
      ['relance_jours','7'], ['stock_alerte_defaut','2'],
      ['mode_sombre','0'], ['nom_societe','Éloflex France'], ['portail_actif','1'],
      ['sync_vf_auto','1'],
      ['app_url',''],
      ['stock_gestion_active','1'],
      ['email_notifications','0'],
      ['email_smtp_host',''],
      ['email_smtp_port','587'],
      ['email_smtp_user',''],
      ['email_smtp_pass',''],
      ['email_from','']
    ]) {
      await client.query(
        'INSERT INTO parametres (cle,valeur) VALUES ($1,$2) ON CONFLICT (cle) DO NOTHING',
        [cle, valeur]
      );
    }

    // Données de démo uniquement si vide
    const { rows } = await client.query('SELECT COUNT(*)::int AS n FROM clients');
    if (rows[0].n === 0) {
      console.log('⏳ Insertion des données de démo...');
      const c1 = await client.query(
        "INSERT INTO clients (nom,contact,email,tel,ville,type,token_portail) VALUES ($1,$2,$3,$4,$5,$6,md5(random()::text)) RETURNING id",
        ['Orthopédic Sud','Marie Dupont','marie@orthosud.fr','04 91 23 45 67','Marseille','Distributeur']
      );
      const c2 = await client.query(
        "INSERT INTO clients (nom,contact,email,tel,ville,type,token_portail) VALUES ($1,$2,$3,$4,$5,$6,md5(random()::text)) RETURNING id",
        ['MobilAide Nord','Pierre Lambert','pierre@mobilaide.fr','03 20 98 76 54','Lille','Distributeur']
      );
      const c3 = await client.query(
        "INSERT INTO clients (nom,contact,email,tel,ville,type,token_portail) VALUES ($1,$2,$3,$4,$5,$6,md5(random()::text)) RETURNING id",
        ['HandiConfort','Sophie Martin','sophie@handi.fr','05 56 12 34 56','Bordeaux','Distributeur']
      );
      const id1 = c1.rows[0].id, id2 = c2.rows[0].id, id3 = c3.rows[0].id;
      await client.query("INSERT INTO fauteuils (client_id,modele,serie,annee,couleur,date_achat,num_facture,duree_garantie_mois) VALUES ($1,'Eloflex L','EL-2021-0042',2021,'Anthracite','2021-04-15','VF-2021-0089',24)",[id1]);
      await client.query("INSERT INTO fauteuils (client_id,modele,serie,annee,couleur,date_achat,num_facture,duree_garantie_mois) VALUES ($1,'Eloflex M+','EM-2023-0118',2023,'Noir','2023-09-02','VF-2023-0312',24)",[id1]);
      await client.query("INSERT INTO fauteuils (client_id,modele,serie,annee,couleur,date_achat,num_facture,duree_garantie_mois) VALUES ($1,'Eloflex L','EL-2022-0087',2022,'Gris','2022-06-20','VF-2022-0201',24)",[id2]);
      await client.query("INSERT INTO fauteuils (client_id,modele,serie,annee,couleur,date_achat,num_facture,duree_garantie_mois) VALUES ($1,'Eloflex S','ES-2024-0005',2024,'Bleu','2024-01-10','VF-2024-0014',24)",[id3]);
      for (const [ref,des,fou,reffou,px,stock,alerte] of [
        ['MOT-L-001','Moteur électrique gauche 24V','Eloflex AB','ELO-M24-G',245,3,2],
        ['MOT-D-001','Moteur électrique droit 24V','Eloflex AB','ELO-M24-D',245,3,2],
        ['BAT-25AH-01','Batterie Li-Ion 25Ah','Eloflex AB','ELO-BAT25',380,2,2],
        ['CHG-240V-01','Chargeur 24V 8A','Eloflex AB','ELO-CHG8A',67,5,3],
        ['KIT-REV-001','Kit révision complet','Eloflex AB','ELO-KIT-REV',89,10,3],
        ['VIS-M5-010','Kit visserie M5','Local','VIS-M5-10PK',8.5,20,5],
        ['JOY-V2-001','Joystick de remplacement V2','Eloflex AB','ELO-JOY-V2',130,4,2],
        ['ROU-FRN-01','Roue avant gauche+droite','Eloflex AB','ELO-ROA-KIT',55,8,3],
      ])
        await client.query(
          'INSERT INTO catalogue (ref,designation,fournisseur,ref_fournisseur,pxht,stock,stock_alerte) VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING',
          [ref,des,fou,reffou,px,stock,alerte]
        );
      console.log('✅ Données de démo insérées');
    } else {
      console.log('ℹ️  Base déjà peuplée, données de démo ignorées');
    }

  } finally {
    client.release();
  }
}

// Exécution directe via npm run init-db
if (require.main === module) {
  initDB()
    .then(() => { console.log('✅ Init terminée'); process.exit(0); })
    .catch(e => { console.error('❌ Erreur init-db :', e.message); console.error(e.stack); process.exit(1); });
}

module.exports = { initDB };
