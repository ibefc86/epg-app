const express = require('express');
const axios = require('axios');
const path = require('path');
const { DOMParser } = require('@xmldom/xmldom');
const app = express();
const PORT = process.env.PORT || 3001;

const EPG_URL = 'https://305.halfvex.com/xmltv.php?username=ib123&password=gP4HRjkXrc';
const SPORTSDB_KEY = '123';

const SPORT_MAP = [
  { id: 'soccer',      sdbName: 'Soccer',          emoji: '⚽' },
  { id: 'cricket',     sdbName: 'Cricket',          emoji: '🏏' },
  { id: 'nrl',         sdbName: 'Rugby League',     emoji: '🏉' },
  { id: 'rugby_union', sdbName: 'Rugby Union',      emoji: '🏆' },
  { id: 'afl',         sdbName: 'Australian Rules', emoji: '🦘' },
  { id: 'nba',         sdbName: 'Basketball',       emoji: '🏀' },
  { id: 'nfl',         sdbName: 'American Football', emoji: '🏈' },
  { id: 'tennis',      sdbName: 'Tennis',           emoji: '🎾' },
  { id: 'golf',        sdbName: 'Golf',             emoji: '⛳' },
  { id: 'f1',          sdbName: 'Motorsport',       emoji: '🏎️' },
  { id: 'boxing',      sdbName: 'Boxing',           emoji: '🥊' },
  { id: 'ice_hockey',  sdbName: 'Ice Hockey',       emoji: '🏒' },
  { id: 'baseball',    sdbName: 'Baseball',         emoji: '⚾' },
];

app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  next();
});
app.use(express.static(path.join(__dirname)));

let cache = null;
let fixtureCache = [];

function parseDate(s) {
  if (!s) return null;
  s = s.toString().trim();
  const utc = new Date(Date.UTC(+s.slice(0,4),+s.slice(4,6)-1,+s.slice(6,8),+s.slice(8,10),+s.slice(10,12),0));
  const off = s.slice(12).trim();
  if (off.length >= 3) {
    const sign = off[0]==='-'?-1:1;
    utc.setMinutes(utc.getMinutes() - sign*(+off.slice(1,3)*60+(+off.slice(3,5)||0)));
  }
  return utc;
}

const QUALITY_RANK = { '4k':6,'uhd':5,'2160p':5,'fhd':4,'1080p':4,'hevc':3,'hd':2,'720p':2,'sd':1,'576p':1,'480p':1 };

function getQualityScore(name) {
  const n = name.toLowerCase();
  let best = 0;
  for (const [key, score] of Object.entries(QUALITY_RANK)) {
    if (n.includes(key) && score > best) best = score;
  }
  return best;
}

function getQualityLabel(name) {
  const n = name.toLowerCase();
  if (n.includes('4k') || n.includes('uhd') || n.includes('2160p')) return '4K';
  if (n.includes('fhd') || n.includes('1080p')) return 'FHD';
  if (n.includes('hevc') || n.includes('hd') || n.includes('720p')) return 'HD';
  if (n.includes('sd')) return 'SD';
  return '';
}

function normaliseChannelName(name) {
  return name
    .replace(/\s*(4K|UHD|FHD|HEVC HB|HEVC LB|HEVC|1080p|720p|480p|576p|2160p|HD|\+1|\+2|SD|HB|LB|\(1080p\)|\(720p\)|\(480p\))\s*/gi, ' ')
    .replace(/\s+/g, ' ').trim().toLowerCase();
}

function deduplicateChannels(channels) {
  const groups = {};
  for (const ch of channels) {
    const key = normaliseChannelName(ch.name);
    if (!groups[key]) groups[key] = [];
    groups[key].push(ch);
  }
  const result = [];
  for (const [key, group] of Object.entries(groups)) {
    const withData = group.filter(ch => ch.now || ch.next?.length);
    const pool = withData.length ? withData : group;
    pool.sort((a, b) => getQualityScore(b.name) - getQualityScore(a.name));
    const best = pool[0];
    const words = normaliseChannelName(best.name).split(' ');
    const displayName = words.map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
    result.push({ ...best, quality: getQualityLabel(best.name), displayName, variants: group.length });
  }
  return result;
}

// Fetch today's fixtures from TheSportsDB
async function fetchFixtures() {
  const today = new Date().toISOString().split('T')[0];
  const fixtures = [];
  for (const sport of SPORT_MAP) {
    try {
      const res = await axios.get(
        `https://www.thesportsdb.com/api/v1/json/${SPORTSDB_KEY}/eventsday.php?d=${today}&s=${encodeURIComponent(sport.sdbName)}`,
        { timeout: 10000 }
      );
      const events = res.data?.events || [];
      for (const ev of events) {
        fixtures.push({
          sportId: sport.id,
          sportEmoji: sport.emoji,
          event: (ev.strEvent || '').toLowerCase(),
          home: (ev.strHomeTeam || '').toLowerCase(),
          away: (ev.strAwayTeam || '').toLowerCase(),
          league: (ev.strLeague || '').toLowerCase(),
          time: ev.strTime,
          status: ev.strStatus,
        });
      }
    } catch(e) {
      console.log(`Failed to fetch ${sport.sdbName} fixtures:`, e.message);
    }
  }
  fixtureCache = fixtures;
  console.log(`Loaded ${fixtures.length} fixtures for today`);
}

// Match a programme title against today's known fixtures
function matchFixture(title) {
  if (!title) return null;
  const t = title.toLowerCase();
  for (const fix of fixtureCache) {
    // Direct event name match
    if (fix.event && t.includes(fix.event.slice(0, 15))) return fix;
    // Team name match — if both home and away appear in title
    if (fix.home && fix.away && t.includes(fix.home.split(' ')[0]) && t.includes(fix.away.split(' ')[0])) return fix;
    // League match with "vs" pattern
    if (fix.league && t.includes(fix.league.slice(0, 10)) && t.includes(' vs ')) return fix;
  }
  return null;
}

// Fallback keyword sport detection
const SPORT_KEYWORDS = {
  soccer: ['premier league','champions league','la liga','bundesliga','serie a','ligue 1','europa league','fa cup','epl','mls','fifa world cup','euro 2024','euro 2026'],
  cricket: ['cricket','ashes','test match','ipl','indian premier league','big bash','t20','one-day','county cricket','icc'],
  nrl: ['nrl','rugby league','state of origin'],
  rugby_union: ['rugby union','super rugby','six nations','premiership rugby'],
  afl: ['afl','australian football'],
  nba: ['nba'],
  nfl: ['nfl','american football','super bowl'],
  tennis: ['tennis','wimbledon','us open','australian open','french open','roland garros','atp','wta'],
  golf: ['golf','pga tour','masters','the open','ryder cup','lpga','charles schwab','liv golf'],
  f1: ['formula 1','formula one','f1','grand prix','motogp'],
  boxing: ['boxing','ufc','mma','fight night','world title'],
  ice_hockey: ['ice hockey','nhl'],
  baseball: ['baseball','mlb'],
};

const NON_LIVE = ['highlights','replay','classic','documentary','news','magazine','preview','analysis','best of','greatest','history of','end of transmission','test card','review','the loop','extended','wrap','teleshopping'];

function isNonLive(title) {
  if (!title) return true;
  const t = title.toLowerCase();
  return NON_LIVE.some(w => t.includes(w));
}

function keywordSport(title) {
  if (!title) return null;
  const t = title.toLowerCase();
  for (const [id, kws] of Object.entries(SPORT_KEYWORDS)) {
    if (kws.some(k => t.includes(k))) {
      const sport = SPORT_MAP.find(s => s.id === id);
      return sport ? { sportId: id, sportEmoji: sport.emoji } : null;
    }
  }
  return null;
}

function classifyProgramme(title) {
  if (!title || isNonLive(title)) return { sport: null, isLive: false };
  // Try fixture match first
  const fix = matchFixture(title);
  if (fix) return { sport: { sportId: fix.sportId, sportEmoji: fix.sportEmoji }, isLive: true };
  // Fall back to keywords
  const kw = keywordSport(title);
  if (kw) return { sport: kw, isLive: false };
  return { sport: null, isLive: false };
}

async function refresh() {
  try {
    // Fetch fixtures and EPG in parallel
    console.log('Fetching fixtures and EPG...');
    await Promise.allSettled([
      fetchFixtures(),
      (async () => {
        const response = await axios.get(EPG_URL, { timeout: 120000, responseType: 'text' });
        console.log('Parsing XML...');
        const xml = new DOMParser().parseFromString(response.data, 'text/xml');
        const now = new Date();

        const channels = Array.from(xml.getElementsByTagName('channel')).map(c => ({
          id: c.getAttribute('id'),
          name: c.getElementsByTagName('display-name')[0]?.textContent || c.getAttribute('id'),
          logo: c.getElementsByTagName('icon')[0]?.getAttribute('src') || '',
          lang: c.getElementsByTagName('display-name')[0]?.getAttribute('lang') || ''
        }));

        const allProgs = Array.from(xml.getElementsByTagName('programme')).map(p => {
          const startRaw = p.getAttribute('start');
          const stopRaw = p.getAttribute('stop');
          const start = parseDate(startRaw);
          const stop = parseDate(stopRaw);
          return {
            channel: p.getAttribute('channel'),
            start, stop, startRaw,
            title: p.getElementsByTagName('title')[0]?.textContent || '',
            desc: p.getElementsByTagName('desc')[0]?.textContent || ''
          };
        }).filter(p => p.start && p.stop);

        const progsByChannel = {};
        allProgs.forEach(p => {
          if (!progsByChannel[p.channel]) progsByChannel[p.channel] = [];
          progsByChannel[p.channel].push(p);
        });

        const raw = channels.map(ch => {
          const progs = (progsByChannel[ch.id] || []).sort((a,b) => a.start - b.start);
          const nowP = progs.find(p => p.start <= now && p.stop > now);
          const next = progs.filter(p => p.start > now).slice(0, 2);
          const nowClassified = nowP ? classifyProgramme(nowP.title) : { sport: null, isLive: false };
          return {
            ...ch,
            now: nowP ? {
              title: nowP.title,
              desc: nowP.desc.slice(0, 150),
              startRaw: nowP.startRaw,
              pct: Math.min(100, Math.round(((now - nowP.start) / (nowP.stop - nowP.start)) * 100)),
              sport: nowClassified.sport,
              isLive: nowClassified.isLive,
            } : null,
            next: next.filter(p => !isNonLive(p.title)).map(p => ({
              title: p.title,
              desc: p.desc.slice(0, 100),
              startRaw: p.startRaw
            }))
          };
        });

        cache = deduplicateChannels(raw);
        console.log(`EPG ready — ${raw.length} → ${cache.length} channels`);
      })()
    ]);
  } catch(e) {
    console.error('Refresh failed:', e.message);
  }
  setTimeout(refresh, 30 * 60 * 1000);
}

app.get('/guide', (req, res) => {
  if (!cache) return res.status(503).json({ error: 'EPG still loading, try again in 30 seconds' });
  res.json(cache);
});

app.get('/status', (req, res) => {
  res.json({ ready: !!cache, channels: cache ? cache.length : 0, fixtures: fixtureCache.length });
});

app.listen(PORT, () => {
  console.log('EPG server running on port ' + PORT);
  refresh();
});