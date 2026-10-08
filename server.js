const express = require('express');
const axios = require('axios');
const path = require('path');
const zlib = require('zlib');
const app = express();
const PORT = process.env.PORT || 3001;

// Crash handling. An uncaught exception leaves the process in an unknown state, so log
// it and exit — Railway's restart policy brings up a clean process. (Previously we kept
// running, which can leave a "zombie" that answers nothing.) Rejected promises are only
// logged: every network call already has its own error handling.
process.on('uncaughtException', (err) => {
  console.error('[FATAL uncaughtException] exiting so Railway restarts us:', err && err.stack ? err.stack : err);
  process.exit(1);
});
process.on('unhandledRejection', (reason) => {
  console.error('[unhandledRejection]', reason && reason.stack ? reason.stack : reason);
});
// Log why we're going down, so the next outage leaves evidence in the Railway logs.
process.on('SIGTERM', () => { console.error('[SIGTERM] Railway asked the container to stop'); process.exit(0); });
process.on('exit', (code) => { console.error(`[exit] process exiting with code ${code}`); });

// Lightweight memory logging at refresh boundaries (heap should stay ~100MB).
function logMem(tag) {
  const m = process.memoryUsage();
  console.log(`[mem${tag ? ' ' + tag : ''}] rss=${Math.round(m.rss/1048576)}MB heap=${Math.round(m.heapUsed/1048576)}MB`);
}

// EPG provider URL comes from the environment (contains credentials — never hardcode).
// Set EPG_URL in Railway and locally (export EPG_URL='https://.../xmltv.php?username=...').
const EPG_URL = process.env.EPG_URL;
if (!EPG_URL) console.error('FATAL: EPG_URL environment variable is not set — the EPG will not load.');
const EPG_SECONDARY_URLS = [
  { url: 'https://epgshare01.online/epgshare01/epg_ripper_AU1.xml.gz', gzip: true },
  { url: 'https://raw.githubusercontent.com/matthuisman/i.mjh.nz/master/au/Sydney/epg.xml', gzip: false },
];

// Foxtel LCN → canonical channel name (stable channel numbers)
const FOXTEL_LCN_MAP = {
  '500': 'fox sports news', '501': 'fox cricket', '502': 'fox league',
  '503': 'fox sports 503',  '504': 'fox footy',   '505': 'fox sports 505',
  '506': 'fox sports 506',  '507': 'fox sports more', '510': 'espn',
  '511': 'espn2', '520': 'sky news australia', '521': 'sky news extra',
  '522': 'sky news regional', '530': 'racing.com', '531': 'sky racing 1',
  '532': 'sky racing 2',
};
const ESPN_BASE = 'https://site.api.espn.com/apis/site/v2/sports';

const ESPN_LEAGUES = [
  { id: 'nrl',              name: 'NRL',                    url: `${ESPN_BASE}/rugby-league/3/scoreboard`,                emoji: '🏉' },
  { id: 'rugby_union_sr',   name: 'Super Rugby',            url: `${ESPN_BASE}/rugby-union/267/scoreboard`,               emoji: '🏆' },
  { id: 'rugby_union_6n',   name: 'Six Nations',            url: `${ESPN_BASE}/rugby-union/180/scoreboard`,               emoji: '🏆' },
  { id: 'rugby_union_rc',   name: 'Rugby Championship',     url: `${ESPN_BASE}/rugby-union/272/scoreboard`,               emoji: '🏆' },
  { id: 'rugby_union_pre',  name: 'Premiership Rugby',      url: `${ESPN_BASE}/rugby-union/269/scoreboard`,               emoji: '🏆' },
  { id: 'rugby_union_urc',  name: 'United Rugby Championship', url: `${ESPN_BASE}/rugby-union/270/scoreboard`,            emoji: '🏆' },
  { id: 'afl',              name: 'AFL',                    url: `${ESPN_BASE}/australian-football/afl/scoreboard`,        emoji: '🦘' },
  { id: 'nba',              name: 'NBA',                    url: `${ESPN_BASE}/basketball/nba/scoreboard`,                emoji: '🏀' },
  { id: 'nfl',              name: 'NFL',                    url: `${ESPN_BASE}/football/nfl/scoreboard`,                  emoji: '🏈' },
  { id: 'nhl',              name: 'NHL',                    url: `${ESPN_BASE}/hockey/nhl/scoreboard`,                    emoji: '🏒' },
  { id: 'mlb',              name: 'MLB',                    url: `${ESPN_BASE}/baseball/mlb/scoreboard`,                  emoji: '⚾' },
  // Leagues the Just the Tip tipsters bet that weren't followed yet ("Watch live" matching).
  { id: 'tennis_atp',       name: 'ATP',                    url: `${ESPN_BASE}/tennis/atp/scoreboard`,                    emoji: '🎾' },
  { id: 'tennis_wta',       name: 'WTA',                    url: `${ESPN_BASE}/tennis/wta/scoreboard`,                    emoji: '🎾' },
  { id: 'ncaaf',            name: 'College Football',       url: `${ESPN_BASE}/football/college-football/scoreboard?groups=80`, emoji: '🏈' },
  { id: 'wnba',             name: 'WNBA',                   url: `${ESPN_BASE}/basketball/wnba/scoreboard`,               emoji: '🏀' },
  { id: 'soccer_eng2',      name: 'EFL Championship',       url: `${ESPN_BASE}/soccer/eng.2/scoreboard`,                  emoji: '⚽' },
  { id: 'soccer_eng3',      name: 'EFL League One',         url: `${ESPN_BASE}/soccer/eng.3/scoreboard`,                  emoji: '⚽' },
  { id: 'soccer_eng4',      name: 'EFL League Two',         url: `${ESPN_BASE}/soccer/eng.4/scoreboard`,                  emoji: '⚽' },
  { id: 'soccer_jpn',       name: 'J1 League',              url: `${ESPN_BASE}/soccer/jpn.1/scoreboard`,                  emoji: '⚽' },
  { id: 'soccer_ger2',      name: '2. Bundesliga',          url: `${ESPN_BASE}/soccer/ger.2/scoreboard`,                  emoji: '⚽' },
  { id: 'soccer_epl',       name: 'Premier League',         url: `${ESPN_BASE}/soccer/eng.1/scoreboard`,                  emoji: '⚽' },
  { id: 'soccer_ucl',       name: 'UEFA Champions League',  url: `${ESPN_BASE}/soccer/uefa.champions/scoreboard`,         emoji: '⚽' },
  { id: 'soccer_uel',       name: 'UEFA Europa League',     url: `${ESPN_BASE}/soccer/uefa.europa/scoreboard`,            emoji: '⚽' },
  { id: 'soccer_uecl',      name: 'UEFA Conference League', url: `${ESPN_BASE}/soccer/uefa.europa.conf/scoreboard`,       emoji: '⚽' },
  { id: 'soccer_mls',       name: 'MLS',                    url: `${ESPN_BASE}/soccer/usa.1/scoreboard`,                  emoji: '⚽' },
  { id: 'soccer_esp',       name: 'La Liga',                url: `${ESPN_BASE}/soccer/esp.1/scoreboard`,                  emoji: '⚽' },
  { id: 'soccer_ger',       name: 'Bundesliga',             url: `${ESPN_BASE}/soccer/ger.1/scoreboard`,                  emoji: '⚽' },
  { id: 'soccer_ita',       name: 'Serie A',                url: `${ESPN_BASE}/soccer/ita.1/scoreboard`,                  emoji: '⚽' },
  { id: 'soccer_aus',       name: 'A-League',               url: `${ESPN_BASE}/soccer/aus.1/scoreboard`,                  emoji: '⚽' },
  { id: 'soccer_fra',       name: 'Ligue 1',                url: `${ESPN_BASE}/soccer/fra.1/scoreboard`,                  emoji: '⚽' },
  { id: 'soccer_facup',     name: 'FA Cup',                 url: `${ESPN_BASE}/soccer/eng.fa/scoreboard`,                 emoji: '⚽' },
  { id: 'soccer_efl',       name: 'EFL Cup',                url: `${ESPN_BASE}/soccer/eng.league_cup/scoreboard`,         emoji: '⚽' },
  { id: 'soccer_nations',   name: 'UEFA Nations League',    url: `${ESPN_BASE}/soccer/uefa.nations/scoreboard`,           emoji: '⚽' },
  { id: 'soccer_world',     name: 'FIFA World Cup',         url: `${ESPN_BASE}/soccer/fifa.world/scoreboard`,             emoji: '⚽' },
  { id: 'soccer_euro',      name: 'UEFA Euro',              url: `${ESPN_BASE}/soccer/uefa.euro/scoreboard`,              emoji: '⚽' },
  { id: 'soccer_copa',      name: 'Copa América',           url: `${ESPN_BASE}/soccer/conmebol.copa/scoreboard`,          emoji: '⚽' },
  { id: 'soccer_afc',       name: 'AFC Asian Cup',          url: `${ESPN_BASE}/soccer/afc.asian.cup/scoreboard`,          emoji: '⚽' },
  { id: 'soccer_gold',      name: 'CONCACAF Gold Cup',      url: `${ESPN_BASE}/soccer/concacaf.gold/scoreboard`,          emoji: '⚽' },
  { id: 'soccer_wc_qual_eu',name: 'World Cup Qualifying',   url: `${ESPN_BASE}/soccer/fifa.worldq.europe/scoreboard`,     emoji: '⚽' },
  { id: 'soccer_friendly',  name: 'International Friendly', url: `${ESPN_BASE}/soccer/fifa.friendly/scoreboard`,          emoji: '⚽' },
  { id: 'soccer_friendly_m',name: 'International Friendly', url: `${ESPN_BASE}/soccer/fifa.friendly.m/scoreboard`,        emoji: '⚽' },
  { id: 'golf_pga',         name: 'PGA Tour',               url: `${ESPN_BASE}/golf/pga/scoreboard`,                      emoji: '⛳' },
  { id: 'golf_eur',         name: 'DP World Tour',          url: `${ESPN_BASE}/golf/eur/scoreboard`,                      emoji: '⛳' },
  { id: 'mma',              name: 'UFC',                    url: `${ESPN_BASE}/mma/ufc/scoreboard`,                       emoji: '🥊' },
  { id: 'f1',               name: 'Formula 1',              url: `${ESPN_BASE}/racing/f1/scoreboard`,                     emoji: '🏎️' },
];

const LEAGUE_TO_SPORT = {
  nrl: 'nrl',
  rugby_union_sr: 'rugby_union', rugby_union_6n: 'rugby_union',
  rugby_union_rc: 'rugby_union', rugby_union_pre: 'rugby_union', rugby_union_urc: 'rugby_union',
  afl: 'afl',
  nba: 'nba',
  nfl: 'nfl',
  nhl: 'ice_hockey',
  mlb: 'baseball',
  ncaaf: 'nfl', wnba: 'nba', tennis_atp: 'tennis', tennis_wta: 'tennis',
  soccer_eng2: 'soccer', soccer_eng3: 'soccer', soccer_eng4: 'soccer', soccer_jpn: 'soccer', soccer_ger2: 'soccer',
  soccer_epl: 'soccer', soccer_ucl: 'soccer', soccer_uel: 'soccer', soccer_uecl: 'soccer',
  soccer_mls: 'soccer', soccer_esp: 'soccer', soccer_ger: 'soccer', soccer_ita: 'soccer',
  soccer_aus: 'soccer', soccer_fra: 'soccer', soccer_facup: 'soccer', soccer_efl: 'soccer',
  soccer_nations: 'soccer', soccer_world: 'soccer', soccer_euro: 'soccer',
  soccer_copa: 'soccer', soccer_afc: 'soccer', soccer_gold: 'soccer', soccer_wc_qual_eu: 'soccer',
  soccer_friendly: 'soccer', soccer_friendly_m: 'soccer',
  golf_pga: 'golf', golf_eur: 'golf',
  mma: 'boxing',
  f1: 'f1',
};

app.use((req, res, next) => {
  // The guide is public; the /api/watch routes are server-to-server only.
  if (!req.path.startsWith('/api/')) res.header('Access-Control-Allow-Origin', '*');
  next();
});
// Only serve the front-end files. Serving the whole folder exposed server.js,
// package.json etc. to anyone who asked for them.
const PUBLIC_FILES = new Set(['/', '/index.html', '/manifest.json', '/icon-180.png', '/icon-512.png']);
const serveStatic = express.static(path.join(__dirname));
app.use((req, res, next) => PUBLIC_FILES.has(req.path) ? serveStatic(req, res, next) : next());

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

// This is a live-sport app: dedicated sport channels are the ones worth keeping.
// A name match here means we retain the channel even when its current programme
// doesn't classify (e.g. a talk show on Fox League at 3am).
const SPORT_CHANNEL_RE = new RegExp([
  'sport', 'fox footy', 'fox league', 'fox cricket', 'fox sports', 'sky sport',
  'espn', 'bein', 'tnt sport', 'eurosport', 'kayo', 'optus sport', 'stan sport',
  'premier sport', 'supersport', 'dazn', 'viaplay', 'willow', 'racing', 'golf',
  'nba tv', 'nba league', ' nfl', ' mlb', ' nhl', 'motorsport', 'sky racing',
  'setanta', 'ssc', 'flosports', 'bt sport'
].join('|'), 'i');

function isSportChannelName(name) {
  return SPORT_CHANNEL_RE.test(normaliseChannelName(name));
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
    result.push({
      ...best, quality: getQualityLabel(best.name), displayName, variants: group.length,
      variantIds: group.map(ch => ({ id: ch.id, quality: getQualityLabel(ch.name) })),
    });
  }
  return result;
}

// Run async tasks in small batches to cap concurrency (avoids a request storm)
async function runBatched(items, worker, batchSize = 8) {
  const out = [];
  for (let i = 0; i < items.length; i += batchSize) {
    const slice = items.slice(i, i + batchSize);
    out.push(...await Promise.all(slice.map(worker)));
  }
  return out;
}

// Dated queries change slowly (upcoming schedule); cache them and refresh only occasionally.
let datedFixturesRaw = [];
let lastDatedFetch = 0;

// full=true also refreshes the dated (upcoming) queries; otherwise only the live scoreboard.
async function fetchESPNFixtures(full = false) {
  const d = (offset) => {
    const dt = new Date(Date.now() + offset * 864e5);
    return dt.toISOString().slice(0,10).replace(/-/g,'');
  };

  // Always fetch the plain scoreboard for every league — this reflects true LIVE state.
  const plainResults = await runBatched(ESPN_LEAGUES, league =>
    axios.get(league.url, { timeout: 10000 })
      .then(res => ({ league, data: res.data }))
      .catch(() => null)
  );

  // Refresh dated (upcoming) queries only on a full pass, or if we have none yet.
  if (full || !datedFixturesRaw.length || Date.now() - lastDatedFetch > 15 * 60 * 1000) {
    const dates = [d(0), d(1), d(2)]; // today + next 2 days
    const datedReqs = ESPN_LEAGUES.flatMap(league =>
      dates.map(date => ({ league, url: `${league.url}${league.url.includes('?') ? '&' : '?'}dates=${date}` }))
    );
    const datedResults = await runBatched(datedReqs, ({ league, url }) =>
      axios.get(url, { timeout: 10000 })
        .then(res => ({ league, data: res.data }))
        .catch(() => null)
    );
    datedFixturesRaw = datedResults.filter(Boolean);
    lastDatedFetch = Date.now();
  }

  const allResults = [...plainResults.filter(Boolean), ...datedFixturesRaw];
  const fixtures = [];

  for (const result of allResults) {
    if (!result) continue;
    const { league, data } = result;
    const events = data?.events || [];
    const sportId = LEAGUE_TO_SPORT[league.id] || league.id;

    if (sportId === 'tennis') {
      const leagueSlug = (league.url.split('/sports/')[1] || '').replace(/\/scoreboard.*$/, '');
      const recent = Date.now() - 24 * 60 * 60 * 1000, soon = Date.now() + 3 * 24 * 60 * 60 * 1000;
      for (const event of events) {
        for (const grouping of event.groupings || []) {
          for (const comp of grouping.competitions || []) {
            const names = (comp.competitors || []).map(c => (c.athlete || c.roster || {}).displayName || '');
            if (names.length !== 2 || !names[0] || !names[1]) continue;
            const t = comp.date ? new Date(comp.date).getTime() : NaN;
            if (isNaN(t) || t < recent || t > soon) continue;
            const state = comp.status?.type?.state;
            const surname = n => n.split('/').map(x => x.trim().split(' ').slice(-1)[0]).join(' / ');
            fixtures.push({
              sportId, league: leagueSlug, emoji: league.emoji,
              name: `${names[0]} v ${names[1]}`.toLowerCase(), shortName: '',
              home: names[0].toLowerCase(), away: names[1].toLowerCase(),
              homeShort: surname(names[0]).toLowerCase(), awayShort: surname(names[1]).toLowerCase(),
              displayName: `${names[0]} v ${names[1]}`,
              homeLogo: '', awayLogo: '', homeColor: null, awayColor: null,
              espnDesc: [event.name, grouping.grouping?.displayName, comp.round?.displayName].filter(Boolean).join(' · '),
              tournament: event.name || '', court: comp.venue?.court || '',
              isLive: state === 'in', isUpcoming: state === 'pre', isFinished: state === 'post',
              fixtureKey: `tennis__${comp.id}`, espnStartTime: comp.date,
            });
          }
        }
      }
      continue;
    }

    for (const event of events) {
      const state = event.status?.type?.state;
      const competitors = event.competitions?.[0]?.competitors || [];
      const homeTeam = competitors.find(c => c.homeAway === 'home')?.team || {};
      const awayTeam = competitors.find(c => c.homeAway === 'away')?.team || {};
      const home = homeTeam.displayName || '';
      const away = awayTeam.displayName || '';
      const homeShort = homeTeam.shortDisplayName || '';
      const awayShort = awayTeam.shortDisplayName || '';
      const homeLogo = homeTeam.logos?.[0]?.href || homeTeam.logo || '';
      const awayLogo = awayTeam.logos?.[0]?.href || awayTeam.logo || '';
      const homeColor = homeTeam.color ? `#${homeTeam.color}` : null;
      const awayColor = awayTeam.color ? `#${awayTeam.color}` : null;
      const notes = event.competitions?.[0]?.notes || [];
      const espnDesc = notes[0]?.headline || '';

      fixtures.push({
        sportId,
        league: (league.url.split('/sports/')[1] || '').replace(/\/scoreboard.*$/, ''),
        emoji: league.emoji,
        name: (event.name || '').toLowerCase(),
        shortName: (event.shortName || '').toLowerCase(),
        home: home.toLowerCase(),
        away: away.toLowerCase(),
        homeShort: homeShort.toLowerCase(),
        awayShort: awayShort.toLowerCase(),
        displayName: (home && away) ? `${home} v ${away}` : (event.name || ''),
        homeLogo,
        awayLogo,
        homeColor,
        awayColor,
        espnDesc,
        isLive: state === 'in',
        isUpcoming: state === 'pre',
        isFinished: state === 'post',
        fixtureKey: (home && away) ? `${home.toLowerCase()}__${away.toLowerCase()}` : `tournament__${event.id}`,
        espnStartTime: event.competitions?.[0]?.date || null,
      });
    }
  }

  // Deduplicate by fixtureKey — same game can appear across multiple date queries
  // (playoff series return projected future dates). Prefer live, then earliest start.
  const byKey = {};
  for (const f of fixtures) {
    const existing = byKey[f.fixtureKey];
    if (!existing) { byKey[f.fixtureKey] = f; continue; }
    // Live always wins
    if (f.isLive && !existing.isLive) { byKey[f.fixtureKey] = f; continue; }
    if (!f.isLive && existing.isLive) continue;
    // Otherwise keep the earliest scheduled start
    const ft = f.espnStartTime ? new Date(f.espnStartTime).getTime() : Infinity;
    const et = existing.espnStartTime ? new Date(existing.espnStartTime).getTime() : Infinity;
    if (ft < et) byKey[f.fixtureKey] = f;
  }
  fixtureCache = Object.values(byKey);
  const live = fixtureCache.filter(f => f.isLive).length;
  console.log(`Loaded ${fixtureCache.length} fixtures (${live} live) from ESPN`);
}

const NON_LIVE = [
  'highlights','highlight',' hl ',': hl','documentary','news','magazine',
  'preview','analysis','best of','greatest','history of',
  'end of transmission','test card','review','the loop',
  'extended','wrap','teleshopping','sport today','sportscenter',
  'classic','replay','blitz','compilation',
  '(mw','matchweek','match day replay','season replay','match of the day',
];

function isNonLive(title) {
  if (!title) return true;
  const t = title.toLowerCase();
  if (t === 'end of transmission') return true;
  return NON_LIVE.some(w => t.includes(w));
}

function stripAccents(s) {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '');
}

// Words that appear in lots of team names and so can't identify a team on their own
// (otherwise "Newcastle United v Man City" matches "Leeds United v Manchester City").
const GENERIC_TEAM_WORDS = new Set([
  'united','city','town','county','real','club','athletic','athletico','sporting','rovers',
  'wanderers','albion','state','north','south','east','west','saint','team','national',
  'football','soccer','rugby','women','under',
]);

// Distinctive words (4+ letters, not generic) from an ESPN team name
function teamWords(name) {
  return stripAccents(name || '').split(/[^a-z0-9]+/).filter(w => w.length >= 4 && !GENERIC_TEAM_WORDS.has(w));
}

// National-team nicknames → the country name ESPN uses, so "Socceroos v Brazil"
// matches ESPN's "Brazil at Australia" (and marks it live). Unambiguous names only.
const TEAM_NICKNAMES = [
  [/\bsocceroos\b/g, 'australia'], [/\bmatildas\b/g, 'australia'],
  [/\bwallabies\b/g, 'australia'], [/\ball blacks\b/g, 'new zealand'],
  [/\bselecao\b/g, 'brazil'], [/\bazzurri\b/g, 'italy'],
  [/\bla roja\b/g, 'spain'], [/\bles bleus\b/g, 'france'],
  [/\bthree lions\b/g, 'england'], [/\boranje\b/g, 'netherlands'],
];
function normFixtureTitle(title) {
  let t = stripAccents(title.toLowerCase().replace(/^[^:]+:\s*/, ''));
  for (const [re, name] of TEAM_NICKNAMES) t = t.replace(re, name);
  return t;
}

// Title as " word word word " so we can test whole words ("roma" must not match "romania")
function titleWords(title) {
  const t = normFixtureTitle(title);
  return { t, padded: ' ' + t.replace(/[^a-z0-9]+/g, ' ') + ' ' };
}
const hasWord = (padded, w) => padded.includes(' ' + w + ' ');

// Does the title mention this team? Uses a distinctive word ("roosters"), or, when a name
// has none ("Man City"), the whole name as a phrase.
function teamMentioned(padded, name) {
  const words = teamWords(name);
  if (words.length) return words.some(w => hasWord(padded, w));
  const phrase = stripAccents(name || '').replace(/[^a-z0-9]+/g, ' ').trim();
  return phrase.length >= 4 && hasWord(padded, phrase);
}

function teamsMatch(padded, homeName, awayName) {
  return teamMentioned(padded, homeName) && teamMentioned(padded, awayName);
}

// Ignore fixtures more than 12h from the programme's start (stops replays of last
// night's game, or next week's fixture between the same teams, from matching).
// Only for team-v-team games: golf/F1 events span days, so their start time is no guide.
function tooFarApart(fix, progStart) {
  if (!fix.home || !fix.away) return false;
  return progStart && fix.espnStartTime && Math.abs(new Date(fix.espnStartTime) - progStart) > 12 * 60 * 60 * 1000;
}

function matchFixtureStrict(title, progStart) {
  if (!title) return null;
  const { t, padded } = titleWords(title);
  for (const fix of fixtureCache) {
    if (tooFarApart(fix, progStart)) continue;
    if (fix.name && fix.name.length > 5 && t.includes(fix.name.slice(0, 20))) return fix;
    if (fix.home && fix.away && teamsMatch(padded, fix.home, fix.away)) return fix;
  }
  return null;
}

function matchFixture(title, progStart) {
  if (!title) return null;
  const { t, padded } = titleWords(title);

  for (const fix of fixtureCache) {
    if (tooFarApart(fix, progStart)) continue;
    if (fix.name && fix.name.length > 5 && t.includes(fix.name.slice(0, 20))) return fix;
    // Loose word matching on the event name — only for events without two teams
    // (golf, F1, UFC cards). Team games use the stricter team-name check below.
    if (fix.name && fix.name.length > 5 && !(fix.home && fix.away)) {
      const fixWords = fix.name.split(' ').filter(w => w.length >= 4);
      const matches = fixWords.filter(w => t.includes(w));
      if (fixWords.length >= 2 && matches.length >= 2) return fix;
      // Also try matching EPG title words against ESPN name
      const tClean = t.replace(/dp world tour|pga tour|golf|day \d+|live|round \d+/g, '').trim();
      const tWords = tClean.split(/[\s,]+/).filter(w => w.length >= 5);
      if (tWords.length >= 1 && tWords.every(w => fix.name.includes(w))) return fix;
    }

    if (fix.home && fix.away && teamsMatch(padded, fix.home, fix.away)) return fix;
    if (fix.homeShort && fix.awayShort && teamsMatch(padded, fix.homeShort, fix.awayShort)) return fix;
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

  boxing:      ['boxing','wbc','wba','ibf','wbo','fight night','world title fight','heavyweight','prizefighter'],
  nrl:         ['nrl','rugby league','state of origin','national rugby league'],
  afl:         ['afl','australian football','aussie rules','vfl'],
  soccer:      ['premier league','champions league','la liga','bundesliga','serie a','ligue 1','europa league','fa cup','epl','mls','world cup','euro 2026','a-league','socceroos'],
  nba:         ['nba','basketball'],
  nfl:         ['nfl','american football','super bowl','nfl draft'],
  nhl:         ['nhl','ice hockey','stanley cup'],
  mlb:         ['mlb','baseball','world series'],
};

// Whole-word matching, so "masters" doesn't catch "MasterChef" and "afl" doesn't
// match inside another word.
const escapeRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const SPORT_KEYWORD_RES = Object.entries(SPORT_KEYWORDS).map(([id, kws]) =>
  [id, new RegExp('\\b(?:' + kws.map(escapeRe).join('|') + ')\\b', 'i')]);
const SPORT_EMOJI = { cricket:'🏏', rugby_union:'🏆', golf:'⛳', cycling:'🚴', racing:'🏁', olympic:'🏅', tennis:'🎾', boxing:'🥊', nrl:'🏉', afl:'🦘', soccer:'⚽', nba:'🏀', nfl:'🏈', nhl:'🏒', mlb:'⚾' };

function keywordSport(title) {
  if (!title) return null;
  for (const [id, re] of SPORT_KEYWORD_RES) {
    if (re.test(title)) {
      return { sportId: id, emoji: SPORT_EMOJI[id] || '🏟️', isLive: false, fixtureKey: null, displayName: null };
    }
  }
  // Detect superscript live characters used by EPG providers
  if (/[\u1D00-\u1DBF\u02B0-\u02FF]/.test(title)) {
    return { sportId: 'live', emoji: '🏟️', isLive: true, fixtureKey: null, displayName: null };
  }
  return null;
}

function classifyProgramme(title, progStart) {
  if (!title || isNonLive(title)) return null;
  const fix = matchFixture(title, progStart);
  if (fix) return {
    sportId: fix.sportId,
    emoji: fix.emoji,
    isLive: fix.isLive,
    fixtureKey: fix.isLive ? fix.fixtureKey : null,
    displayName: fix.isLive ? fix.displayName : null,
    homeLogo: fix.isLive ? fix.homeLogo : null,
    awayLogo: fix.isLive ? fix.awayLogo : null,
    homeColor: fix.homeColor || null,
    awayColor: fix.awayColor || null,
    espnDesc: fix.espnDesc || null,
  };
  const kw = keywordSport(title);
  if (kw) return kw;
  return null;
}

function buildChannelData(ch, progs, now) {
  const sorted = progs.slice().sort((a,b) => a.start - b.start);
  const nowP = sorted.find(p => p.start <= now && p.stop > now);
  const in24h = new Date(now.getTime() + 24*60*60*1000);
  const next = sorted.filter(p => p.start > now && p.start < in24h).slice(0, 2);
  const upcoming = sorted.filter(p => p.start > now && p.start < in24h);
  const classified = nowP ? classifyProgramme(nowP.title, nowP.start) : null;
  return {
    ...ch,
    now: nowP ? {
      title: nowP.title, desc: nowP.desc.slice(0, 150), startRaw: nowP.startRaw,
      pct: Math.min(100, Math.round(((now - nowP.start) / (nowP.stop - nowP.start)) * 100)),
      sport: classified, isLive: classified?.isLive || false,
    } : null,
    next: next.filter(p => !isNonLive(p.title)).map(p => ({ title: p.title, desc: p.desc.slice(0, 100), startRaw: p.startRaw })),
    upcoming: upcoming.filter(p => !isNonLive(p.title)).map(p => {
      const fix = matchFixtureStrict(p.title, p.start);
      if (fix && fix.isUpcoming) {
        const sport = { sportId: fix.sportId, emoji: fix.emoji, isLive: false, fixtureKey: fix.fixtureKey, displayName: fix.displayName, homeLogo: fix.homeLogo, awayLogo: fix.awayLogo, homeColor: fix.homeColor || null, awayColor: fix.awayColor || null, espnDesc: fix.espnDesc || null };
        return { title: p.title, desc: p.desc.slice(0, 100), startRaw: p.startRaw, sport, fixtureKey: sport.fixtureKey, displayName: sport.displayName, espnStartTime: fix.espnStartTime || null };
      }
      return null;
    }).filter(Boolean)
  };
}

// ---------------------------------------------------------------------------
// Streaming XMLTV parsing
// The provider EPG is 50-100MB. Downloading it into one big string and running regexes
// over it is what made memory jump by hundreds of MB on every refresh. Instead we parse
// <channel> and <programme> elements as the download arrives, only ever holding the
// small unfinished tail of the stream in memory.
// ---------------------------------------------------------------------------
const { StringDecoder } = require('string_decoder');
const ELEMENT_RE = /<channel\s([^>]*)>([\s\S]*?)<\/channel>|<programme\b([^>]+)>([\s\S]*?)<\/programme>/g;
const MAX_TAIL = 4 * 1024 * 1024; // a single element is never anywhere near this big

function parseXmltvStream(readable, { onChannel, onProgramme }) {
  return new Promise((resolve, reject) => {
    const decoder = new StringDecoder('utf8');
    let buf = '';
    let first = true;
    const handle = (str) => {
      buf += str;
      if (first && buf.length) { buf = buf.replace(/^﻿/, ''); first = false; }
      ELEMENT_RE.lastIndex = 0;
      let m, last = 0;
      while ((m = ELEMENT_RE.exec(buf)) !== null) {
        if (m[1] !== undefined) onChannel(m[1], m[2]);
        else onProgramme(m[3], m[4]);
        last = ELEMENT_RE.lastIndex;
      }
      buf = buf.slice(last);
      if (buf.length > MAX_TAIL) {
        console.warn('XMLTV parser: skipping an oversized unparseable chunk');
        buf = buf.slice(-64 * 1024);
      }
    };
    readable.on('data', c => { try { handle(typeof c === 'string' ? c : decoder.write(c)); } catch (e) { readable.destroy(e); } });
    readable.on('end', () => { try { handle(decoder.end()); resolve(); } catch (e) { reject(e); } });
    readable.on('error', reject);
  });
}

// Download an XMLTV feed and parse it as it streams in. timeoutMs caps the whole download.
async function streamXmltvFromUrl(url, { gzip = false, timeoutMs = 180000 } = {}, handlers) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await axios.get(url, { responseType: 'stream', signal: ctrl.signal, timeout: 60000 });
    const body = res.data;
    ctrl.signal.addEventListener('abort', () => body.destroy(new Error(`download took longer than ${timeoutMs / 1000}s`)));
    let stream = body;
    if (gzip) {
      stream = body.pipe(zlib.createGunzip());
      body.on('error', e => stream.destroy(e));
    }
    await parseXmltvStream(stream, handlers);
  } finally {
    clearTimeout(timer);
  }
}

const attr = (attrs, name) => (attrs.match(new RegExp('\\b' + name + '="([^"]+)"')) || [])[1];

// ---------------------------------------------------------------------------
// Secondary EPG (fills Foxtel sport channels the provider has no data for).
// These schedules barely change, so download them every few hours, not every refresh.
// ---------------------------------------------------------------------------
const SECONDARY_REFRESH_MS = 3 * 60 * 60 * 1000;
let secondaryCache = null;     // { byName, byLcn }
let secondaryFetchedAt = 0;

async function loadSecondaryEPG() {
  const byName = {}, byLcn = {};
  const now = new Date();
  const cutoff = new Date(now.getTime() + 26 * 60 * 60 * 1000);

  for (const { url, gzip } of EPG_SECONDARY_URLS) {
    const idToName = {}, idToLcn = {};
    const srcByName = {}, srcByLcn = {};
    let progCount = 0;
    try {
      await streamXmltvFromUrl(url, { gzip, timeoutMs: 90000 }, {
        onChannel(attrs, block) {
          const id = attr(attrs, 'id');
          const nm = block.match(/<display-name[^>]*>([^<]+)<\/display-name>/);
          const lc = block.match(/<lcn[^>]*>(\d+)<\/lcn>/);
          if (id && nm) { idToName[id] = normaliseChannelName(nm[1]); if (lc) idToLcn[id] = lc[1]; }
        },
        onProgramme(attrs, body) {
          const chId = attr(attrs, 'channel'), startRaw = attr(attrs, 'start'), stopRaw = attr(attrs, 'stop');
          if (!chId || !startRaw || !stopRaw) return;
          const name = idToName[chId];
          if (!name) return;
          const start = parseDate(startRaw), stop = parseDate(stopRaw);
          if (!start || !stop || stop < now || start > cutoff) return; // same 26h window as primary
          const tm = body.match(/<title[^>]*>([^<]+)<\/title>/);
          if (!tm) return;
          const title = tm[1].trim();
          if (!title || /^no listing|^no data|^tba$|^tbd$/i.test(title)) return;
          const dm = body.match(/<desc[^>]*>([^<]+)<\/desc>/);
          const prog = { start, stop, startRaw, title, desc: dm ? dm[1].trim().slice(0, 150) : '' };
          (srcByName[name] ||= []).push(prog);
          const lcn = idToLcn[chId];
          if (lcn) (srcByLcn[lcn] ||= []).push(prog);
          progCount++;
        },
      });
      for (const [k, v] of Object.entries(srcByName)) if (!byName[k]) byName[k] = v;
      for (const [k, v] of Object.entries(srcByLcn)) if (!byLcn[k]) byLcn[k] = v;
      console.log(`Secondary EPG loaded: ${url.split('/').pop()} — ${Object.keys(idToName).length} channels, ${progCount} programmes in window`);
    } catch (e) {
      console.error(`Secondary EPG failed (${url.split('/').pop()}):`, e.message);
    }
  }
  return { byName, byLcn };
}

async function fillSecondaryEPG() {
  const needFill = cache.filter(ch => !ch.now && !ch.next?.length);
  if (!needFill.length) return;

  if (!secondaryCache || Date.now() - secondaryFetchedAt > SECONDARY_REFRESH_MS) {
    console.log('Secondary EPG: downloading...');
    const fresh = await loadSecondaryEPG();
    if (Object.keys(fresh.byName).length) { secondaryCache = fresh; secondaryFetchedAt = Date.now(); }
  }
  if (!secondaryCache) return;
  const { byName: secondaryByName, byLcn: secondaryByLcn } = secondaryCache;

  const secondaryNames = Object.keys(secondaryByName);
  function findSecondaryProgs(normName) {
    if (secondaryByName[normName]) return secondaryByName[normName];
    const numMatch = normName.match(/\b(\d{3,4})\b/);
    if (numMatch) {
      const canonName = FOXTEL_LCN_MAP[numMatch[1]];
      if (canonName && secondaryByName[canonName]) return secondaryByName[canonName];
      if (secondaryByLcn[numMatch[1]]?.length) return secondaryByLcn[numMatch[1]];
    }
    const match = secondaryNames.find(n => normName.includes(n) || n.includes(normName));
    return match ? secondaryByName[match] : null;
  }

  const now = new Date();
  let filled = 0;
  cache = cache.map(ch => {
    if (ch.now || ch.next?.length) return ch;
    const secProgs = findSecondaryProgs(normaliseChannelName(ch.name));
    if (!secProgs?.length) return ch;
    filled++;
    return buildChannelData(ch, secProgs, now);
  });
  console.log(`Secondary EPG: filled ${filled} of ${needFill.length} empty channels`);
}

async function refreshFixtures() {
  try {
    await fetchESPNFixtures(false); // light: live scoreboard only (dated queries reused from cache)
  } catch(e) {
    console.error('Fixture refresh failed:', e.message);
  }
  setTimeout(refreshFixtures, 3 * 60 * 1000);
}

// ---------------------------------------------------------------------------
// Main EPG refresh. Exactly ONE refresh loop ever runs: a refresh already in progress
// is never started twice, and there is only ever one pending timer. (Previously every
// hit on /refresh started an extra loop that ran forever alongside the original.)
// ---------------------------------------------------------------------------
let refreshing = false;
let refreshTimer = null;
let lastRefreshStarted = 0;
let lastRefreshOk = 0;

function scheduleRefresh(ms) {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(refresh, ms);
}

async function refresh() {
  if (refreshing) { console.log('Refresh already running — skipped'); return; }
  refreshing = true;
  lastRefreshStarted = Date.now();
  let nextInMs = 30 * 60 * 1000;
  try {
    if (!EPG_URL) throw new Error('EPG_URL environment variable is not set');
    logMem('refresh:start');
    console.log('Fetching fixtures first...');
    await fetchESPNFixtures(true); // full: refresh dated upcoming queries too

    const now = new Date();
    // App only uses "now" + next 24h; keep a small buffer.
    const cutoff = new Date(now.getTime() + 26 * 60 * 60 * 1000);
    const channels = [];
    const progsByChannel = {};
    const sportChannelIds = new Set(); // ids of dedicated sport channels (by name)
    // Only titles that look like "X v Y" are checked against ESPN fixtures — cheap, and it
    // stops movies like "Alien vs Predator" dragging channels in.
    const fixturePattern = /\bv(?:s|ersus)?\.?\b/i;
    let scanned = 0;

    console.log('Fetching + parsing EPG (streaming)...');
    await streamXmltvFromUrl(EPG_URL, { timeoutMs: 5 * 60 * 1000 }, {
      onChannel(attrs, blk) {
        const id = attr(attrs, 'id');
        const nm = blk.match(/<display-name[^>]*>([^<]+)<\/display-name>/);
        if (!id || !nm) return;
        const lg = blk.match(/<icon\s[^>]*src="([^"]+)"/);
        const la = blk.match(/<display-name[^>]*\slang="([^"]*)"/);
        const name = nm[1].trim();
        channels.push({ id, name, logo: lg ? lg[1] : '', lang: la ? la[1] : '' });
        if (isSportChannelName(name)) sportChannelIds.add(id);
      },
      onProgramme(attrs, body) {
        const chId = attr(attrs, 'channel'), startRaw = attr(attrs, 'start'), stopRaw = attr(attrs, 'stop');
        if (!chId || !startRaw || !stopRaw) return;
        const start = parseDate(startRaw), stop = parseDate(stopRaw);
        if (!start || !stop || stop < now || start > cutoff) return;
        const tm = body.match(/<title[^>]*>([^<]+)<\/title>/);
        if (!tm) return;
        const title = tm[1].trim();
        scanned++;
        // Keep only sport-relevant programmes: on a dedicated sport channel, keyword-classified
        // as sport, or a "v"/"vs" title that matches a real ESPN fixture.
        const keep = sportChannelIds.has(chId)
          || keywordSport(title)
          || (fixturePattern.test(title) && matchFixtureStrict(title, start));
        if (!keep) return;
        const dm = body.match(/<desc[^>]*>([\s\S]*?)<\/desc>/);
        (progsByChannel[chId] ||= []).push({ channel: chId, start, stop, startRaw, title, desc: dm ? dm[1].trim().slice(0, 150) : '' });
      },
    });
    if (!channels.length) throw new Error('EPG download contained no channels (provider down or credentials rejected?)');

    // Candidate set: dedicated sport channels + any channel with a retained programme.
    const candidates = channels.filter(ch => sportChannelIds.has(ch.id) || (progsByChannel[ch.id] || []).length);
    const built = candidates.map(ch => buildChannelData(ch, progsByChannel[ch.id] || [], now));

    // Final cache: channels actually showing/about-to-show sport, plus dedicated sport
    // channels (kept between events so they're present when a game starts, and so the
    // secondary EPG can fill Fox 502/504 etc.).
    const raw = built.filter(d => d.now?.sport || (d.upcoming && d.upcoming.length) || isSportChannelName(d.name));
    console.log(`Parsed ${channels.length} channels / ${scanned} programmes → ${candidates.length} candidates → ${raw.length} sport channels in cache`);

    cache = deduplicateChannels(raw);
    lastRefreshOk = Date.now();
    console.log(`EPG ready — ${raw.length} → ${cache.length} channels`);
    logMem('refresh:done');

    try {
      await fillSecondaryEPG();
      logMem('secondary:done');
    } catch (e) {
      console.error('Secondary EPG error:', e.message);
    }
  } catch (e) {
    console.error('Refresh failed:', e.message);
    nextInMs = 2 * 60 * 1000; // retry soon; the last good guide keeps being served meanwhile
  } finally {
    refreshing = false;
    scheduleRefresh(nextInMs);
  }
}

app.get('/guide', (req, res) => {
  if (!cache) return res.status(503).json({ error: 'EPG loading, retrying automatically — refresh in 2 minutes' });
  res.json(cache);
});
app.get('/fixtures', (req, res) => {
  const upcoming = fixtureCache.filter(f => f.isUpcoming);
  res.json(upcoming);
});
// Manual refresh. Public, so it's rate-limited and can never start a second loop.
app.get('/refresh', (req, res) => {
  if (refreshing) return res.json({ message: 'Refresh already running' });
  if (Date.now() - lastRefreshStarted < 5 * 60 * 1000) {
    return res.status(429).json({ message: 'Refreshed less than 5 minutes ago — try again shortly' });
  }
  res.json({ message: 'Refresh started' });
  refresh();
});

// ---------------------------------------------------------------------------
// Watch API — private, server-to-server, for the Just the Tip picks app.
// Finds the channels showing a given fixture and hands out a stream URL on request.
// Every route needs the X-Watch-Key header to equal WATCH_API_KEY; the IPTV login
// (taken from EPG_URL — same Xtream panel) never leaves this server except inside the
// stream URL returned to an authorised caller.
// ---------------------------------------------------------------------------
const crypto = require('crypto');
const WATCH_API_KEY = process.env.WATCH_API_KEY || '';
const STREAMS_REFRESH_MS = 6 * 60 * 60 * 1000;
let streamsByEpgId = new Map(); // XMLTV channel id -> [{ id, name }]
let streamIds = new Set();
let streamsLoadedAt = 0;

function xtream() {
  if (!EPG_URL) return null;
  try {
    const u = new URL(EPG_URL);
    const username = u.searchParams.get('username'), password = u.searchParams.get('password');
    if (!username || !password) return null;
    return { base: `${u.protocol}//${u.host}`, username, password };
  } catch { return null; }
}

async function loadStreams() {
  const x = xtream();
  if (!x) return;
  try {
    const res = await axios.get(`${x.base}/player_api.php`, {
      params: { username: x.username, password: x.password, action: 'get_live_streams' }, timeout: 60000,
    });
    const map = new Map(), ids = new Set();
    for (const s of Array.isArray(res.data) ? res.data : []) {
      if (!s.stream_id) continue;
      ids.add(String(s.stream_id));
      if (!s.epg_channel_id) continue;
      const list = map.get(s.epg_channel_id) || [];
      list.push({ id: String(s.stream_id), name: s.name || '' });
      map.set(s.epg_channel_id, list);
    }
    if (ids.size) { streamsByEpgId = map; streamIds = ids; streamsLoadedAt = Date.now(); }
    console.log(`Watch: loaded ${ids.size} live streams (${map.size} guide channels linked)`);
  } catch (e) {
    console.error('Watch: stream list failed:', (e.message || '').replace(/(username|password)=[^&\s]+/g, '$1=<redacted>'));
  }
}

function requireWatchKey(req, res, next) {
  res.set('Cache-Control', 'no-store');
  if (!WATCH_API_KEY) return res.status(503).json({ error: 'Watch API not configured' });
  const given = Buffer.from(String(req.get('X-Watch-Key') || ''));
  const want = Buffer.from(WATCH_API_KEY);
  if (given.length !== want.length || !crypto.timingSafeEqual(given, want)) return res.status(401).json({ error: 'Unauthorised' });
  next();
}

// Does this fixture involve the given team name? Reuses the guide's fuzzy team matching
// (accents, nicknames, distinctive words) in both directions against "Home v Away".
function fixtureHasTeam(fix, name) {
  if (!name) return true;
  const { padded } = titleWords(`${fix.home} v ${fix.away} ${fix.homeShort} ${fix.awayShort}`);
  if (teamMentioned(padded, name.toLowerCase())) return true;
  const { padded: q } = titleWords(name);
  return teamMentioned(q, fix.home) || teamMentioned(q, fix.away);
}

function findWatchFixture({ league, home, away, start }) {
  const t = start ? new Date(start).getTime() : NaN;
  const names = [home, away].filter(Boolean);
  if (!names.length) return null;
  const hits = fixtureCache.filter(f => {
    if (league && f.league && f.league !== league) return false;
    if (!league && names.length < 2) return false; // one team and no league is too loose
    if (!isNaN(t) && f.espnStartTime && Math.abs(new Date(f.espnStartTime).getTime() - t) > 3 * 60 * 60 * 1000) return false;
    return names.every(n => fixtureHasTeam(f, n));
  });
  hits.sort((a, b) => (b.isLive - a.isLive)
    || Math.abs(new Date(a.espnStartTime || 0) - t) - Math.abs(new Date(b.espnStartTime || 0) - t));
  return hits[0] || null;
}

// Australian channels first, then English-language (US/UK or no country prefix), then the rest.
function regionRank(name) {
  const m = String(name).match(/^\s*([A-Z]{2,3})\s*[:|]/i);
  if (!m) return 1;
  const cc = m[1].toUpperCase();
  if (cc === 'AU' || cc === 'AUS') return 0;
  if (['US', 'USA', 'UK', 'GB', 'CA', 'NZ', 'IE'].includes(cc)) return 1;
  return 2;
}

// Tennis broadcasts name the tournament, not the players ("ATP Masters 1000 Shanghai"),
// so a tennis match is offered the channels whose current programme is its tournament —
// the broadcaster picks which court it shows, so these are flagged as "may be another
// match". (Dated per-court event feeds were tried and don't deliver — not offered.)
const TOURNAMENT_GENERIC = new Set(['rolex','masters','open','championships','championship','cup','presented','the',
  'tennis','international','classic','trophy','atp','wta','tour','series','final','finals','grand','slam','mutua','national','bank']);
function tournamentWords(name) {
  return stripAccents((name || '').toLowerCase()).split(/[^a-z0-9]+/).filter(w => w.length >= 4 && !TOURNAMENT_GENERIC.has(w));
}
const TENNIS_RE = /tennis|\batp\b|\bwta\b/i;
const MAX_TENNIS_CHANNELS = 4;
// English-language tennis coverage first (Australian, then the big English broadcasters),
// foreign-language commentary last — judged by channel name and programme wording.
const ENGLISH_TENNIS_RE = /tennis channel|sky sports|bein|\btsn\b|stan sport|eurosport|amazon|9gem|\bnine\b|espn(?!.*\b(arg|br|mx|latam)\b)/i;
const FOREIGN_WORDS_RE = /\b(ronde|konferenz|jornada|primera|giornata|tag|runde|tour \d|journée|cuartos|octavos|huitièmes)\b/i;
function tennisRank(c) {
  if (FOREIGN_WORDS_RE.test(c.programme || '')) return 4;
  const region = regionRank(c.name);
  if (region === 0) return 0;
  if (region === 2) return 3;
  return ENGLISH_TENNIS_RE.test(c.name) ? 1 : 2;
}
function addTennisChannels(fix, channels, seen) {
  const words = tournamentWords(fix.tournament);
  if (!words.length) return;
  const mentions = text => { const { padded } = titleWords(text || ''); return words.some(w => hasWord(padded, w)); };
  const found = [];
  for (const ch of cache) {
    const title = ch.now?.title || '';
    if (!(mentions(title) && (TENNIS_RE.test(title) || TENNIS_RE.test(ch.name)))) continue;
    const streams = channelStreams(ch).filter(s => !seen.has(s.id));
    if (streams.length) found.push({ name: ch.name, logo: ch.logo || '', onNow: true, programme: title, streams, tournamentOnly: true });
  }
  found.sort((a, b) => tennisRank(a) - tennisRank(b) || a.name.localeCompare(b.name));
  let added = 0;
  for (const c of found) {
    if (added >= MAX_TENNIS_CHANNELS) break;
    c.streams = c.streams.filter(s => !seen.has(s.id));
    if (!c.streams.length) continue; // same feed as a channel already offered
    c.streams.forEach(s => seen.add(s.id));
    channels.push(c);
    added++;
  }
}

// A channel's streams across its quality versions — best that a browser can play first
// (FHD, HD, then 4K/HEVC which often won't), capped so the list stays usable.
const MAX_STREAMS_PER_CHANNEL = 3;
const QUALITY_ORDER = { FHD: 0, HD: 1, '': 2, SD: 3, '4K': 4 };
function channelStreams(ch) {
  const variants = ch.variantIds || [{ id: ch.id, quality: ch.quality }];
  return variants.flatMap(v => (streamsByEpgId.get(v.id) || []).map(s => ({ ...s, quality: v.quality })))
    .sort((a, b) => (QUALITY_ORDER[a.quality] ?? 2) - (QUALITY_ORDER[b.quality] ?? 2) || /hevc/i.test(a.name) - /hevc/i.test(b.name))
    .slice(0, MAX_STREAMS_PER_CHANNEL);
}

// Racing: the guide lists racing channels by session ("Sky Racing 1 Late Night"), never by
// race, so a race is offered the racing channels that cover its country — and flagged so.
const RACING_CHANNELS = {
  AU: ['SkyThoroughbredCentral.au', 'SKYRacing1.au', 'RACINGCOM.au', 'SKYRacing2.au'],
  NZ: ['SKYRacing2.au', 'SKYRacing1.au'],
  UK: ['RacingTV.uk', 'SKYRacing2.au', 'SKYRacing1.au'],
  IRE: ['RacingTV.uk', 'SKYRacing2.au', 'SKYRacing1.au'],
  other: ['SKYRacing2.au', 'SKYRacing1.au', 'SkyThoroughbredCentral.au'],
};
function racingWatch({ league, home, away, start }) {
  const country = (league.split('/')[1] || '').toUpperCase();
  const ids = RACING_CHANNELS[country === 'AUS' ? 'AU' : country] || RACING_CHANNELS.other;
  const t = start ? new Date(start).getTime() : NaN;
  const mins = isNaN(t) ? NaN : (t - Date.now()) / 60000;
  const status = isNaN(mins) ? 'scheduled' : mins < -20 ? 'finished' : mins <= 10 ? 'live' : mins <= 30 ? 'soon' : 'scheduled';
  const seen = new Set(), channels = [];
  for (const id of ids) {
    const ch = (cache || []).find(c => c.id === id || (c.variantIds || []).some(v => v.id === id));
    const streams = channelStreams({ id, quality: '', variantIds: [{ id, quality: '' }] }).filter(s => !seen.has(s.id) && seen.add(s.id));
    if (!streams.length) continue;
    channels.push({ name: ch?.name || streams[0].name, logo: ch?.logo || '', onNow: true, programme: ch?.now?.title || 'Racing', streams, tournamentOnly: true });
  }
  return {
    fixture: { name: [away, home].filter(Boolean).join(' · ') || 'Race', league, start: start || null, isLive: status === 'live', isFinished: status === 'finished' },
    status: status === 'finished' ? 'finished' : status,
    channels: status === 'finished' ? [] : channels,
    note: 'Racing channel — your race may be on another of these channels.',
    reason: channels.length ? null : 'no_channel',
  };
}

function watchStatus(fix) {
  if (fix.isLive) return 'live';
  if (fix.isFinished) return 'finished';
  const mins = fix.espnStartTime ? (new Date(fix.espnStartTime) - Date.now()) / 60000 : Infinity;
  return mins <= 30 ? 'soon' : 'scheduled';
}

app.get('/api/watch/match', requireWatchKey, (req, res) => {
  const q = { league: String(req.query.league || ''), home: String(req.query.home || ''), away: String(req.query.away || ''), start: req.query.start };
  if (!cache) return res.status(503).json({ error: 'Guide still loading' });
  if (q.league.startsWith('racing/')) return res.json(racingWatch(q));
  const fix = findWatchFixture(q);
  if (!fix) return res.json({ fixture: null, status: null, channels: [], reason: 'no_fixture' });

  const channels = [];
  const seen = new Set(); // a stream offered once, even if several guide channels point at it
  let withoutStreams = 0;
  // A channel's "now" link to a fixture is only set if the game was already live when
  // the guide was last rebuilt (every 30 min) — so also check the current programme's
  // title against this fixture right now. Cheap word check first, full match second.
  const showingNow = (ch) => {
    if (!ch.now?.title) return false;
    const { padded } = titleWords(ch.now.title);
    if (!teamMentioned(padded, fix.home || fix.name) && !teamMentioned(padded, fix.away || '')) return false;
    return matchFixture(ch.now.title, parseDate(ch.now.startRaw))?.fixtureKey === fix.fixtureKey;
  };
  for (const ch of cache) {
    const live = ch.now?.sport?.fixtureKey === fix.fixtureKey || showingNow(ch);
    const up = (ch.upcoming || []).find(p => p.fixtureKey === fix.fixtureKey);
    if (!live && !up) continue;
    const streams = channelStreams(ch).filter(s => !seen.has(s.id) && seen.add(s.id));
    if (!streams.length) { withoutStreams++; continue; }
    channels.push({
      name: ch.name, logo: ch.logo || '', onNow: live,
      programme: live ? ch.now.title : up.title, streams,
    });
  }
  if (fix.sportId === 'tennis') addTennisChannels(fix, channels, seen);
  channels.sort((a, b) => (a.tournamentOnly || 0) - (b.tournamentOnly || 0) || b.onNow - a.onNow || regionRank(a.name) - regionRank(b.name) || a.name.localeCompare(b.name));
  res.json({
    fixture: { name: fix.displayName, league: fix.league, start: fix.espnStartTime, isLive: fix.isLive, isFinished: fix.isFinished },
    status: watchStatus(fix),
    channels,
    note: fix.sportId === 'tennis' && channels.some(c => c.tournamentOnly) ? 'Showing the tournament — the broadcaster may be on another court.' : null,
    reason: channels.length ? null : (withoutStreams ? 'no_stream' : 'no_channel'),
  });
});

app.get('/api/watch/stream/:id', requireWatchKey, (req, res) => {
  const id = String(req.params.id);
  if (!/^\d+$/.test(id) || !streamIds.has(id)) return res.status(404).json({ error: 'Unknown stream' });
  const x = xtream();
  if (!x) return res.status(503).json({ error: 'IPTV login not configured' });
  const format = req.query.format === 'm3u8' ? 'm3u8' : 'ts';
  res.json({ url: `${x.base}/live/${encodeURIComponent(x.username)}/${encodeURIComponent(x.password)}/${id}.${format}`, format });
});

const minutesSince = t => t ? Math.round((Date.now() - t) / 60000) : null;

app.get('/status', (req, res) => {
  res.json({
    ready: !!cache,
    channels: cache ? cache.length : 0,
    fixtures: fixtureCache.length,
    live: fixtureCache.filter(f => f.isLive).length,
    refreshing,
    guideAgeMinutes: minutesSince(lastRefreshOk),
    uptimeMinutes: Math.round(process.uptime() / 60),
    rssMB: Math.round(process.memoryUsage().rss / 1048576),
    watchStreams: streamIds.size,
    watchStreamsAgeMinutes: minutesSince(streamsLoadedAt),
  });
});

// For the uptime monitor: 503 if the guide is stale (no successful refresh in 90 min),
// so we get alerted when the app is up but stuck, not just when it's fully down.
app.get('/health', (req, res) => {
  const age = minutesSince(lastRefreshOk);
  const ok = age !== null ? age < 90 : process.uptime() < 10 * 60; // allow 10 min to start up
  res.status(ok ? 200 : 503).json({ ok, guideAgeMinutes: age, uptimeMinutes: Math.round(process.uptime() / 60) });
});

app.listen(PORT, () => {
  console.log('EPG server running on port ' + PORT);
  refresh();
  setTimeout(refreshFixtures, 60 * 1000);
  loadStreams();
  setInterval(loadStreams, STREAMS_REFRESH_MS);
});
