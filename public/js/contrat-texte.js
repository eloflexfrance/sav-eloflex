// Texte du contrat-cadre de prêt — partagé par contrat.html et pret.html (signature unique)
(function(){
  function esc(s){ return (s==null?'':String(s)).replace(/[&<>"]/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c];}); }
  function contratHTML(c){
    return '<h1>CONTRAT-CADRE DE PRÊT À USAGE</h1>'+
      '<div class="sub">Commodat – Articles 1875 à 1891 du Code civil</div>'+
      '<p class="a"><b>Entre</b> ELOFLEX SAS (« le Prêteur »)'+(c.representant_eloflex?', représentée par '+esc(c.representant_eloflex):'')+
        ' <b>et</b> '+esc(c.distributeur_nom||'…')+' (« l\'Emprunteur »)'+(c.siege_distrib?', dont le siège social est situé '+esc(c.siege_distrib):'')+(c.siret_distrib?' — '+(String(c.siret_distrib).replace(/\s+/g,'').length===9?'SIREN':'SIRET')+' : '+esc(c.siret_distrib):'')+
        (c.representant_distrib?', représenté par '+esc(c.representant_distrib):'')+'.</p>'+
      '<h3>Article 1 – Objet et nature juridique</h3>'+
      '<p class="a">Mise à disposition, à titre gratuit et temporaire, d\'un ou plusieurs fauteuils roulants électriques Eloflex aux fins exclusives d\'essai patient supervisé par un ergothérapeute, conformément à l\'arrêté du 6 février 2025 modifié (VPH, art. L.165-1 CSS). Le prêt constitue un commodat : ELOFLEX conserve la pleine propriété du matériel ; aucun transfert de propriété ne résulte de la remise. Chaque prêt fait l\'objet d\'un Bon de Prêt distinct.</p>'+
      '<h3>Article 2 – Formules de prêt</h3>'+
      '<p class="a"><b>Essai Court (15 à 30 jours)</b> : durée maximale 30 jours calendaires dès la livraison, sauf prorogation écrite. <b>Prêt Long Terme (≥ 3 mois, renouvelable)</b> : réservé aux partenaires sélectionnés, soumis aux engagements de l\'article 4.2.</p>'+
      '<h3>Article 3 – Livraison et état du matériel</h3>'+
      '<p class="a">Expédition par ELOFLEX à ses frais (sauf mention contraire du Bon de Prêt). État des lieux contradictoire formalisé par la signature du Bon de Prêt. Conservation de l\'emballage d\'origine et des mousses pendant toute la durée.</p>'+
      '<h3>Article 4 – Obligations de l\'Emprunteur</h3>'+
      '<p class="a">4.1 – Communes aux deux formules :</p>'+
      '<ul>'+
        '<li>Utiliser le matériel uniquement pour des essais patients supervisés par un ergothérapeute.</li>'+
        '<li>Maintenir le matériel en bon état de fonctionnement et de propreté.</li>'+
        '<li>Ne pas prêter, sous-louer ou céder le matériel à un tiers autre qu\'un patient en essai.</li>'+
        '<li>Signaler sans délai tout incident, anomalie ou dommage.</li>'+
        '<li>Retourner le matériel dans son emballage d\'origine, avec les mousses, en bon état général.</li>'+
        '<li>Confirmer par e-mail le bon état du matériel avant tout retour.</li>'+
        '<li>Retourner le matériel dans le délai prévu au Bon de Prêt.</li>'+
        '<li>Participer aux frais de retour (transport) : 50 € HT par fauteuil.</li>'+
        '<li>Prendre en charge la main d\'œuvre et les pièces de remise en état avant chaque nouvel essai et avant tout retour.</li>'+
      '</ul>'+
      '<p class="a">4.2 – Spécifiques Prêt Long Terme :</p>'+
      '<ul>'+
        '<li>Maintenir le matériel en état « quasi neuf ».</li>'+
        '<li>Au moins un (1) essai patient par mois en moyenne (modèle prêté ou autre modèle Eloflex).</li>'+
        '<li>Informer ELOFLEX en cas d\'indisponibilité prolongée et faciliter la mise à disposition pour d\'autres essais.</li>'+
        '<li>Communiquer un bilan trimestriel simplifié des essais (nombre, retours patients).</li>'+
      '</ul>'+
      '<h3>Article 5 – Responsabilité et garantie du matériel</h3>'+
      '<p class="a">L\'Emprunteur est responsable du matériel dès sa réception et jusqu\'à son retour effectif chez ELOFLEX (constaté par accusé de réception ou bon de livraison signé), dans les conditions des articles 1880 à 1884 du Code civil. En cas de perte, vol, destruction ou détérioration importante, et si le matériel n\'est pas retourné dans les délais impartis, l\'Emprunteur sera tenu de régler à ELOFLEX, le cas échéant :</p>'+
      '<ul>'+
        '<li><b>Perte ou destruction totale</b> : la valeur déclarée dans le Bon de Prêt ou, à défaut, le prix catalogue public HT du matériel en vigueur à la date du sinistre.</li>'+
        '<li><b>Dommages partiels</b> : ELOFLEX adresse à l\'Emprunteur un devis détaillé des réparations. À défaut de contestation motivée dans un délai de quinze (15) jours à compter de sa réception, ce devis est réputé accepté et ELOFLEX peut procéder aux réparations. En cas de contestation motivée, les Parties s\'efforcent de parvenir à un accord amiable ; à défaut d\'accord dans un délai de quinze (15) jours, le montant des réparations est déterminé sur la base d\'un devis établi par un réparateur indépendant spécialisé choisi d\'un commun accord, dont les frais sont supportés par la Partie dont la position a été écartée. L\'usure normale résultant d\'une utilisation conforme au présent contrat n\'est pas facturée.</li>'+
      '</ul>'+
      '<p class="a">L\'Emprunteur est invité à s\'assurer que sa police d\'assurance responsabilité civile professionnelle couvre les biens confiés à titre de prêt. ELOFLEX pourra demander une attestation d\'assurance.</p>'+
      '<h3>Article 6 – Frais de retour et d\'emballage</h3>'+
      '<table style="border-collapse:collapse;width:100%;font-size:12.5px;margin:4px 0 8px">'+
        '<tr><th style="border:1px solid #ccd3da;padding:5px 8px;background:#eef2f6;text-align:left">Prestation</th>'+
          '<th style="border:1px solid #ccd3da;padding:5px 8px;background:#eef2f6">Essai Court</th>'+
          '<th style="border:1px solid #ccd3da;padding:5px 8px;background:#eef2f6">Long Terme</th></tr>'+
        '<tr><td style="border:1px solid #ccd3da;padding:5px 8px">Frais de retour (transport) par fauteuil</td>'+
          '<td style="border:1px solid #ccd3da;padding:5px 8px;text-align:center">50 € HT</td>'+
          '<td style="border:1px solid #ccd3da;padding:5px 8px;text-align:center">50 € HT</td></tr>'+
        '<tr><td style="border:1px solid #ccd3da;padding:5px 8px">Supplément si emballage / mousses manquants</td>'+
          '<td style="border:1px solid #ccd3da;padding:5px 8px;text-align:center">90 € HT*</td>'+
          '<td style="border:1px solid #ccd3da;padding:5px 8px;text-align:center">90 € HT*</td></tr>'+
      '</table>'+
      '<p class="a">* En complément des 50 € HT de frais de retour, soit 140 € HT au total si l\'emballage d\'origine et/ou les mousses de protection sont absents. Ces frais sont facturés séparément à l\'issue du prêt et ne constituent en aucun cas une contrepartie financière du prêt.</p>'+
      '<h3>Article 7 – Cession du matériel</h3>'+
      '<p class="a">L\'Emprunteur peut proposer à tout moment le rachat du matériel. Offre sans engagement pour ELOFLEX ; en cas d\'accord, prix librement fixé au jour de la vente, formalisé par un bon de commande distinct et une facture de vente. Le transfert de propriété met fin au prêt pour ce matériel.</p>'+
      '<h3>Article 8 – Durée et fin du prêt</h3>'+
      '<p class="a">Fin : à l\'échéance du Bon de Prêt ; par accord mutuel ; à la demande d\'ELOFLEX (préavis 15 j Essai Court / 30 j Long Terme) ; de plein droit sans préavis en cas de manquement grave. Restitution dans les 7 jours calendaires suivant la notification de fin de prêt.</p>'+
      '<h3>Article 9 – Dispositions générales</h3>'+
      '<p class="a">Droit français ; à défaut d\'accord amiable, compétence exclusive des juridictions du siège social d\'ELOFLEX. Toute modification par avenant écrit signé des deux parties. La nullité d\'une clause n\'affecte pas les autres.</p>';
  }
  
  window.contratHTML = contratHTML;
})();
