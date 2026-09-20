import express from 'express';
import cors from 'cors';
import puppeteer from 'puppeteer';

const app = express();
app.use(cors());

// Cache mémoire : conserve le flux et ses sous-titres pendant 12 heures
const cache = new Map();
const CACHE_TTL = 12 * 60 * 60 * 1000;
const pendingRequests = new Map();

const SUBTITLE_LANGUAGES = {
  eng: ['en', 'English'],
  fre: ['fr', 'Français'],
  fra: ['fr', 'Français'],
  spa: ['es', 'Español'],
  deu: ['de', 'Deutsch'],
  ger: ['de', 'Deutsch'],
  ita: ['it', 'Italiano'],
  por: ['pt', 'Português'],
  rus: ['ru', 'Русский'],
  ara: ['ar', 'العربية'],
  jpn: ['ja', '日本語'],
  kor: ['ko', '한국어'],
  chi: ['zh', '中文'],
  zho: ['zh', '中文'],
  nld: ['nl', 'Nederlands'],
  pol: ['pl', 'Polski'],
  tur: ['tr', 'Türkçe']
};

function getSubtitleInfo(url, index) {
  let code = '';
  try {
    const pathname = decodeURIComponent(new URL(url).pathname);
    const match = pathname.match(/(?:^|[_-])([a-z]{2,3})(?=\.vtt$)/i);
    code = match ? match[1].toLowerCase() : '';
  } catch {}

  const [language, label] = SUBTITLE_LANGUAGES[code] || ['und', 'Sous-titres'];
  return {
    language,
    label: label === 'Sous-titres' && code ? code.toUpperCase() : label,
    url,
    index
  };
}

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
    const subtitleUrls = new Set();
    let finishTimer = null;

    const extractionPromise = new Promise((resolve) => {
      const finish = () => {
        if (!streamUrl) return;

        const subtitles = Array.from(subtitleUrls).map((url, index) =>
          getSubtitleInfo(url, index)
        );

        resolve({ streamUrl, subtitles });
      };

      const scheduleFinish = () => {
        clearTimeout(finishTimer);
        // Vidzy demande les VTT au démarrage du lecteur : on laisse passer
        // le burst de requêtes avant de fermer le navigateur d'extraction.
        finishTimer = setTimeout(finish, 2500);
      };

      page.on('request', (req) => {
        const url = req.url();

        // Flux vidéo principal : on conserve uniquement le vrai master.m3u8.
        if (
          url.includes('.m3u8') &&
          url.includes('master.m3u8') &&
          !url.includes('troll') &&
          !url.includes('fake')
        ) {
          streamUrl = url;
          scheduleFinish();
          return;
        }

        // Sous-titres externes Vidzy : ils ne sont pas déclarés dans le master HLS.
        if (/\.vtt(?:\?|$)/i.test(url)) {
          subtitleUrls.add(url);
          if (streamUrl) scheduleFinish();
        }
      });
    });

    await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });

    // Clic pour déclencher le lecteur Vidzy et ses requêtes HLS/VTT.
    try {
      await page.waitForSelector('video, .play, #player', { timeout: 5000 });
      await page.click('video, .play, #player');
    } catch {}

    const timeoutPromise = new Promise((_, reject) =>
      setTimeout(() => reject(new Error('Délai dépassé sans détection du vrai flux')), 20000)
    );

    const result = await Promise.race([extractionPromise, timeoutPromise]);
    clearTimeout(finishTimer);
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

  // Si le flux et ses sous-titres sont déjà en cache, retour immédiat.
  if (cache.has(cacheKey)) {
    const item = cache.get(cacheKey);
    if (now < item.expireAt) {
      console.log(`[CACHE HIT] Flux et sous-titres servis instantanément pour ${cacheKey}`);
      return res.json({
        success: true,
        streamUrl: item.streamUrl,
        subtitles: item.subtitles || [],
        fromCache: true
      });
    }
    cache.delete(cacheKey);
  }

  // Si une extraction est en cours pour ce média, on attend le même résultat.
  if (pendingRequests.has(cacheKey)) {
    try {
      const result = await pendingRequests.get(cacheKey);
      return res.json({
        success: true,
        streamUrl: result.streamUrl,
        subtitles: result.subtitles || [],
        fromCache: true
      });
    } catch (e) {
      return res.status(500).json({ success: false, error: e.message });
    }
  }

  const targetUrl = type === 'tv'
    ? `https://vidzy.org/tv/${tmdb_id}/${season}/${episode}`
    : `https://vidzy.org/movie/${tmdb_id}`;

  console.log(`[EXTRACTION ACTIVE] Récupération du flux réel pour : ${targetUrl}`);

  const task = extraireVraiFlux(targetUrl)
    .then((result) => {
      cache.set(cacheKey, {
        streamUrl: result.streamUrl,
        subtitles: result.subtitles || [],
        expireAt: now + CACHE_TTL
      });
      pendingRequests.delete(cacheKey);
      return result;
    })
    .catch((err) => {
      pendingRequests.delete(cacheKey);
      throw err;
    });

  pendingRequests.set(cacheKey, task);

  try {
    const result = await task;
    return res.json({
      success: true,
      streamUrl: result.streamUrl,
      subtitles: result.subtitles || [],
      fromCache: false
    });
  } catch (err) {
    console.error(`[ERREUR] ${err.message}`);
    return res.status(500).json({ success: false, error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Serveur d'extraction prêt sur le port ${PORT}`);
});
