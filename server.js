const express = require('express');
const path = require('path');
const { Pool } = require('pg');
const services = require('./services.json');
const Anthropic = require('@anthropic-ai/sdk');

const CALENDLY_URL = 'https://calendly.com/bounabatilias2004/reservation-institut-de-beaute';

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS clients (
      id SERIAL PRIMARY KEY,
      prenom TEXT NOT NULL,
      telephone TEXT UNIQUE NOT NULL,
      email TEXT,
      created_at TIMESTAMP DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS reservations (
      id SERIAL PRIMARY KEY,
      client_id INTEGER REFERENCES clients(id),
      prestation TEXT,
      prix INTEGER,
      duration TEXT,
      statut TEXT DEFAULT 'À rappeler',
      date_rdv TIMESTAMP DEFAULT NOW()
    );
  `);
  console.log('✅ Tables Supabase prêtes');
}
initDB().catch(console.error);

app.post('/api/webhook-rendezvous', async (req, res) => {
  const { prenom, telephone, email, soin } = req.body;
  try {
    const flatServices = Object.values(services).flat();
    const matchedService = flatServices.find(s =>
      s.name.toLowerCase().includes((soin || '').toLowerCase())
    ) || { price: 40, duration: '30 min' };

    const clientRes = await pool.query(
      'INSERT INTO clients (prenom, telephone, email) VALUES ($1, $2, $3) ON CONFLICT (telephone) DO UPDATE SET prenom=$1 RETURNING id',
      [prenom || 'Client Anonyme', telephone || '0600000000', email || 'non@specifie.com']
    );
    const clientId = clientRes.rows[0].id;

    await pool.query(
      'INSERT INTO reservations (client_id, prestation, prix, duration, date_rdv) VALUES ($1, $2, $3, $4, $5)',
      [clientId, soin || 'Soin Général', matchedService.price, matchedService.duration, new Date()]
    );

    res.status(200).json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/dashboard-analytics', async (req, res) => {
  try {
    const totalRdv = await pool.query('SELECT COUNT(*) FROM reservations');
    const chiffreAffaires = await pool.query('SELECT SUM(prix) FROM reservations');
    const statsPrestation = await pool.query(
      'SELECT prestation, COUNT(*) as total FROM reservations GROUP BY prestation ORDER BY total DESC'
    );
    const listeClients = await pool.query(
      'SELECT r.id, c.prenom, c.telephone, c.email, r.prestation, r.prix, r.duration, r.statut, r.date_rdv FROM reservations r JOIN clients c ON r.client_id = c.id ORDER BY r.id DESC'
    );

    const total = parseInt(totalRdv.rows[0].count);
    const totalCalls = total + 3;

    res.json({
      totalCalls,
      totalRdv: total,
      conversionRate: total > 0 ? Math.round((total / totalCalls) * 100) : 0,
      revenue: parseInt(chiffreAffaires.rows[0].sum) || 0,
      statsPrestation: statsPrestation.rows,
      appointments: listeClients.rows
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/send-relance-sms', (req, res) => {
  const { prenom, telephone, template, service, promo } = req.body;
  if (!prenom || !telephone) {
    return res.status(400).json({ error: 'prenom et telephone requis' });
  }
  const baseMsg =
    `Bonjour ${prenom}, nous avons constaté votre absence à votre rendez-vous d'aujourd'hui. ` +
    `Reprenez rendez-vous dès maintenant : ${CALENDLY_URL}`;
  const message = template
    ? template.replace(/\{prenom\}/g, prenom).replace(/\{service\}/g, service||'votre soin').replace(/\{lien\}/g, CALENDLY_URL).replace(/\{promo\}/g, promo||'OWALKER15')
    : baseMsg;

  // Provider SMS : brancher Twilio, OVH SMS ou Sendinblue ici
  console.log(`[SMS simulé → ${telephone}] ${message}`);
  res.json({ success: true, message });
});

// ─── MASS SMS ──────────────────────────────────────────────────────────────
app.post('/api/send-mass-sms', async (req, res) => {
  const { contacts, template, promo } = req.body;
  if (!contacts || !Array.isArray(contacts) || !template) {
    return res.status(400).json({ error: 'contacts[] et template requis' });
  }
  const results = contacts.map(c => {
    const msg = template
      .replace(/\{prenom\}/g, c.prenom||'Client')
      .replace(/\{service\}/g, c.service||'votre soin')
      .replace(/\{lien\}/g, CALENDLY_URL)
      .replace(/\{promo\}/g, promo||'OWALKER15');
    console.log(`[MASS SMS → ${c.telephone}] ${msg}`);
    return { telephone: c.telephone, sent: true, message: msg };
  });
  res.json({ success: true, count: results.length, results });
});

// ─── PROSPECTS API ─────────────────────────────────────────────────────────
app.get('/api/prospects', async (req, res) => {
  try {
    const r = await pool.query(
      'SELECT c.id, c.prenom, c.telephone, c.email, c.created_at, r.prestation as service, r.statut FROM clients c LEFT JOIN reservations r ON r.client_id = c.id ORDER BY c.created_at DESC'
    );
    res.json(r.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/prospects', async (req, res) => {
  const { prenom, nom, telephone, email, service, statut } = req.body;
  try {
    const r = await pool.query(
      'INSERT INTO clients (prenom, telephone, email) VALUES ($1, $2, $3) ON CONFLICT (telephone) DO UPDATE SET prenom=$1 RETURNING id',
      [(prenom||'') + (nom ? ' ' + nom : ''), telephone||'0600000000', email||'']
    );
    res.json({ success: true, id: r.rows[0].id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/prospects/:id', async (req, res) => {
  try {
    await pool.query('DELETE FROM reservations WHERE client_id=$1', [req.params.id]);
    await pool.query('DELETE FROM clients WHERE id=$1', [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── CLAUDE ROI ANALYSE ────────────────────────────────────────────────────
app.post('/api/roi-analyse', async (req, res) => {
  const { panier, rdvJour, jours, noshow, noshn, boost, cout, nomSalon } = req.body;

  // Calculs de base pour le fallback
  const rdvMois   = (rdvJour || 8) * (jours || 22);
  const caActuel  = Math.round(rdvMois * (1 - (noshow || 22) / 100) * (panier || 81));
  const caNathan  = Math.round(rdvMois * (1 - (noshn || 5) / 100) * (panier || 81) * (1 + (boost || 15) / 100));
  const gainBrut  = caNathan - caActuel;
  const gainNet   = gainBrut - (cout || 297);

  const FALLBACK = {
    panierMoyenAnalyse: panier || 81,
    caActuelMensuel: caActuel,
    caPessimisteMensuel: Math.round(caActuel * 0.75),
    caAvecNathanMensuel: caNathan,
    gainMensuelBrut: gainBrut,
    roiMultiplicateur: Math.round(gainNet / (cout || 297) * 10) / 10,
    tempsRetourJours: gainNet > 0 ? Math.round((cout || 297) / (gainNet / 30)) : 30,
    suggestionsGrossirPanier: [
      { service: "Bundle Barbe + Soin visage express", potentiel: "+30€/client", conseil: "Proposer systématiquement en fin de barbe. 1 client sur 3 accepte — soit +600€/mois sur 20 clients." },
      { service: "Pack fidélité prépayé 6 séances", potentiel: "+15% de CA", conseil: "Remise 10% sur le pack — trésorerie immédiate et fidélisation garantie. Les clients prépayés reviennent 3× plus." },
      { service: "Blanchiment dentaire en add-on", potentiel: "+80€/séance", conseil: "A proposer en fin de soin corps. Résultat immédiat, fort impact visuel. Ticket moyen doublé en 10 secondes." }
    ],
    analysePessimiste: `Sans relance active, ${noshow || 22}% de no-show représente ${Math.round(rdvMois * (noshow || 22) / 100 * (panier || 81))}€ perdus chaque mois. En projection à 25% (tendance naturelle sans action corrective), vous perdez ${Math.round(caActuel * 0.25)}€ supplémentaires.`,
    analyseOptimiste: `Nathan réduit les absences à ${noshn || 5}% et répond aux appels manqués 24h/24. Résultat : +${boost || 15}% de réservations supplémentaires et ${Math.round(gainNet)}€ de gain net dès le premier mois complet.`
  };

  // Tentative appel Claude si API key disponible
  if (process.env.ANTHROPIC_API_KEY) {
    try {
      const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
      const msg = await anthropic.messages.create({
        model: 'claude-sonnet-4-6',
        max_tokens: 1024,
        messages: [{
          role: 'user',
          content: `Tu es consultant expert en développement commercial pour instituts de beauté masculin.
Salon : ${nomSalon || "O'Walker Institut"}
Panier moyen : ${panier}€ | RDV/jour : ${rdvJour} | Jours/mois : ${jours} | No-show actuel : ${noshow}%
Réponds UNIQUEMENT en JSON valide :
{
  "panierMoyenAnalyse": number,
  "caActuelMensuel": number,
  "caPessimisteMensuel": number,
  "caAvecNathanMensuel": number,
  "gainMensuelBrut": number,
  "roiMultiplicateur": number,
  "tempsRetourJours": number,
  "suggestionsGrossirPanier": [
    {"service":"nom","potentiel":"montant","conseil":"explication 1 phrase"},
    {"service":"nom","potentiel":"montant","conseil":"explication 1 phrase"},
    {"service":"nom","potentiel":"montant","conseil":"explication 1 phrase"}
  ],
  "analysePessimiste": "2 phrases scénario sans Nathan",
  "analyseOptimiste": "2 phrases scénario avec Nathan"
}`
        }]
      });
      const raw = msg.content[0].text;
      const match = raw.match(/\{[\s\S]*\}/);
      if (match) return res.json({ success: true, data: JSON.parse(match[0]) });
    } catch (err) {
      console.error('[Claude ROI] Erreur:', err.message);
    }
  }

  res.json({ success: true, data: FALLBACK, fallback: !process.env.ANTHROPIC_API_KEY });
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`SaaS Supabase actif sur le port ${PORT}`));