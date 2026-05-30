const express = require('express');
const axios = require('axios');
const path = require('path');
const { DOMParser } = require('@xmldom/xmldom');
const app = express();
const PORT = process.env.PORT || 3001;

const EPG_URL = 'https://305.halfvex.com/xmltv.php?username=ib123&password=gP4HRjkXrc';
const ESPN_BASE = 'https://site.api.espn.com/apis/site/v2/sports';

const ESPN_LEAGUES = [
  { id: 'nrl',         url: `${ESPN_BASE}/rugby-league/3/scoreboard`,           emoji: '🏉' },
  { id: 'afl',         url: `${ESPN_BASE}/australian-football/afl/scoreboard`,  emoji: '🦘' },
  { id: 'nba',         url: `${ESPN_BASE}/basketball/nba/scoreboard`,           emoji: '🏀' },
  { id: 'nfl',         url: `${ESPN_BASE}/football/nfl/scoreboard`,             emoji: '🏈' },
  { id: 'nhl',         url: `${ESPN_BASE}/hockey/nhl/scoreboard`,               emoji: '🏒' },
  { id: 'mlb',         url: `${ESPN_BASE}/baseball/mlb/scoreboard`,             emoji: '⚾' },
  { id: 'soccer_epl',  url: `${ESPN_BASE}/soccer/eng.1/scoreboard`,             emoji: '⚽' },
  { id: 'soccer_ucl',  url: `${ESPN_BASE}/soccer/uefa.champions/scoreboard`,    emoji: '⚽' },
  { id: 'soccer_mls',  url: `${ESPN_BASE}/soccer/usa.1/scoreboard`,             emoji: '⚽' },
  { id: 'soccer_esp',  url: `${ESPN_BASE}/soccer/esp.1/scoreboard`,             emoji: '⚽' },
  { id: 'soccer_ger',  url: `${ESPN_BASE}/soccer/ger.1/scoreboard`,             emoji: '⚽' },
  { id: 'soccer_ita',  url: `${ESPN_BASE}/soccer/ita.1/scoreboard`,             emoji: '⚽' },
  { id: 'soccer_aus',  url: `${ESPN_BASE}/soccer/aus.1/scoreboard`,             emoji: '⚽' },
  { id: 'soccer_fra',  url: `${ESPN_BASE}/soccer/fra.1/scoreboard`,             emoji: '⚽' },
 { id: 'tennis_rg',   url: `${ESPN_BASE}/tennis/french-open/scoreboard`,        emoji: '🎾' },
  { id: 'tennis_ao',   url: `${ESPN_BASE}/tennis/australian-open/scoreboard`,    emoji: '🎾' },
  { id: 'tennis_usop', url: `${ESPN_BASE}/tennis/us-open/scoreboard`,            emoji: '🎾' },
  { id: 'tennis_wimb', url: `${ESPN_BASE}/tennis/wimbledon/scoreboard`,          emoji: '🎾' },
  { id: 'golf_pga',    url: `${ESPN_BASE}/golf/pga/scoreboard`,                 emoji: '⛳' },
  { id: 'golf_eur',    url: `${ESPN_BASE}/golf/eur/scoreboard`,                 emoji: '⛳' },
  { id: 'mma',         url: `${ESPN_BASE}/mma/ufc/scoreboard`,                  emoji: '🥊' },
  { id: 'f1',          url: `${ESPN_BASE}/racing/f1/scoreboard`,                emoji: '🏎️' },
];

const LEAGUE_TO_SPORT = {
  nrl: 'nrl', afl: 'afl', nba: 'nba', nfl: 'nfl', nhl: 'ice_hockey',
  mlb: 'baseball', soccer_epl: 'soccer', soccer_ucl: 'soccer',
  soccer_mls: 'soccer', soccer_esp: 'soccer', soccer_ger: 'soccer',
  soccer_ita: 'soccer',soccer_aus: 'soccer', soccer_fra: 'soccer', tennis_atp: 'tennis', tennis_wta: 'tennis',
  golf_pga: 'golf', golf_eur: 'golf', mma: 'boxing', f1: 'f1',
};

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
  const off = s.slice(14).trim();
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

async function fetchESPNFixtures() {
  const fixtures = [];
  const results = await Promise.allSettled(
    ESPN_LEAGUES.map(league =>
      axios.get(league.url, { timeout: 10000 })
        .then(res => ({ league, data: res.data }))
    )
  );

  for (const result of results) {
    if (result.status !== 'fulfilled') continue;
    const { league, data } = result.value;
    const events = data?.events || [];
    const sportId = LEAGUE_TO_SPORT[league.id] || league.id;

    for (const event of events) {
      const state = event.status?.type?.state;
      const competitors = event.competitions?.[0]?.competitors || [];
      const home = competitors.find(c => c.homeAway === 'home')?.team?.displayName || '';
      const away = competitors.find(c => c.homeAway === 'away')?.team?.displayName || '';
      const homeShort = competitors.find(c => c.homeAway === 'home')?.team?.shortDisplayName || '';
      const awayShort = competitors.find(c => c.homeAway === 'away')?.team?.shortDisplayName || '';

      fixtures.push({
        sportId,
        emoji: league.emoji,
        name: (event.name || '').toLowerCase(),
        shortName: (event.shortName || '').toLowerCase(),
        home: home.toLowerCase(),
        away: away.toLowerCase(),
        homeShort: homeShort.toLowerCase(),
        awayShort: awayShort.toLowerCase(),
        // Clean display name for the grouped card title
        displayName: (home && away) ? `${home} v ${away}` : (event.name || ''),
        isLive: state === 'in',
        isUpcoming: state === 'pre',
        isFinished: state === 'post',
        fixtureKey: (home && away) ? `${home.toLowerCase()}__${away.toLowerCase()}` : `tournament__${event.id}`,
      });
    }
  }

  fixtureCache = fixtures;
  const live = fixtures.filter(f => f.isLive).length;
  console.log(`Loaded ${fixtures.length} fixtures (${live} live) from ESPN`);
}

const NON_LIVE = [
  'highlights','highlight',' hl ',': hl','documentary','news','magazine',
  'preview','analysis','best of','greatest','history of',
  'end of transmission','test card','review','the loop',
  'extended','wrap','teleshopping','sport today','sportscenter',
  'classic','replay','blitz','compilation'
];

function isNonLive(title) {
  if (!title) return true;
  const t = title.toLowerCase();
  if (t === 'end of transmission') return true;
  return NON_LIVE.some(w => t.includes(w));
}

function matchFixtureStrict(title) {
  if (!title) return null;
  const t = title.toLowerCase().replace(/^[^:]+:\s*/, '');
  for (const fix of fixtureCache) {
    if (fix.name && fix.name.length > 5 && t.includes(fix.name.slice(0, 20))) return fix;
    if (fix.home && fix.away) {
      const homeWords = fix.home.split(' ').filter(w => w.length >= 6);
      const awayWords = fix.away.split(' ').filter(w => w.length >= 6);
      if (homeWords.length >= 1 && awayWords.length >= 1) {
        if (homeWords.some(w => t.includes(w)) && awayWords.some(w => t.includes(w))) return fix;
      }
    }
  }
  return null;
}

function matchFixture(title) {
  if (!title) return null;
  const t = title.toLowerCase().replace(/^[^:]+:\s*/, '');

  for (const fix of fixtureCache) {
    if (fix.name && fix.name.length > 5 && t.includes(fix.name.slice(0, 20))) return fix;
    if (fix.name && fix.name.length > 5) {
      const fixWords = fix.name.split(' ').filter(w => w.length >= 5);
      const matches = fixWords.filter(w => t.includes(w));
      if (fixWords.length >= 2 && matches.length >= 2) return fix;
      // Also try matching EPG title words against ESPN name
      const tClean = t.replace(/dp world tour|pga tour|golf|day \d+|live|round \d+/g, '').trim();
      const tWords = tClean.split(/[\s,]+/).filter(w => w.length >= 5);
      if (tWords.length >= 1 && tWords.every(w => fix.name.includes(w))) return fix;
    }

    if (fix.home && fix.away) {
      const homeWords = fix.home.split(' ').filter(w => w.length >= 5);
      const awayWords = fix.away.split(' ').filter(w => w.length >= 5);
      if (homeWords.length && awayWords.length) {
        if (homeWords.some(w => t.includes(w)) && awayWords.some(w => t.includes(w))) return fix;
      }
    }

    if (fix.homeShort && fix.awayShort) {
      const homeWords = fix.homeShort.split(' ').filter(w => w.length >= 4);
      const awayWords = fix.awayShort.split(' ').filter(w => w.length >= 4);
      if (homeWords.length && awayWords.length) {
        if (homeWords.some(w => t.includes(w)) && awayWords.some(w => t.includes(w))) return fix;
      }
    }
  }
  return null;
}

const SPORT_KEYWORDS = {
  cricket:     ['cricket','ashes','test match','ipl','indian premier league','big bash','t20','one-day','county cricket','icc','twenty20'],
  rugby_union: ['rugby union','super rugby','six nations','premiership rugby','united rugby','rugby championship','bledisloe'],
  golf:        ['dp world tour','pga tour','lpga','european tour','ryder cup','golf channel','masters','the open','liv golf','pga championship','us open golf'],
  cycling:     ['cycling','tour de france','giro','vuelta','paris-roubaix','tour down under'],
  racing:      ['supercars','v8','bathurst','nascar','indycar','motogp','formula e'],
  olympic:     ['olympic','commonwealth games','world championships','athletics','track and field'],
  tennis:      ['tennis','roland-garros','roland garros','french open','wimbledon','us open','australian open','atp','wta','grand slam','davis cup'],
  boxing:      ['boxing','wbc','wba','ibf','wbo','fight night','world title fight','heavyweight','prizefighter'],
  nrl:         ['nrl','rugby league','state of origin','national rugby league'],
  afl:         ['afl','australian football','aussie rules','vfl'],
  soccer:      ['premier league','champions league','la liga','bundesliga','serie a','ligue 1','europa league','fa cup','epl','mls','world cup','euro 2026','a-league','socceroos'],
  nba:         ['nba','basketball'],
  nfl:         ['nfl','american football','super bowl','nfl draft'],
  nhl:         ['nhl','ice hockey','stanley cup'],
  mlb:         ['mlb','baseball','world series'],
};

function keywordSport(title) {
  if (!title) return null;
  const t = title.toLowerCase();
  for (const [id, kws] of Object.entries(SPORT_KEYWORDS)) {
    if (kws.some(k => t.includes(k))) {
      const EMOJI = { cricket:'🏏', rugby_union:'🏆', golf:'⛳', cycling:'🚴', racing:'🏁', olympic:'🏅', tennis:'🎾', boxing:'🥊', nrl:'🏉', afl:'🦘', soccer:'⚽', nba:'🏀', nfl:'🏈', nhl:'🏒', mlb:'⚾' };
      return { sportId: id, emoji: EMOJI[id] || '🏟️', isLive: false, fixtureKey: null, displayName: null };
    }
  }
  // Detect superscript live characters used by EPG providers
  if (/[\u1D00-\u1DBF\u02B0-\u02FF]/.test(title)) {
    return { sportId: 'live', emoji: '🏟️', isLive: true, fixtureKey: null, displayName: null };
  }
  return null;
}

function classifyProgramme(title) {
  if (!title || isNonLive(title)) return null;
  const fix = matchFixture(title);
  if (fix) return {
    sportId: fix.sportId,
    emoji: fix.emoji,
    isLive: fix.isLive,
    fixtureKey: fix.isLive ? fix.fixtureKey : null,
    displayName: fix.isLive ? fix.displayName : null,
  };
  const kw = keywordSport(title);
  if (kw) return kw;
  return null;
}

async function refreshFixtures() {
  try {
    await fetchESPNFixtures();
  } catch(e) {
    console.error('Fixture refresh failed:', e.message);
  }
  setTimeout(refreshFixtures, 60 * 1000);
}

async function refresh() {
  try {
    console.log('Fetching fixtures first...');
    await fetchESPNFixtures();
    console.log('Fetching EPG...');
    const epgText = await axios.get(EPG_URL, { timeout: 120000, responseType: 'text' }).then(r => r.data);

    console.log('Parsing EPG XML...');
    const xml = new DOMParser().parseFromString(epgText, 'text/xml');
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
      return {
        channel: p.getAttribute('channel'),
        start: parseDate(startRaw), stop: parseDate(stopRaw), startRaw,
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
     const in24h = new Date(now.getTime() + 24*60*60*1000);
const next = progs.filter(p => p.start > now && p.start < in24h).slice(0, 2);
const upcoming = progs.filter(p => p.start > now && p.start < in24h);
      const classified = nowP ? classifyProgramme(nowP.title) : null;

      return {
        ...ch,
        now: nowP ? {
          title: nowP.title,
          desc: nowP.desc.slice(0, 150),
          startRaw: nowP.startRaw,
          pct: Math.min(100, Math.round(((now - nowP.start) / (nowP.stop - nowP.start)) * 100)),
          sport: classified,
          isLive: classified?.isLive || false,
        } : null,
      next: next.filter(p => !isNonLive(p.title)).map(p => ({
          title: p.title, desc: p.desc.slice(0, 100), startRaw: p.startRaw
        })),
        upcoming: upcoming.filter(p => !isNonLive(p.title)).map(p => {
          const fix = matchFixtureStrict(p.title);
          if (!fix || !fix.isUpcoming) return null;
          const upcomingClassified = {
            sportId: fix.sportId,
            emoji: fix.emoji,
            isLive: false,
            fixtureKey: fix.fixtureKey,
            displayName: fix.displayName,
          };
          return {
            title: p.title, desc: p.desc.slice(0, 100), startRaw: p.startRaw,
            sport: upcomingClassified,
            fixtureKey: upcomingClassified.fixtureKey,
            displayName: upcomingClassified.displayName
          };
        }).filter(Boolean)
      };
    });

    cache = deduplicateChannels(raw);
    console.log(`EPG ready — ${raw.length} → ${cache.length} channels`);
 } catch(e) {
    console.error('Refresh failed:', e.message);
    setTimeout(refresh, 2 * 60 * 1000); // retry in 2 mins on failure
    return;
  }
  setTimeout(refresh, 30 * 60 * 1000);
}

app.get('/guide', (req, res) => {
  if (!cache) return res.status(503).json({ error: 'EPG loading, retrying automatically — refresh in 2 minutes' });
  res.json(cache);
});
app.get('/fixtures', (req, res) => {
  const upcoming = fixtureCache.filter(f => f.isUpcoming);
  res.json(upcoming);
});
app.get('/refresh', async (req, res) => {
  res.json({ message: 'Refresh started' });
  refresh();
});
app.get('/debug', (req, res) => {
  if (!cache) return res.status(503).json({ error: 'not ready' });
  const q = (req.query.q || 'sky sports golf').toLowerCase();
  const ch = cache.find(c => c.name.toLowerCase().includes(q));
  res.json(ch || { error: 'channel not found' });
});

app.get('/status', (req, res) => {
  res.json({
    ready: !!cache,
    channels: cache ? cache.length : 0,
    fixtures: fixtureCache.length,
    live: fixtureCache.filter(f => f.isLive).length
  });
});

app.listen(PORT, () => {
  console.log('EPG server running on port ' + PORT);
  refresh();
  setTimeout(refreshFixtures, 60 * 1000);
});