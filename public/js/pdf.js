// public/js/pdf.js — génération PDF via jsPDF (chargé en CDN)

const PDF = {
  fd(d) { if (!d) return '—'; const [y,m,day] = d.split('-'); return `${day}/${m}/${y}`; },

  intervention(inter) {
    const { jsPDF } = window.jspdf;
    const doc = new jsPDF();
    let y = 20;

    doc.setFontSize(15); doc.setFont('helvetica', 'bold');
    doc.text('FICHE INTERVENTION SAV — ELOFLEX', 105, y, { align: 'center' });
    y += 3; doc.setDrawColor(200,200,200); doc.setLineWidth(0.3); doc.line(15, y+4, 195, y+4); y += 10;
    doc.setFontSize(8); doc.setFont('helvetica', 'normal'); doc.setTextColor(120,120,120);
    doc.text('ELOFLEX — 41 rue des Maraichers — 17140 LAGORD', 105, y, { align: 'center' });
    doc.setTextColor(0,0,0); y += 8;

    doc.setFontSize(10);
    const info = [
      ['N° intervention', `${inter.num_sav || ('#' + inter.id)}`],
      ['Date', this.fd(inter.date)],
      ['Client', inter.client_nom || '—'],
      ['Modèle', inter.modele || '—'],
      ['N° de série', inter.serie || '—'],
      ["Date d'achat", this.fd(inter.date_achat)],
      ['N° facture VosFactures', inter.num_facture || '—'],
      ['Type', inter.type],
      ['Technicien', inter.technicien || '—'],
      ['Garantie', inter.garantie ? 'Sous garantie' : 'Hors garantie'],
      ['Statut', inter.statut],
    ];
    info.forEach(([k, v]) => {
      doc.setFont('helvetica', 'bold'); doc.text(k + ' :', 15, y);
      doc.setFont('helvetica', 'normal'); doc.text(String(v), 70, y);
      y += 6;
    });

    y += 4; doc.line(15, y, 195, y); y += 8;
    doc.setFont('helvetica', 'bold'); doc.text('Description :', 15, y); y += 6;
    doc.setFont('helvetica', 'normal');
    const dl = doc.splitTextToSize(inter.description || '—', 175);
    doc.text(dl, 15, y); y += dl.length * 6 + 4;

    if (inter.notes) {
      doc.setFont('helvetica', 'bold'); doc.text('Notes internes :', 15, y); y += 6;
      doc.setFont('helvetica', 'normal');
      const nl = doc.splitTextToSize(inter.notes, 175);
      doc.text(nl, 15, y); y += nl.length * 6 + 4;
    }

    if (inter.produits && inter.produits.length > 0) {
      doc.line(15, y, 195, y); y += 8;
      doc.setFont('helvetica', 'bold'); doc.text('PIÈCES UTILISÉES', 15, y); y += 8;
      doc.text('Désignation', 15, y); doc.text('Réf', 95, y); doc.text('Qté', 140, y); doc.text('PU HT', 155, y); doc.text('Total HT', 175, y);
      y += 4; doc.line(15, y, 195, y); y += 5;
      doc.setFont('helvetica', 'normal');
      let total = 0;
      inter.produits.forEach(p => {
        const t = parseFloat(p.pxht||0) * p.qte; total += t;
        const dl2 = doc.splitTextToSize(p.designation, 77);
        doc.text(dl2, 15, y); doc.text(p.ref || '', 95, y); doc.text(String(p.qte), 140, y);
        doc.text(parseFloat(p.pxht||0).toFixed(2) + ' €', 155, y); doc.text(t.toFixed(2) + ' €', 175, y);
        y += dl2.length * 5 + 2;
      });
      doc.line(15, y, 195, y); y += 5;
      doc.setFont('helvetica', 'bold');
      doc.text('TOTAL HT :', 155, y, { align: 'right' });
      doc.text(total.toFixed(2) + ' €', 195, y, { align: 'right' });
      y += 8;
    }

    if (inter.envoi_numero || inter.retour_numero) {
      doc.line(15, y, 195, y); y += 8;
      doc.setFont('helvetica', 'bold'); doc.text('EXPÉDITION', 15, y); y += 7;
      doc.setFont('helvetica', 'normal');
      if (inter.envoi_numero) {
        doc.text(`Envoi : ${inter.envoi_transporteur} — ${inter.envoi_numero} — ${this.fd(inter.envoi_date)}`, 15, y); y += 6;
      }
      if (inter.retour_numero) {
        doc.text(`Retour : ${inter.retour_transporteur} — ${inter.retour_numero} — ${this.fd(inter.retour_date)}`, 15, y); y += 6;
      }
    }

    doc.save(`intervention_${inter.num_sav || inter.id}_${inter.date}.pdf`);
  },

  fauteuil(f, interventions) {
    const { jsPDF } = window.jspdf;
    const doc = new jsPDF();
    let y = 20;
    doc.setFontSize(15); doc.setFont('helvetica', 'bold');
    doc.text('HISTORIQUE SAV — FAUTEUIL ELOFLEX', 105, y, { align: 'center' });
    y += 4; doc.setDrawColor(200,200,200); doc.line(15, y+3, 195, y+3); y += 11;
    doc.setFontSize(10);
    const info = [
      ['Distributeur', f.client_nom || '—'], ['Modèle', f.modele], ['N° de série', f.serie],
      ['Année', String(f.annee || '—')], ['Couleur', f.couleur || '—'],
      ["Date d'achat", this.fd(f.date_achat)], ['N° facture VosFactures', f.num_facture || '—'],
    ];
    info.forEach(([k, v]) => {
      doc.setFont('helvetica', 'bold'); doc.text(k + ' :', 15, y);
      doc.setFont('helvetica', 'normal'); doc.text(v, 65, y); y += 6;
    });
    y += 4; doc.line(15, y, 195, y); y += 8;
    doc.setFont('helvetica', 'bold'); doc.text(`INTERVENTIONS (${interventions.length})`, 15, y); y += 8;
    interventions.forEach(i => {
      if (y > 260) { doc.addPage(); y = 20; }
      doc.setFillColor(240, 240, 240); doc.rect(15, y - 4, 180, 8, 'F');
      doc.setFont('helvetica', 'bold');
      doc.text(`#${i.id} – ${this.fd(i.date)} – ${i.type} – ${i.garantie ? 'Garantie' : 'HG'} – ${i.statut}`, 17, y);
      y += 7; doc.setFont('helvetica', 'normal');
      const dl = doc.splitTextToSize(i.description || '', 175);
      doc.text(dl, 17, y); y += dl.length * 5 + 2;
      if (i.produits?.length) { doc.text('Pièces : ' + i.produits.map(p => `${p.designation} x${p.qte}`).join(', '), 17, y); y += 5; }
      if (i.envoi_numero) { doc.text(`Envoi : ${i.envoi_transporteur} ${i.envoi_numero}`, 17, y); y += 5; }
      if (i.retour_numero) { doc.text(`Retour : ${i.retour_transporteur} ${i.retour_numero}`, 17, y); y += 5; }
      y += 3;
    });
    doc.save(`fauteuil_${(f.serie || 'SAV').replace(/[^a-zA-Z0-9]/g, '_')}.pdf`);
  },

  client(cl, fauteuils, interventions) {
    const { jsPDF } = window.jspdf;
    const doc = new jsPDF();
    let y = 20;
    doc.setFontSize(15); doc.setFont('helvetica', 'bold');
    doc.text('DOSSIER CLIENT SAV — ELOFLEX', 105, y, { align: 'center' });
    y += 4; doc.setDrawColor(200,200,200); doc.line(15, y+3, 195, y+3); y += 11;
    doc.setFontSize(10);
    [['Nom', cl.nom], ['Contact', cl.contact||'—'], ['Email', cl.email||'—'], ['Téléphone', (window.fmtTel?window.fmtTel(cl.tel):cl.tel)||'—'], ['Ville', cl.ville||'—'], ['Type', cl.type||'—']].forEach(([k,v]) => {
      doc.setFont('helvetica', 'bold'); doc.text(k+' :', 15, y);
      doc.setFont('helvetica', 'normal'); doc.text(v, 55, y); y += 6;
    });
    const g = interventions.filter(i => i.garantie).length;
    y += 4; doc.line(15, y, 195, y); y += 8;
    doc.setFont('helvetica', 'bold');
    doc.text(`BILAN SAV : ${interventions.length} intervention(s) — ${g} garantie — ${interventions.length - g} hors garantie`, 15, y); y += 10;
    fauteuils.forEach(f => {
      if (y > 250) { doc.addPage(); y = 20; }
      doc.setFillColor(230, 230, 250); doc.rect(15, y-4, 180, 8, 'F');
      doc.setFont('helvetica', 'bold'); doc.text(`${f.modele} — Série : ${f.serie}`, 17, y); y += 7;
      doc.setFont('helvetica', 'normal');
      const meta = [`Année : ${f.annee||'—'}`, f.date_achat ? `Date d'achat : ${this.fd(f.date_achat)}` : '', f.num_facture ? `Facture VosFactures : ${f.num_facture}` : ''].filter(Boolean);
      meta.forEach(s => { doc.text(s, 17, y); y += 5; });
      const fi = interventions.filter(i => i.fauteuil_id === f.id);
      doc.text(`${fi.length} intervention(s) — ${fi.filter(i=>i.garantie).length} garantie`, 17, y); y += 9;
    });
    doc.save(`client_${(cl.nom||'client').replace(/[^a-zA-Z0-9]/g,'_')}.pdf`);
  },

  pretDoc(p) {
    const { jsPDF } = window.jspdf;
    const doc = new jsPDF();
    const L = 15, R = 195, W = R - L;
    const FORM = { essai_court:'Essai court (15 à 30 jours)', long_terme:'Prêt long terme (≥ 3 mois, renouvelable)' };
    let y = 18;
    doc.setFontSize(15); doc.setFont('helvetica','bold'); doc.setTextColor(31,92,140);
    doc.text('BON DE PRÊT — FAUTEUIL ROULANT ÉLECTRIQUE', 105, y, { align:'center' }); y += 5;
    doc.setFontSize(9); doc.setFont('helvetica','italic'); doc.setTextColor(110,110,110);
    doc.text('ELOFLEX SAS — Offre de prêt / essai (non valable sur les accessoires)', 105, y, { align:'center' });
    doc.setDrawColor(31,92,140); doc.setLineWidth(0.5); y += 3; doc.line(L, y, R, y); y += 8;
    doc.setTextColor(0,0,0);
    const band = (txt) => { doc.setFillColor(31,92,140); doc.rect(L, y-4, W, 6, 'F'); doc.setTextColor(255,255,255); doc.setFontSize(10); doc.setFont('helvetica','bold'); doc.text(txt, L+2, y); doc.setTextColor(0,0,0); y += 7; };
    const line2 = (label, val) => { doc.setFont('helvetica','bold'); doc.setFontSize(9); doc.text(label, L, y); doc.setFont('helvetica','normal'); doc.text(String(val||'—'), L+52, y); y += 5.5; };

    band('1 · PARTIES');
    doc.setFontSize(9); doc.setFont('helvetica','bold'); doc.text('Prêteur : ', L, y); doc.setFont('helvetica','normal'); doc.text('ELOFLEX SAS', L+22, y); y += 5.5;
    line2('Distributeur', p.distributeur_nom || p.client_nom_actuel || '—');
    line2('Adresse', p.adresse || '—');
    line2('Contact', [p.contact, (window.fmtTel?window.fmtTel(p.tel):p.tel), p.email].filter(Boolean).join(' — ') || '—');
    if (p.livraison_autre) line2('Livraison', [p.livraison_nom, p.livraison_adresse].filter(Boolean).join(' — ') || '—');
    y += 2;

    band('2 · FORMULE & DURÉE');
    line2('Formule', FORM[p.formule] || p.formule || '—');
    line2('Date de remise', this.fd((p.date_remise||'').slice(0,10)));
    line2('Retour prévu', this.fd((p.date_retour_prevue||'').slice(0,10)));
    if (p.prorogation_date) line2('Prorogation', this.fd((p.prorogation_date||'').slice(0,10)));
    y += 2;

    band('3 · MATÉRIEL PRÊTÉ');
    let arts = p.articles;
    if (typeof arts === 'string') { try { arts = JSON.parse(arts); } catch(e){ arts = null; } }
    if (!Array.isArray(arts) || !arts.length) arts = (p.designation||p.num_serie||p.valeur_ht!=null) ? [{designation:p.designation||'', reference:'', num_serie:p.num_serie||'', prix:p.valeur_ht}] : [];
    doc.setFontSize(8); doc.setFont('helvetica','bold');
    doc.text('Désignation', L, y); doc.text('Réf.', L+95, y); doc.text('N° série', L+120, y); doc.text('Prix HT', L+160, y); y += 4.5;
    doc.setFont('helvetica','normal'); let totArt = 0;
    arts.forEach(a => {
      const prix = parseFloat(a.prix)||0; totArt += prix;
      doc.text(doc.splitTextToSize(String(a.designation||''), 78)[0] || '', L, y);
      doc.text(String(a.reference||''), L+95, y);
      doc.text(String(a.num_serie||''), L+120, y);
      doc.text(a.prix!=null&&a.prix!==''?(prix.toFixed(2)+' €'):'', L+160, y);
      y += 4.5;
    });
    doc.setFont('helvetica','bold'); doc.text('Total HT : ' + totArt.toFixed(2) + ' €', L+120, y+1); doc.setFont('helvetica','normal'); y += 6;
    if (p.observations) { doc.setFont('helvetica','italic'); doc.setFontSize(8); doc.setTextColor(90,90,90);
      doc.text(doc.splitTextToSize('Observations : ' + p.observations, W), L, y); y += 5 + Math.min(20, doc.splitTextToSize(p.observations, W).length*4); doc.setTextColor(0,0,0); }
    y += 2;

    const ensure = (h) => { if (y + h > 285) { doc.addPage(); y = 18; } };

    ensure(60);
    band("4 · ENGAGEMENTS DE L'EMPRUNTEUR");
    doc.setFont('helvetica','italic'); doc.setFontSize(7.5); doc.setTextColor(90,90,90);
    doc.text("Le distributeur déclare avoir pris connaissance du Contrat-cadre de prêt ELOFLEX et en accepter sans réserve toutes les conditions. Il confirme notamment :", L, y); y += 5;
    doc.setFont('helvetica','normal'); doc.setFontSize(8); doc.setTextColor(45,45,45);
    const engs = [
      "Utiliser le matériel uniquement pour des essais patients supervisés par un ergothérapeute",
      "Conserver l'emballage et les mousses de protection",
      "Signaler immédiatement tout incident ou dommage à ELOFLEX",
      "Confirmer par e-mail le bon état du fauteuil avant retour",
      "Prendre en charge les frais de retour (50 € HT / fauteuil)",
      "Maintenir le matériel en état quasi-neuf (Prêt Long Terme)",
      "Assurer au moins 1 essai / mois (Prêt Long Terme)",
    ];
    engs.forEach((t) => { ensure(6); const lines = doc.splitTextToSize('•  ' + t, W - 2); doc.text(lines, L + 1, y); y += lines.length * 3.8; });
    y += 3; doc.setTextColor(0,0,0);

    ensure(34);
    band('5 · CONDITIONS FINANCIÈRES EN CAS DE DOMMAGE OU PERTE');
    doc.setFontSize(8);
    const cf = [
      ['Perte / destruction totale', "Prix catalogue HT - décote vétusté (5 %/mois, plafonnée à 30 %)"],
      ['Dommages partiels / reconditionnement', "Frais réels de remise en état (pièces + main-d'œuvre) sur devis ELOFLEX"],
      ['Emballage / mousses manquants', "40 € HT supplémentaires, soit 90 € HT au total des frais de retour"],
    ];
    cf.forEach((r) => { ensure(6); doc.setFont('helvetica','bold'); const lab = doc.splitTextToSize(r[0], 58); doc.text(lab, L, y); doc.setFont('helvetica','normal'); const val = doc.splitTextToSize(r[1], W - 62); doc.text(val, L + 62, y); y += Math.max(lab.length, val.length) * 3.8 + 1.5; });
    doc.setFont('helvetica','italic'); doc.setFontSize(7.5); doc.setTextColor(80,80,80);
    const opt = doc.splitTextToSize("Option d'achat : l'emprunteur peut proposer le rachat du matériel à tout moment. Prix fixé d'un commun accord, formalisé par une facture de vente distincte.", W);
    ensure(opt.length * 3.6 + 4); doc.text(opt, L, y); y += opt.length * 3.6 + 4;
    doc.setFont('helvetica','normal'); doc.setFontSize(9); doc.setTextColor(0,0,0);

    ensure(48);
    band('6 · SIGNATURES');
    const colW = W/2 - 3;
    const yTop = y;
    doc.setFontSize(9); doc.setFont('helvetica','bold'); doc.text('ELOFLEX SAS', L, y+4);
    var _eloNom = p.signataire_eloflex || (window.CURRENT_USER && window.CURRENT_USER.nom) || '';
    var _eloDate = p.eloflex_date ? this.fd((''+p.eloflex_date).slice(0,10)) : this.fd((new Date()).toISOString().slice(0,10));
    doc.setFont('helvetica','normal'); doc.setFontSize(9); doc.text('Nom : ' + _eloNom, L, y+11);
    doc.setFontSize(7.5); doc.setTextColor(90,90,90);
    doc.text('Signé électroniquement le ' + _eloDate, L, y+16);
    doc.setTextColor(0,0,0); doc.setFontSize(9);
    doc.setFont('helvetica','bold'); doc.text('Distributeur', L+colW+6, y+4);
    doc.setFont('helvetica','normal');
    if (p.signataire_nom) {
      doc.text('Signé par : ' + p.signataire_nom, L+colW+6, y+10);
      if (p.signed_at) doc.text('le ' + this.fd((''+p.signed_at).slice(0,10)), L+colW+6, y+15);
      if (p.signature_data) { try { doc.addImage(p.signature_data, 'PNG', L+colW+6, y+17, 55, 20); } catch(e){} }
    } else {
      doc.text('Nom : ______________________', L+colW+6, y+10);
      doc.setFontSize(7); doc.setTextColor(120,120,120);
      doc.text('« Lu et approuvé, bon pour accord »', L+colW+6, y+15); doc.setTextColor(0,0,0); doc.setFontSize(9);
    }
    doc.setDrawColor(200,200,200); doc.rect(L, yTop, colW, 40); doc.rect(L+colW+6, yTop, colW, 40);
    return doc;
  },
  pret(p) { this.pretDoc(p).save(`Bon_de_pret_${(p.distributeur_nom||'distributeur').replace(/[^a-zA-Z0-9]/g,'_')}.pdf`); },

  // ── Contrat-cadre de prêt à usage (commodat) ──
  contratCadreDoc(c) {
    c = c || {};
    const { jsPDF } = window.jspdf;
    const doc = new jsPDF();
    const L = 16, R = 194, W = R - L;
    let y = 18;
    const ensure = (h) => { if (y + h > 284) { doc.addPage(); y = 18; } };
    const h1 = (t) => { doc.setFont('helvetica','bold'); doc.setFontSize(13); doc.setTextColor(31,92,140); doc.text(t, 105, y, { align:'center' }); y += 6; doc.setTextColor(0,0,0); };
    const art = (t) => { ensure(9); doc.setFont('helvetica','bold'); doc.setFontSize(10); doc.setTextColor(31,92,140); doc.text(t, L, y); y += 5; doc.setTextColor(0,0,0); };
    const para = (t, opt) => {
      doc.setFont('helvetica', (opt&&opt.italic)?'italic':'normal'); doc.setFontSize((opt&&opt.size)||9);
      if (opt&&opt.color) doc.setTextColor.apply(doc, opt.color); else doc.setTextColor(35,35,35);
      const lines = doc.splitTextToSize(t, W);
      lines.forEach(ln => { ensure(5); doc.text(ln, L, y); y += 4.4; });
      doc.setTextColor(0,0,0); y += 1.5;
    };
    const bullet = (t) => {
      doc.setFont('helvetica','normal'); doc.setFontSize(9); doc.setTextColor(35,35,35);
      const lines = doc.splitTextToSize('•  ' + t, W - 2);
      lines.forEach((ln,i) => { ensure(5); doc.text(ln, L + (i?3:1), y); y += 4.2; });
      doc.setTextColor(0,0,0);
    };

    h1('CONTRAT-CADRE DE PRÊT À USAGE');
    doc.setFont('helvetica','italic'); doc.setFontSize(9); doc.setTextColor(110,110,110);
    doc.text('(Commodat – Articles 1875 à 1891 du Code civil)', 105, y, { align:'center' }); y += 4;
    doc.setDrawColor(31,92,140); doc.setLineWidth(0.5); doc.line(L, y, R, y); y += 7; doc.setTextColor(0,0,0);

    // Parties
    doc.setFont('helvetica','bold'); doc.setFontSize(9);
    doc.text('ENTRE LES SOUSSIGNÉS :', L, y); y += 5;
    para("ELOFLEX SAS, ci-après dénommée « ELOFLEX » ou « le Prêteur »" + (c.representant_eloflex ? ', représentée par ' + c.representant_eloflex : '') + '.');
    para("ET " + (c.distributeur_nom || c.client_nom_actuel || '……………………………') + ", distributeur, ci-après dénommé « l'Emprunteur »"
      + (c.siret_distrib ? ' (SIRET : ' + c.siret_distrib + ')' : '')
      + (c.representant_distrib ? ', représenté par ' + c.representant_distrib : '') + '.');
    para('Ci-après ensemble dénommées « les Parties », il a été convenu ce qui suit.');

    art('Article 1 – Objet et nature juridique du contrat');
    para("Le présent contrat-cadre a pour objet de permettre à l'Emprunteur de disposer de matériels de démonstration destinés à la réalisation des essais préalables des fauteuils roulants électriques auprès des patients, conformément à l'arrêté du 6 février 2025 modifié relatif à la prise en charge des VPH au titre de la liste des produits et prestations prévue à l'article L. 165-1 du Code de la sécurité sociale.");
    para("ELOFLEX met à disposition de l'Emprunteur, à titre gratuit et temporaire, un ou plusieurs fauteuils roulants électriques de marque Eloflex (« le matériel »), aux fins exclusives d'essai par des patients sous la supervision d'un ergothérapeute.");
    para("Ce prêt constitue un commodat au sens des articles 1875 et suivants du Code civil. ELOFLEX conserve la pleine propriété du matériel pendant toute la durée du prêt. Aucun transfert de propriété ne résulte de la remise du matériel. L'Emprunteur n'acquiert aucun droit de rétention sur celui-ci.");
    para("Chaque prêt individuel fait l'objet d'un Bon de Prêt signé par les deux parties, précisant le matériel concerné, sa formule de prêt et sa durée.");

    art('Article 2 – Formules de prêt');
    para("2.1 – Formule Essai Court (15 à 30 jours) : durée maximale de 30 jours calendaires à compter de la livraison, sauf accord écrit de prorogation d'ELOFLEX.", {italic:false});
    para("2.2 – Formule Prêt Long Terme (3 mois minimum, renouvelable) : réservée aux distributeurs partenaires sélectionnés par ELOFLEX ; soumise aux engagements supplémentaires de l'article 4.2.");

    art('Article 3 – Livraison et état du matériel');
    para("Le matériel est expédié par ELOFLEX à ses frais (sauf disposition contraire du Bon de Prêt). Un état des lieux contradictoire est formalisé par la signature du Bon de Prêt, qui vaut acceptation de l'état du matériel décrit. L'Emprunteur conserve l'emballage d'origine et l'intégralité des mousses de protection pendant toute la durée du prêt.");

    art("Article 4 – Obligations de l'Emprunteur");
    para('4.1 – Obligations communes aux deux formules :');
    [
      "Utiliser le matériel uniquement à des fins d'essai patient supervisé par un ergothérapeute (article 1).",
      "Maintenir le matériel en bon état de fonctionnement et de propreté.",
      "Ne pas prêter, sous-louer ou céder le matériel à un tiers autre qu'un patient dans le cadre d'un essai.",
      "Signaler sans délai à ELOFLEX tout incident, anomalie ou dommage affectant le matériel.",
      "Retourner le matériel dans son emballage d'origine avec les mousses de protection, en bon état général.",
      "Confirmer par e-mail à ELOFLEX le bon état du matériel avant tout retour.",
      "Retourner le matériel dans le délai prévu au Bon de Prêt.",
      "Participer aux frais de retour (transport) à hauteur de 50 € HT par fauteuil.",
      "Prendre en charge la main d'œuvre et les pièces nécessaires à la remise en bon état général avant chaque nouvel essai et avant tout retour.",
    ].forEach(bullet);
    para("L'Emprunteur demeure seul responsable des relations avec les patients bénéficiaires des essais et de l'exécution des obligations légales et réglementaires lui incombant à ce titre.");
    para('4.2 – Obligations spécifiques – Formule Prêt Long Terme :');
    [
      "Maintenir le matériel dans un état « quasi neuf », compatible avec un matériel de démonstration.",
      "Effectuer un minimum d'un (1) essai patient par mois en moyenne sur le modèle prêté ou tout autre modèle Eloflex.",
      "Informer ELOFLEX en cas d'indisponibilité prolongée du fauteuil et faciliter sa mise à disposition pour d'autres essais (expédition aux frais d'ELOFLEX).",
      "Communiquer à ELOFLEX un bilan trimestriel simplifié des essais réalisés (nombre, retours patients).",
    ].forEach(bullet);

    art('Article 5 – Responsabilité et garantie du matériel');
    para("L'Emprunteur est responsable du matériel dès sa réception et jusqu'à son retour effectif chez ELOFLEX (articles 1880 à 1884 du Code civil). En cas de perte, vol, destruction ou détérioration importante, et si le matériel n'est pas retourné dans les délais :");
    bullet("Perte ou destruction totale : prix catalogue public HT du matériel en vigueur à la date du sinistre.");
    bullet("Dommages partiels : frais réels de remise en état (pièces + main d'œuvre au tarif SAV ELOFLEX) sur devis préalable accepté ou facture. L'usure normale n'est pas facturée.");
    para("L'Emprunteur est invité à vérifier que sa police d'assurance RC professionnelle couvre les biens confiés à titre de prêt. ELOFLEX pourra demander une attestation d'assurance.");

    art("Article 6 – Frais de retour et d'emballage");
    para("Frais de retour (transport) : 50 € HT par fauteuil. Supplément si emballage / mousses manquants : soit 90 € HT au total si l'emballage complet est absent. Ces frais sont facturés séparément à l'issue du prêt et ne constituent pas une contrepartie du prêt.");

    art('Article 7 – Cession du matériel');
    para("L'Emprunteur peut, à tout moment, formuler une offre d'achat du matériel prêté. Cette offre n'engage pas ELOFLEX. En cas d'accord, le prix est librement déterminé par les Parties au jour de la vente et formalisé par un bon de commande distinct émis par ELOFLEX ainsi qu'une facture de vente. Le transfert de propriété met fin au prêt pour ce matériel. En Prêt Long Terme, une remise à neuf préalable pourra être organisée avec le service technique ELOFLEX.");

    art('Article 8 – Durée et fin du prêt');
    para("Le prêt prend fin : à l'échéance prévue au Bon de Prêt ; par accord mutuel ; à la demande d'ELOFLEX (préavis 15 j en Essai Court, 30 j en Long Terme) ; de plein droit et sans préavis en cas de manquement grave (cession non autorisée, dommages volontaires, retard de retour de plus de 15 jours, conflit de paiement…). À la fin du prêt, le matériel est restitué dans les 7 jours calendaires suivant la notification, sauf accord écrit contraire.");

    art('Article 9 – Dispositions générales');
    para("9.1 Droit applicable : droit français ; à défaut de solution amiable, compétence exclusive des juridictions du ressort du siège social d'ELOFLEX. 9.2 Toute modification fait l'objet d'un avenant écrit signé des deux parties. 9.3 La nullité d'une clause n'affecte pas les autres.");

    ensure(46);
    y += 2; doc.setFont('helvetica','normal'); doc.setFontSize(9);
    doc.text('Fait en deux exemplaires originaux, dont un remis à chaque partie.', L, y); y += 5;
    doc.text('À ' + (c.lieu || '……………………') + ', le ' + (c.signed_at ? this.fd((''+c.signed_at).slice(0,10)) : '……/……/………'), L, y); y += 4;
    doc.setFont('helvetica','italic'); doc.setFontSize(8); doc.setTextColor(90,90,90);
    doc.text('Lu et approuvé – Bon pour accord', L, y); y += 7; doc.setTextColor(0,0,0);

    const colW = W/2 - 3; const yTop = y;
    doc.setFont('helvetica','bold'); doc.setFontSize(9);
    doc.text('LE PRÊTEUR — ELOFLEX SAS', L, y+5);
    var _ccNom = c.representant_eloflex || c.signataire_eloflex || '';
    var _ccDate = c.eloflex_date ? this.fd((''+c.eloflex_date).slice(0,10)) : this.fd((new Date()).toISOString().slice(0,10));
    doc.setFont('helvetica','normal'); doc.setFontSize(8);
    doc.text('Représenté par : ' + _ccNom, L, y+11);
    doc.setFontSize(7.5); doc.setTextColor(90,90,90);
    doc.text('Signé électroniquement le ' + _ccDate, L, y+17);
    doc.setTextColor(0,0,0);
    doc.setFont('helvetica','bold'); doc.setFontSize(9);
    doc.text("L'EMPRUNTEUR (Distributeur)", L+colW+6, y+5);
    doc.setFont('helvetica','normal'); doc.setFontSize(8);
    doc.text('Raison sociale : ' + (c.distributeur_nom || ''), L+colW+6, y+11);
    if (c.signataire_nom) {
      doc.text('Signé par : ' + c.signataire_nom, L+colW+6, y+16);
      if (c.signed_at) doc.text('le ' + this.fd((''+c.signed_at).slice(0,10)), L+colW+6, y+21);
      if (c.signature_data) { try { doc.addImage(c.signature_data, 'PNG', L+colW+6, y+23, 52, 18); } catch(e){} }
    } else {
      doc.text('Nom : ______________________', L+colW+6, y+16);
    }
    doc.setDrawColor(200,200,200); doc.rect(L, yTop, colW, 42); doc.rect(L+colW+6, yTop, colW, 42);
    return doc;
  },
  contratCadre(c) { this.contratCadreDoc(c).save(`Contrat_cadre_pret_${(c.distributeur_nom||'distributeur').replace(/[^a-zA-Z0-9]/g,'_')}.pdf`); }
};
