const express = require('express');
const axios = require('axios');
const path = require('path');
const { DOMParser } = require('@xmldom/xmldom');
const app = express();
const PORT = process.env.PORT || 3001;

const EPG_URL = 'https://305.halfvex.com/xmltv.php?username=ib123&password=gP4HRjkXrc';

app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  next();
});

app.use(express.static(path.join(__dirname)));

let cache = null;

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

async function refresh() {
  try {
    console.log('Fetching EPG...');
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
      return { channel: p.getAttribute('channel'), start, stop, startRaw, title: p.getElementsByTagName('title')[0]?.textContent || '', desc: p.getElementsByTagName('desc')[0]?.textContent || '' };
    }).filter(p => p.start && p.stop);

    const progsByChannel = {};
    allProgs.forEach(p => {
      if (!progsByChannel[p.channel]) progsByChannel[p.channel] = [];
      progsByChannel[p.channel].push(p);
    });

    cache = channels.map(ch => {
      const progs = (progsByChannel[ch.id] || []).sort((a,b) => a.start - b.start);
      const nowP = progs.find(p => p.start <= now && p.stop > now);
      const next = progs.filter(p => p.start > now).slice(0, 2);
      return {
        ...ch,
        now: nowP ? { title: nowP.title, desc: nowP.desc.slice(0,150), startRaw: nowP.startRaw, pct: Math.min(100, Math.round(((now-nowP.start)/(nowP.stop-nowP.start))*100)) } : null,
        next: next.map(p => ({ title: p.title, desc: p.desc.slice(0,100), startRaw: p.startRaw }))
      };
    });

    console.log('EPG ready -', channels.length, 'channels');
  } catch(e) {
    console.error('EPG fetch failed:', e.message);
  }
  setTimeout(refresh, 30 * 60 * 1000);
}

app.get('/guide', (req, res) => {
  if (!cache) return res.status(503).json({ error: 'EPG still loading, try again in 30 seconds' });
  res.json(cache);
});

app.get('/status', (req, res) => {
  res.json({ ready: !!cache, channels: cache ? cache.length : 0 });
});

app.listen(PORT, () => {
  console.log('EPG server running on port ' + PORT);
  refresh();
});