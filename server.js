import express from 'express';
import cors from 'cors';
import puppeteer from 'puppeteer';

const app = express();
app.use(cors());

// Cache mémoire : conserve le vrai lien pendant 12 heures
const cache = new Map();
const CACHE_TTL = 12 * 60 * 60 * 1000;
const pendingRequests = new Map();

async function extraireVraiFlux(targetUrl) {
  const browser = await puppeteer.launch({
    headless: "new",
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--disable-blink-features=AutomationControlled'
    ]
  });

  try {
    const page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36');

    let streamUrl = null;

    const streamPromise = new Promise((resolve) => {
      page.on('request', (req) => {
        const url = req.url();
        // Ignore les flux pièges de 18s et garde uniquement le vrai master.m3u8
        if (url.includes('.m3u8') && url.includes('master.m3u8') && !url.includes('troll') && !url.includes('fake')) {
          streamUrl = url;
          resolve(url);
        }
      });
    });

    await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });

    // Clic pour déclencher le lecteur Vidzy
    try {
      await page.waitForSelector('video, .play, #player', { timeout: 5000 });
      await page.click('video, .play, #player');
    } catch {}

    const timeoutPromise = new Promise((_, reject) =>
      setTimeout(() => reject(new Error('Délai dépassé sans détection du vrai flux')), 20000)
    );

    const result = await Promise.race([streamPromise, timeoutPromise]);
    await browser.close();
    return result;

  } catch (err) {
    await browser.close();
    throw err;
  }
}

app.get('/api/extract', async (req, res) => {
  const { tmdb_id, type = 'movie', season = 1, episode = 1 } = req.query;

  if (!tmdb_id) {
    return res.status(400).json({ success: false, error: 'tmdb_id requis' });
  }

  const cacheKey = `${type}_${tmdb_id}_${season}_${episode}`;
  const now = Date.now();

  // Si le vrai flux est déjà en cache, retour immédiat
  if (cache.has(cacheKey)) {
    const item = cache.get(cacheKey);
    if (now < item.expireAt) {
      console.log(`[CACHE HIT] Flux servi instantanément pour ${cacheKey}`);
      return res.json({ success: true, streamUrl: item.streamUrl, fromCache: true });
    }
    cache.delete(cacheKey);
  }

  // Si une extraction est en cours pour ce média, on l'attend sans relancer un navigateur
  if (pendingRequests.has(cacheKey)) {
    try {
      const streamUrl = await pendingRequests.get(cacheKey);
      return res.json({ success: true, streamUrl, fromCache: true });
    } catch (e) {
      return res.status(500).json({ success: false, error: e.message });
    }
  }

  const targetUrl = type === 'tv'
    ? `https://vidzy.org/tv/${tmdb_id}/${season}/${episode}`
    : `https://vidzy.org/movie/${tmdb_id}`;

  console.log(`[EXTRACTION ACTIVE] Récupération du flux réel pour : ${targetUrl}`);

  const task = extraireVraiFlux(targetUrl)
    .then((url) => {
      cache.set(cacheKey, { streamUrl: url, expireAt: now + CACHE_TTL });
      pendingRequests.delete(cacheKey);
      return url;
    })
    .catch((err) => {
      pendingRequests.delete(cacheKey);
      throw err;
    });

  pendingRequests.set(cacheKey, task);

  try {
    const streamUrl = await task;
    return res.json({ success: true, streamUrl, fromCache: false });
  } catch (err) {
    console.error(`[ERREUR] ${err.message}`);
    return res.status(500).json({ success: false, error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Serveur d'extraction prêt sur le port ${PORT}`);
});
