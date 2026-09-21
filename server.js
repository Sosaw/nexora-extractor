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

    // Sous-titres Vidzy : collecte légère des URLs .vtt pendant que
    // l'extraction du flux .m3u8 existante continue inchangée.
    const subtitles = new Map();

    const VIDZY_SUBTITLE_LANGUAGES = {
      fre: { language: 'fr', label: 'Français' },
      fra: { language: 'fr', label: 'Français' },
      cat: { language: 'fr', label: 'Français' }, // Vidzy : contenu français
      eng: { language: 'en', label: 'English' },
      spa: { language: 'es', label: 'Español' },
      deu: { language: 'de', label: 'Deutsch' },
      ger: { language: 'de', label: 'Deutsch' },
      ita: { language: 'it', label: 'Italiano' },
      por: { language: 'pt', label: 'Português' },
      jpn: { language: 'ja', label: '日本語' }
    };

    function identifierLangueSousTitre(url) {
      try {
        const pathname = new URL(url).pathname;
        const filename = pathname.split('/').pop() || '';
        const match = filename.match(/_([a-z]{3})\.vtt$/i);

        if (!match) {
          return {
            language: 'und',
            label: 'Sous-titres'
          };
        }

        const code = match[1].toLowerCase();

        return VIDZY_SUBTITLE_LANGUAGES[code] || {
          language: 'und',
          label: code.toUpperCase()
        };
      } catch {
        return {
          language: 'und',
          label: 'Sous-titres'
        };
      }
    }

    function enregistrerSousTitre(url) {
      const pathname = new URL(url).pathname;
      const filename = pathname.split('/').pop() || url;
      const langue = identifierLangueSousTitre(url);

      // On préfère l'URL finale /vtt/ à l'URL proxy /srtproxy/
      // lorsqu'elles correspondent au même fichier.
      const priority = /\/vtt\//i.test(pathname) ? 2 : 1;
      const key = filename.toLowerCase();
      const previous = subtitles.get(key);

      if (!previous || priority > previous.priority) {
        subtitles.set(key, {
          url,
          language: langue.language,
          label: langue.label,
          priority
        });

        console.log(`[VTT] ${langue.label} → ${url}`);
      }
    }

    const streamPromise = new Promise((resolve) => {
      page.on('request', (req) => {
        const url = req.url();

        // Extraction du vrai flux : logique actuelle conservée à l'identique.
        if (url.includes('.m3u8') && url.includes('master.m3u8') && !url.includes('troll') && !url.includes('fake')) {
          streamUrl = url;
          resolve(url);
        }

        // Capture parallèle des sous-titres : même interception réseau
        // que le flux, uniquement via l'URL de la requête.
        if (/\.vtt(?:\?|$)/i.test(url)) {
          try {
            enregistrerSousTitre(url);
          } catch (error) {
            console.warn(`[VTT] Impossible d'identifier ${url}: ${error.message}`);
          }
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

    const streamResult = await Promise.race([streamPromise, timeoutPromise]);

    // Après le master, on laisse seulement le temps nécessaire aux requêtes
    // VTT déjà déclenchées. Une nouvelle requête VTT prolonge légèrement la
    // fenêtre afin de récupérer toutes les pistes d'un même chargement.
    await new Promise((resolve) => {
      let finished = false;
      let quietTimer = null;
      let maxTimer = null;

      const finish = () => {
        if (finished) return;
        finished = true;
        if (quietTimer) clearTimeout(quietTimer);
        if (maxTimer) clearTimeout(maxTimer);
        resolve();
      };

      const onSubtitleRequest = () => {
        if (quietTimer) clearTimeout(quietTimer);
        quietTimer = setTimeout(finish, 400);
      };

      page.on('request', function subtitleWindowRequest(req) {
        if (/\.vtt(?:\?|$)/i.test(req.url())) {
          onSubtitleRequest();
        }
      });

      quietTimer = setTimeout(finish, 700);
      maxTimer = setTimeout(finish, 2000);
    });

    const result = {
      streamUrl: streamResult,
      subtitles: Array.from(subtitles.values()).map(({ priority, ...subtitle }) => subtitle)
    };

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
      console.log(`[CACHE HIT] Flux + sous-titres servis instantanément pour ${cacheKey}`);
      return res.json({
        success: true,
        streamUrl: item.streamUrl,
        subtitles: item.subtitles || [],
        fromCache: true
      });
    }
    cache.delete(cacheKey);
  }

  // Si une extraction est en cours pour ce média, on l'attend sans relancer un navigateur
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
