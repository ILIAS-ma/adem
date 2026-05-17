const express = require('express');
const path = require('path');
const { Pool } = require('pg');
const services = require('./services.json');

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

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`SaaS Supabase actif sur le port ${PORT}`));