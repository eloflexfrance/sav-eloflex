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
  }
};
