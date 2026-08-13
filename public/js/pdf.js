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
    [['Nom', cl.nom], ['Contact', cl.contact||'—'], ['Email', cl.email||'—'], ['Téléphone', cl.tel||'—'], ['Ville', cl.ville||'—'], ['Type', cl.type||'—']].forEach(([k,v]) => {
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
    line2('Contact', [p.contact, p.tel, p.email].filter(Boolean).join(' — ') || '—');
    y += 2;

    band('2 · FORMULE & DURÉE');
    line2('Formule', FORM[p.formule] || p.formule || '—');
    line2('Date de remise', this.fd((p.date_remise||'').slice(0,10)));
    line2('Retour prévu', this.fd((p.date_retour_prevue||'').slice(0,10)));
    if (p.prorogation_date) line2('Prorogation', this.fd((p.prorogation_date||'').slice(0,10)));
    y += 2;

    band('3 · MATÉRIEL PRÊTÉ');
    line2('Désignation', p.designation || '—');
    line2('N° de série', p.num_serie || '—');
    line2('Valeur cat. HT', p.valeur_ht != null ? (p.valeur_ht + ' € HT') : '—');
    if (p.observations) { doc.setFont('helvetica','italic'); doc.setFontSize(8); doc.setTextColor(90,90,90);
      doc.text(doc.splitTextToSize('Observations : ' + p.observations, W), L, y); y += 5 + Math.min(20, doc.splitTextToSize(p.observations, W).length*4); doc.setTextColor(0,0,0); }
    y += 2;

    band("4 · ENGAGEMENTS DE L'EMPRUNTEUR");
    doc.setFont('helvetica','normal'); doc.setFontSize(8); doc.setTextColor(60,60,60);
    const eng = "Le distributeur déclare avoir pris connaissance du Contrat-cadre de prêt ELOFLEX et en accepter sans réserve toutes les conditions : utilisation supervisée par un ergothérapeute, essai patient 7 jours maximum, conservation de l'emballage et des mousses, signalement immédiat de tout incident, frais de retour 50 € HT / fauteuil, retour dans le carton d'origine propre et fonctionnel. En cas de perte/destruction : prix catalogue HT moins décote vétusté (5 %/mois, plafond 30 %). Dommages : frais réels sur devis ELOFLEX.";
    doc.text(doc.splitTextToSize(eng, W), L, y); y += doc.splitTextToSize(eng, W).length*3.6 + 4;
    doc.setTextColor(0,0,0);

    band('5 · SIGNATURES');
    const colW = W/2 - 3;
    const yTop = y;
    doc.setFontSize(9); doc.setFont('helvetica','bold'); doc.text('ELOFLEX', L, y+4);
    doc.setFont('helvetica','normal'); doc.text('Nom : ' + ( (window.CURRENT_USER && window.CURRENT_USER.nom) || ''), L, y+10);
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
  pret(p) { this.pretDoc(p).save(`Bon_de_pret_${(p.distributeur_nom||'distributeur').replace(/[^a-zA-Z0-9]/g,'_')}.pdf`); }
};
