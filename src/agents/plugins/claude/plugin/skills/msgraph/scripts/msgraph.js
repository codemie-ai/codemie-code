#!/usr/bin/env node
/**
 * msgraph.js — Microsoft Graph API CLI for Claude Code skill
 *
 * Authentication: OAuth2 device code flow with persistent token cache.
 * First time:   node msgraph.js login
 * Subsequent:   token refreshed silently from cache.
 *
 * Dependencies: node >= 18 (built-in modules only — zero npm installs needed)
 */

'use strict';

const https = require('node:https');
const fs    = require('node:fs');
const path  = require('node:path');
const os    = require('node:os');

// ── Config ────────────────────────────────────────────────────────────────────
const CLIENT_ID  = '14d82eec-204b-4c2f-b7e8-296a70dab67e';
const TOKEN_URL  = 'https://login.microsoftonline.com/common/oauth2/v2.0/token';
const DEVICE_URL = 'https://login.microsoftonline.com/common/oauth2/v2.0/devicecode';
const SCOPES     = [
  'User.Read', 'Mail.Read', 'Mail.Send',
  'Calendars.Read', 'Calendars.ReadWrite',
  'Files.Read', 'Files.ReadWrite',
  'Sites.Read.All', 'Chat.Read', 'Chat.ReadWrite',
  'People.Read', 'Contacts.Read',
  'Notes.Read', 'Notes.ReadWrite',
  'offline_access',
].join(' ');
const CACHE_FILE = path.join(os.homedir(), '.ms_graph_token_cache.json');
const GRAPH_BASE = 'https://graph.microsoft.com/v1.0';

// ── HTTP Helpers ──────────────────────────────────────────────────────────────
function httpsRequest(urlStr, options = {}, body = null) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const req = https.request({
      hostname: u.hostname,
      path:     u.pathname + u.search,
      method:   options.method || 'GET',
      headers:  options.headers || {},
    }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        if (res.statusCode >= 400) {
          const err = new Error(`HTTP ${res.statusCode}`);
          err.statusCode   = res.statusCode;
          err.responseBody = text;
          err.responseUrl  = urlStr;
          return reject(err);
        }
        resolve({ status: res.statusCode, body: text, headers: res.headers });
      });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

async function oauthPost(urlStr, params) {
  const body = new URLSearchParams(params).toString();
  const res  = await httpsRequest(urlStr, {
    method:  'POST',
    headers: {
      'Content-Type':   'application/x-www-form-urlencoded',
      'Content-Length': Buffer.byteLength(body),
    },
  }, body);
  return JSON.parse(res.body);
}

async function graphGet(endpoint, token, params = {}) {
  const qs  = new URLSearchParams(params).toString();
  const url = `${GRAPH_BASE}${endpoint}${qs ? '?' + qs : ''}`;
  const res = await httpsRequest(url, { headers: { Authorization: `Bearer ${token}` } });
  return JSON.parse(res.body);
}

async function graphPost(endpoint, token, body) {
  const bodyStr = JSON.stringify(body);
  const res = await httpsRequest(`${GRAPH_BASE}${endpoint}`, {
    method:  'POST',
    headers: {
      Authorization:    `Bearer ${token}`,
      'Content-Type':   'application/json',
      'Content-Length': Buffer.byteLength(bodyStr),
    },
  }, bodyStr);
  return res.body ? JSON.parse(res.body) : {};
}

/** Download file content, following 302 redirects (Graph uses CDN redirects). */
function graphDownload(endpoint, token) {
  function fetch(url, auth) {
    return new Promise((resolve, reject) => {
      const u       = new URL(url);
      const headers = auth ? { Authorization: `Bearer ${auth}` } : {};
      https.get({ hostname: u.hostname, path: u.pathname + u.search, headers }, res => {
        if (res.statusCode === 301 || res.statusCode === 302) {
          res.resume();
          fetch(res.headers.location, null).then(resolve, reject);
          return;
        }
        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end',  () => resolve(Buffer.concat(chunks)));
        res.on('error', reject);
      }).on('error', reject);
    });
  }
  return fetch(`${GRAPH_BASE}${endpoint}`, token);
}

async function graphUpload(endpoint, token, content, contentType = 'application/octet-stream') {
  const res = await httpsRequest(`${GRAPH_BASE}${endpoint}`, {
    method:  'PUT',
    headers: {
      Authorization:    `Bearer ${token}`,
      'Content-Type':   contentType,
      'Content-Length': content.length,
    },
  }, content);
  return JSON.parse(res.body);
}

// ── Token Cache ───────────────────────────────────────────────────────────────
function loadCache() {
  if (!fs.existsSync(CACHE_FILE)) return null;
  try { return JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8')); } catch { return null; }
}

function saveCache(data) {
  fs.writeFileSync(CACHE_FILE, JSON.stringify(data, null, 2), { mode: 0o600 });
}

// ── Authentication ────────────────────────────────────────────────────────────
async function tryRefresh(refreshTkn, username) {
  try {
    const res = await oauthPost(TOKEN_URL, {
      client_id:     CLIENT_ID,
      grant_type:    'refresh_token',
      refresh_token: refreshTkn,
      scope:         SCOPES,
    });
    if (res.access_token) {
      saveCache({
        access_token:  res.access_token,
        refresh_token: res.refresh_token || refreshTkn,
        expires_at:    Math.floor(Date.now() / 1000) + (res.expires_in || 3600),
        username:      username || '',
      });
      return res.access_token;
    }
  } catch {}
  return null;
}

/** Returns a valid token, silently refreshing if needed. Exits if not logged in. */
async function getValidToken() {
  const cache = loadCache();
  if (!cache?.access_token) {
    console.log('NOT_LOGGED_IN');
    process.exit(2);
  }
  const now = Math.floor(Date.now() / 1000);
  if (!cache.expires_at || now < cache.expires_at - 60) return cache.access_token;
  if (cache.refresh_token) {
    const t = await tryRefresh(cache.refresh_token, cache.username);
    if (t) return t;
  }
  console.log('TOKEN_EXPIRED');
  process.exit(2);
}

/** Like getValidToken but returns null instead of exiting (used by status cmd). */
async function tryGetToken() {
  const cache = loadCache();
  if (!cache?.access_token) return null;
  const now = Math.floor(Date.now() / 1000);
  if (!cache.expires_at || now < cache.expires_at - 60) return cache.access_token;
  if (cache.refresh_token) return tryRefresh(cache.refresh_token, cache.username);
  return null;
}

async function getAccessToken(forceLogin = false) {
  if (!forceLogin) {
    const cache = loadCache();
    if (cache?.access_token) {
      const now = Math.floor(Date.now() / 1000);
      if (cache.expires_at && now < cache.expires_at - 60) return cache.access_token;
      if (cache.refresh_token) {
        const t = await tryRefresh(cache.refresh_token, cache.username);
        if (t) return t;
      }
    }
  }

  // Device Code Flow
  const device = await oauthPost(DEVICE_URL, { client_id: CLIENT_ID, scope: SCOPES });
  if (!device.device_code) throw new Error(`Device flow failed: ${JSON.stringify(device)}`);

  console.log('\n' + '='.repeat(60));
  console.log(device.message);
  console.log('='.repeat(60) + '\n');

  const interval = (device.interval || 5) * 1000;
  const deadline = Date.now() + (device.expires_in || 900) * 1000;

  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, interval));
    try {
      const res = await oauthPost(TOKEN_URL, {
        client_id:   CLIENT_ID,
        grant_type:  'urn:ietf:params:oauth:grant-type:device_code',
        device_code: device.device_code,
      });
      if (res.access_token) {
        const me = await graphGet('/me', res.access_token, { $select: 'userPrincipalName' });
        saveCache({
          access_token:  res.access_token,
          refresh_token: res.refresh_token || '',
          expires_at:    Math.floor(Date.now() / 1000) + (res.expires_in || 3600),
          username:      me.userPrincipalName || '',
        });
        return res.access_token;
      }
    } catch (err) {
      let body = {};
      try { body = JSON.parse(err.responseBody || '{}'); } catch {}
      if (body.error === 'authorization_pending') continue;
      if (body.error === 'slow_down') { await new Promise(r => setTimeout(r, 5000)); continue; }
      if (body.error === 'expired_token') throw new Error('Device code expired. Run login again.');
      throw err;
    }
  }
  throw new Error('Authentication timed out.');
}

// ── Formatters ────────────────────────────────────────────────────────────────
function fmtDt(iso) {
  if (!iso) return 'N/A';
  try { return new Date(iso).toISOString().slice(0, 16).replace('T', ' '); }
  catch { return (iso || '').slice(0, 16).replace('T', ' '); }
}

function fmtSize(n) {
  if (!n) return '';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(1)} ${units[i]}`;
}

function stripHtml(s) {
  return (s || '')
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\r?\n\s*\r?\n/g, '\n')
    .trim();
}

function pad(str, len) {
  str = String(str || '');
  return str.length >= len ? str.slice(0, len) : str + ' '.repeat(len - str.length);
}

// ── Commands ──────────────────────────────────────────────────────────────────
async function cmdLogin() {
  console.log('Starting Microsoft authentication...');
  const token = await getAccessToken(true);
  const me    = await graphGet('/me', token);
  console.log(`\nLogged in as: ${me.displayName} <${me.userPrincipalName}>`);
  console.log(`User ID: ${me.id}`);
  console.log(`Token cached at: ${CACHE_FILE}`);
}

function cmdLogout() {
  if (fs.existsSync(CACHE_FILE)) {
    fs.unlinkSync(CACHE_FILE);
    console.log(`Logged out. Cache removed: ${CACHE_FILE}`);
  } else {
    console.log('No cached credentials found.');
  }
}

async function cmdStatus() {
  const cache = loadCache();
  if (!cache?.access_token) {
    console.log('NOT_LOGGED_IN');
    console.log(`\nTo login, run:\n  node ${path.basename(process.argv[1])} login`);
    return;
  }
  const token = await tryGetToken();
  if (token) {
    const updated = loadCache();
    console.log(`Logged in as: ${updated?.username || cache.username}`);
    console.log(`Cache file: ${CACHE_FILE}`);
  } else {
    console.log('TOKEN_EXPIRED');
    console.log(`Account: ${cache.username}`);
    console.log(`\nSession expired. Re-authenticate with:\n  node ${path.basename(process.argv[1])} login`);
  }
}

async function cmdMe(args) {
  const token = await getValidToken();
  const me    = await graphGet('/me', token);
  if (args.json) {
    const fields = ['displayName','userPrincipalName','id','mail','jobTitle',
                    'department','officeLocation','businessPhones','mobilePhone'];
    const out = {};
    for (const k of fields) if (me[k] != null) out[k] = me[k];
    console.log(JSON.stringify(out, null, 2));
    return;
  }
  console.log(`Name       : ${me.displayName    || 'N/A'}`);
  console.log(`Email      : ${me.userPrincipalName || 'N/A'}`);
  console.log(`Job Title  : ${me.jobTitle        || 'N/A'}`);
  console.log(`Department : ${me.department      || 'N/A'}`);
  console.log(`Office     : ${me.officeLocation  || 'N/A'}`);
  console.log(`Phone      : ${(me.businessPhones || [])[0] || me.mobilePhone || 'N/A'}`);
  console.log(`User ID    : ${me.id              || 'N/A'}`);
}

async function cmdEmails(args) {
  const token = await getValidToken();

  if (args.send) {
    await graphPost('/me/sendMail', token, {
      message: {
        subject: args.subject || '(no subject)',
        body:    { contentType: 'Text', content: args.body || '' },
        toRecipients: [{ emailAddress: { address: args.send } }],
      },
    });
    console.log(`Email sent to ${args.send}`);
    return;
  }

  if (args.read) {
    const msg  = await graphGet(`/me/messages/${args.read}`, token);
    const from = msg.from?.emailAddress || {};
    console.log(`Subject  : ${msg.subject}`);
    console.log(`From     : ${from.name || ''} <${from.address || ''}>`);
    console.log(`Date     : ${fmtDt(msg.receivedDateTime)}`);
    console.log(`Read     : ${msg.isRead ? 'Yes' : 'No'}`);
    console.log(`\n${'─'.repeat(60)}`);
    const body = msg.body || {};
    console.log(body.contentType === 'text' ? body.content : stripHtml(body.content || '').slice(0, 2000));
    return;
  }

  const limit  = parseInt(args.limit) || 10;
  const params = {
    $top:     limit,
    $select:  'id,subject,from,receivedDateTime,isRead,hasAttachments,importance',
    $orderby: 'receivedDateTime desc',
  };
  if (args.search) { params.$search = `"${args.search}"`; delete params.$orderby; }
  if (args.unread)   params.$filter = 'isRead eq false';

  const endpoint = args.folder ? `/me/mailFolders/${args.folder}/messages` : '/me/messages';
  const data     = await graphGet(endpoint, token, params);
  const emails   = data.value || [];

  if (args.json) { console.log(JSON.stringify(emails, null, 2)); return; }
  if (!emails.length) { console.log('No emails found.'); return; }

  console.log(`\n${'ID'.padEnd(36)}  ${'Date'.padEnd(16)}  Rd  Subject`);
  console.log('─'.repeat(80));
  for (const e of emails) {
    const mark    = e.isRead ? '✓' : '●';
    const att     = e.hasAttachments ? '📎' : '  ';
    const subject = (e.subject || '(no subject)').slice(0, 45);
    const sender  = (e.from?.emailAddress?.name || '').slice(0, 20);
    console.log(`${e.id.slice(0,36)}  ${fmtDt(e.receivedDateTime).padEnd(16)}  ${mark}   ${att} ${subject}  (${sender})`);
  }
}

async function cmdCalendar(args) {
  const token = await getValidToken();

  if (args.create) {
    if (!args.start || !args.end) {
      console.error('Error: --create requires --start and --end (format: YYYY-MM-DDTHH:MM)');
      process.exit(1);
    }
    const tz      = args.timezone || 'UTC';
    const payload = {
      subject: args.create,
      start:   { dateTime: args.start, timeZone: tz },
      end:     { dateTime: args.end,   timeZone: tz },
    };
    if (args.location) payload.location = { displayName: args.location };
    if (args.body)     payload.body     = { contentType: 'Text', content: args.body };
    if (args.attendees) {
      payload.attendees = args.attendees.split(',').map(email => ({
        emailAddress: { address: email.trim() },
        type: 'required',
      }));
    }
    const event = await graphPost('/me/events', token, payload);
    console.log(`Event created: ${event.subject}`);
    console.log(`ID: ${event.id}`);
    return;
  }

  if (args.availability) {
    const now   = new Date();
    const start = args.start || now.toISOString().slice(0, 19);
    const end   = args.end   || new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59).toISOString().slice(0, 19);
    const view  = await graphGet('/me/calendarView', token, {
      startDateTime: start,
      endDateTime:   end,
      $select:       'subject,start,end,showAs',
      $orderby:      'start/dateTime',
    });
    const events = view.value || [];
    if (!events.length) {
      console.log(`You're free between ${start.slice(0,16)} and ${end.slice(0,16)}.`);
    } else {
      console.log(`\nBusy slots (${events.length} events):`);
      for (const e of events)
        console.log(`  ${fmtDt(e.start.dateTime)} — ${fmtDt(e.end.dateTime)}: ${e.subject || '(no title)'}`);
    }
    return;
  }

  const limit   = parseInt(args.limit) || 10;
  const now     = new Date();
  const yearEnd = new Date(now.getFullYear() + 1, 0, 1);
  const data    = await graphGet('/me/calendarView', token, {
    startDateTime: now.toISOString().slice(0, 19) + 'Z',
    endDateTime:   yearEnd.toISOString().slice(0, 19) + 'Z',
    $top:          limit,
    $select:       'id,subject,start,end,location,organizer,isOnlineMeeting',
    $orderby:      'start/dateTime',
  });
  const events = data.value || [];

  if (args.json) { console.log(JSON.stringify(events, null, 2)); return; }
  if (!events.length) { console.log('No upcoming events.'); return; }

  console.log(`\n${'Date & Time'.padEnd(20)}    Title`);
  console.log('─'.repeat(80));
  for (const e of events) {
    const online    = e.isOnlineMeeting ? '🎥' : '  ';
    const title     = (e.subject || '(no title)').slice(0, 45);
    const organizer = (e.organizer?.emailAddress?.name || '').slice(0, 20);
    const loc       = (e.location?.displayName || '').slice(0, 20);
    console.log(`${fmtDt(e.start?.dateTime).padEnd(20)}  ${online}  ${title}  (${organizer})${loc ? `  @ ${loc}` : ''}`);
  }
}

async function cmdSharepoint(args) {
  const token = await getValidToken();
  const limit = parseInt(args.limit) || 20;

  if (args.sites) {
    let data  = await graphGet('/me/followedSites', token, { $select: 'id,displayName,webUrl' });
    let sites = data.value || [];
    if (!sites.length) {
      data  = await graphGet('/sites', token, { search: '*', $top: limit });
      sites = data.value || [];
    }
    if (args.json) { console.log(JSON.stringify(sites, null, 2)); return; }
    console.log(`\n${'ID'.padEnd(50)}  Name`);
    console.log('─'.repeat(80));
    for (const s of sites.slice(0, limit)) {
      console.log(`${(s.id || '').padEnd(50)}  ${s.displayName || 'N/A'}`);
      console.log(`  URL: ${s.webUrl || 'N/A'}`);
    }
    return;
  }

  if (args.site) {
    const p  = args.path || 'root';
    const ep = p === 'root'
      ? `/sites/${args.site}/drive/root/children`
      : `/sites/${args.site}/drive/root:/${p}:/children`;
    const data  = await graphGet(ep, token, { $top: limit, $select: 'id,name,size,lastModifiedDateTime,file,folder' });
    const items = data.value || [];
    if (args.json) { console.log(JSON.stringify(items, null, 2)); return; }
    console.log(`\nFiles in site ${args.site} / ${p}:`);
    console.log('─'.repeat(60));
    for (const item of items) {
      const kind     = item.folder ? '📁' : '📄';
      const size     = item.file   ? fmtSize(item.size) : '';
      const modified = fmtDt(item.lastModifiedDateTime);
      console.log(`  ${kind} ${pad(item.name, 40)} ${pad(size, 10)} ${modified}`);
    }
    return;
  }

  if (args.download) {
    const outPath = args.output || `downloaded_${args.download.slice(0, 8)}`;
    const content = await graphDownload(`/me/drive/items/${args.download}/content`, token);
    fs.writeFileSync(outPath, content);
    console.log(`Downloaded ${content.length} bytes to ${outPath}`);
    return;
  }

  console.log('SharePoint: --sites | --site SITE_ID [--path PATH] | --download ITEM_ID [--output FILE]');
}

async function cmdTeams(args) {
  const token = await getValidToken();
  const limit = parseInt(args.limit) || 20;

  if (args.chats) {
    const data  = await graphGet('/me/chats', token, { $top: limit, $select: 'id,topic,chatType,lastUpdatedDateTime' });
    const chats = data.value || [];
    if (args.json) { console.log(JSON.stringify(chats, null, 2)); return; }
    console.log(`\n${'Chat ID'.padEnd(50)}  ${'Type'.padEnd(10)}  Topic`);
    console.log('─'.repeat(80));
    for (const c of chats)
      console.log(`${(c.id || '').padEnd(50)}  ${(c.chatType || '').padEnd(10)}  ${c.topic || '(direct message)'}`);
    return;
  }

  if (args.messages) {
    const data = await graphGet(`/me/chats/${args.messages}/messages`, token, {
      $top: limit, $select: 'id,from,body,createdDateTime',
    });
    const msgs = data.value || [];
    if (args.json) { console.log(JSON.stringify(msgs, null, 2)); return; }
    console.log(`\nMessages in chat ${args.messages.slice(0, 20)}...:`);
    console.log('─'.repeat(60));
    for (const m of [...msgs].reverse()) {
      const sender = m.from?.user?.displayName || 'System';
      const body   = stripHtml(m.body?.content || '').slice(0, 200);
      console.log(`[${fmtDt(m.createdDateTime)}] ${sender}: ${body}`);
    }
    return;
  }

  if (args.send && args.chatId) {
    const res = await graphPost(`/me/chats/${args.chatId}/messages`, token, { body: { content: args.send } });
    console.log(`Message sent. ID: ${res.id}`);
    return;
  }

  if (args.teamsList) {
    const data  = await graphGet('/me/joinedTeams', token, { $select: 'id,displayName,description' });
    const teams = data.value || [];
    if (args.json) { console.log(JSON.stringify(teams, null, 2)); return; }
    for (const t of teams) console.log(`${t.id.slice(0, 36)}  ${t.displayName}`);
    return;
  }

  console.log('Teams: --chats | --messages CHAT_ID | --send MSG --chat-id ID | --teams-list');
}

async function cmdOnedrive(args) {
  const token = await getValidToken();
  const limit = parseInt(args.limit) || 20;

  if (args.upload) {
    if (!fs.existsSync(args.upload)) {
      console.error(`File not found: ${args.upload}`);
      process.exit(1);
    }
    const content = fs.readFileSync(args.upload);
    const dest    = args.dest || path.basename(args.upload);
    const result  = await graphUpload(`/me/drive/root:/${dest}:/content`, token, content);
    console.log(`Uploaded: ${result.name} (${fmtSize(result.size)})`);
    console.log(`ID: ${result.id}`);
    return;
  }

  if (args.download) {
    const outPath = args.output || `download_${args.download.slice(0, 8)}`;
    const content = await graphDownload(`/me/drive/items/${args.download}/content`, token);
    fs.writeFileSync(outPath, content);
    console.log(`Downloaded ${fmtSize(content.length)} to ${outPath}`);
    return;
  }

  if (args.info) {
    const item = await graphGet(`/me/drive/items/${args.info}`, token);
    if (args.json) { console.log(JSON.stringify(item, null, 2)); return; }
    console.log(`Name    : ${item.name}`);
    console.log(`Size    : ${fmtSize(item.size)}`);
    console.log(`Modified: ${fmtDt(item.lastModifiedDateTime)}`);
    console.log(`URL     : ${item.webUrl || 'N/A'}`);
    return;
  }

  const p  = args.path || '';
  const ep = p ? `/me/drive/root:/${p}:/children` : '/me/drive/root/children';
  const data  = await graphGet(ep, token, { $top: limit, $select: 'id,name,size,lastModifiedDateTime,file,folder', $orderby: 'name' });
  const items = data.value || [];

  if (args.json) { console.log(JSON.stringify(items, null, 2)); return; }
  if (!items.length) { console.log(`No files found in /${p || ''}`); return; }

  console.log(`\nOneDrive: /${p || ''}`);
  console.log('─'.repeat(60));
  for (const item of items) {
    const kind     = item.folder ? '📁' : '📄';
    const size     = item.file   ? fmtSize(item.size) : '';
    const modified = fmtDt(item.lastModifiedDateTime);
    const count    = item.folder ? `  (${item.folder.childCount} items)` : '';
    console.log(`  ${kind} ${item.id.slice(0,16)}  ${pad(item.name, 40)} ${pad(size, 10)} ${modified}${count}`);
  }
}

async function cmdPeople(args) {
  const token = await getValidToken();
  const limit = parseInt(args.limit) || 20;

  if (args.contacts) {
    const params = { $top: limit, $select: 'displayName,emailAddresses,mobilePhone,jobTitle,companyName' };
    if (args.search) params.$search = `"${args.search}"`;
    const data     = await graphGet('/me/contacts', token, params);
    const contacts = data.value || [];
    if (args.json) { console.log(JSON.stringify(contacts, null, 2)); return; }
    console.log(`\n${'Name'.padEnd(30)}  ${'Email'.padEnd(35)}  Title`);
    console.log('─'.repeat(80));
    for (const c of contacts) {
      const email = (c.emailAddresses || [])[0]?.address || 'N/A';
      console.log(`${pad(c.displayName || '', 30)}  ${pad(email, 35)}  ${c.jobTitle || ''}`);
    }
    return;
  }

  const params = { $top: limit };
  if (args.search) params.$search = `"${args.search}"`;
  const data   = await graphGet('/me/people', token, params);
  const people = data.value || [];

  if (args.json) { console.log(JSON.stringify(people, null, 2)); return; }
  if (!people.length) { console.log('No people found.'); return; }

  console.log(`\n${'Name'.padEnd(30)}  ${'Email'.padEnd(35)}  Title`);
  console.log('─'.repeat(80));
  for (const p of people) {
    const email = (p.scoredEmailAddresses || [])[0]?.address || 'N/A';
    console.log(`${pad(p.displayName || '', 30)}  ${pad(email, 35)}  ${p.jobTitle || ''}`);
  }
}

async function cmdOrg(args) {
  const token = await getValidToken();

  if (args.manager) {
    try {
      const mgr = await graphGet('/me/manager', token);
      console.log(`Manager: ${mgr.displayName} <${mgr.userPrincipalName}>`);
      console.log(`Title  : ${mgr.jobTitle || 'N/A'}`);
    } catch (err) {
      if (err.statusCode === 404) console.log('No manager found (you may be at the top of the org).');
      else throw err;
    }
    return;
  }

  if (args.reports) {
    const data    = await graphGet('/me/directReports', token, { $select: 'displayName,userPrincipalName,jobTitle' });
    const reports = data.value || [];
    console.log(`\nDirect Reports (${reports.length}):`);
    for (const r of reports)
      console.log(`  ${pad(r.displayName || '', 30)}  ${r.userPrincipalName}`);
    return;
  }

  // Default: show org context
  try {
    const mgr = await graphGet('/me/manager', token);
    console.log(`Manager: ${mgr.displayName}`);
  } catch {}
  const reports    = (await graphGet('/me/directReports', token, { $select: 'displayName' })).value || [];
  console.log(`Direct Reports: ${reports.length}`);
  const colleagues = (await graphGet('/me/people', token, { $top: 5 })).value || [];
  console.log('\nFrequent colleagues:');
  for (const p of colleagues) console.log(`  ${p.displayName}`);
}

async function cmdOnenote(args) {
  const token = await getValidToken();
  const limit = parseInt(args.limit) || 20;

  if (args.notebooks) {
    const data      = await graphGet('/me/onenote/notebooks', token, { $top: limit, $select: 'id,displayName,lastModifiedDateTime' });
    const notebooks = data.value || [];
    if (args.json) { console.log(JSON.stringify(notebooks, null, 2)); return; }
    if (!notebooks.length) { console.log('No notebooks found.'); return; }
    console.log(`\n${'ID'.padEnd(36)}  ${'Modified'.padEnd(18)}  Name`);
    console.log('─'.repeat(80));
    for (const nb of notebooks)
      console.log(`${(nb.id || '').padEnd(36)}  ${fmtDt(nb.lastModifiedDateTime).padEnd(18)}  ${nb.displayName || 'N/A'}`);
    return;
  }

  if (args.sections) {
    const data     = await graphGet(`/me/onenote/notebooks/${args.sections}/sections`, token, { $top: limit, $select: 'id,displayName,lastModifiedDateTime' });
    const sections = data.value || [];
    if (args.json) { console.log(JSON.stringify(sections, null, 2)); return; }
    if (!sections.length) { console.log('No sections found.'); return; }
    console.log(`\nSections in notebook ${args.sections.slice(0, 20)}...:`);
    console.log(`${'ID'.padEnd(36)}  Name`);
    console.log('─'.repeat(70));
    for (const s of sections)
      console.log(`${(s.id || '').padEnd(36)}  ${s.displayName || 'N/A'}`);
    return;
  }

  if (args.pages) {
    const data  = await graphGet(`/me/onenote/sections/${args.pages}/pages`, token, { $top: limit, $select: 'id,title,lastModifiedDateTime' });
    const pages = data.value || [];
    if (args.json) { console.log(JSON.stringify(pages, null, 2)); return; }
    if (!pages.length) { console.log('No pages found.'); return; }
    console.log(`\nPages in section ${args.pages.slice(0, 20)}...:`);
    console.log(`${'ID'.padEnd(36)}  ${'Modified'.padEnd(18)}  Title`);
    console.log('─'.repeat(80));
    for (const p of pages)
      console.log(`${(p.id || '').padEnd(36)}  ${fmtDt(p.lastModifiedDateTime).padEnd(18)}  ${p.title || '(untitled)'}`);
    return;
  }

  if (args.read) {
    const res  = await httpsRequest(`${GRAPH_BASE}/me/onenote/pages/${args.read}/content`, { headers: { Authorization: `Bearer ${token}` } });
    if (args.json) { console.log(JSON.stringify({ id: args.read, content: res.body })); return; }
    console.log(stripHtml(res.body));
    return;
  }

  if (args.search) {
    const data  = await graphGet('/me/onenote/pages', token, { $search: `"${args.search}"`, $top: limit, $select: 'id,title,createdDateTime' });
    const pages = data.value || [];
    if (args.json) { console.log(JSON.stringify(pages, null, 2)); return; }
    if (!pages.length) { console.log(`No pages found matching "${args.search}".`); return; }
    console.log(`\nSearch results for "${args.search}" (${pages.length}):`);
    console.log(`${'ID'.padEnd(36)}  Title`);
    console.log('─'.repeat(70));
    for (const p of pages)
      console.log(`${(p.id || '').padEnd(36)}  ${p.title || '(untitled)'}`);
    return;
  }

  if (args.create) {
    if (!args.section) {
      console.error('Error: --create requires --section SECTION_ID');
      process.exit(1);
    }
    const htmlBody = `<!DOCTYPE html><html><head><title>${args.create}</title></head><body>${args.body || ''}</body></html>`;
    const res = await httpsRequest(`${GRAPH_BASE}/me/onenote/sections/${args.section}/pages`, {
      method:  'POST',
      headers: {
        Authorization:    `Bearer ${token}`,
        'Content-Type':   'text/html',
        'Content-Length': Buffer.byteLength(htmlBody),
      },
    }, htmlBody);
    const page = JSON.parse(res.body);
    console.log(`Page created: ${page.title || args.create}`);
    console.log(`ID: ${page.id}`);
    return;
  }

  console.log('OneNote: --notebooks | --sections NOTEBOOK_ID | --pages SECTION_ID');
  console.log('         --read PAGE_ID | --search QUERY');
  console.log('         --create TITLE --section SECTION_ID [--body CONTENT]');
}

// ── CLI Parser ────────────────────────────────────────────────────────────────
function parseArgs(argv) {
  // Flags that take no value (boolean)
  const BOOL = new Set(['json','unread','sites','chats','teamsList','contacts',
                        'manager','reports','availability','notebooks','help']);
  const args = { _: [] };
  let i = 0;
  while (i < argv.length) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const raw = a.slice(2);
      const key = raw.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
      if (BOOL.has(key) || i + 1 >= argv.length || argv[i + 1].startsWith('--')) {
        args[key] = true;
      } else {
        args[key] = argv[++i];
      }
    } else {
      args._.push(a);
    }
    i++;
  }
  return args;
}

function printHelp() {
  const name = path.basename(process.argv[1]);
  console.log(`Microsoft Graph API CLI
Usage: node ${name} <command> [options]

Auth:
  login                                Authenticate (device code flow)
  logout                               Remove cached credentials
  status                               Check login status

Data:
  me [--json]                          Your profile
  emails [--limit N] [--unread] [--search Q] [--folder NAME]
         [--read ID] [--send TO --subject S --body B] [--json]
  calendar [--limit N] [--json]
           [--create TITLE --start DT --end DT [--location L] [--timezone TZ]]
           [--availability --start DT --end DT]
  sharepoint [--sites] [--site ID [--path P]] [--download ID [--output FILE]] [--json]
  teams [--chats] [--messages CHAT_ID] [--send MSG --chat-id ID] [--teams-list] [--json]
  onedrive [--path P] [--upload FILE [--dest PATH]] [--download ID [--output FILE]]
           [--info ID] [--json]
  people [--contacts] [--search NAME] [--limit N] [--json]
  org [--manager] [--reports] [--json]
  onenote [--notebooks] [--sections NOTEBOOK_ID] [--pages SECTION_ID]
          [--read PAGE_ID] [--search QUERY] [--limit N] [--json]
          [--create TITLE --section SECTION_ID [--body CONTENT]]

Add --json to any command for machine-readable output.

Examples:
  node ${name} login
  node ${name} emails --limit 20
  node ${name} emails --send user@corp.com --subject "Hi" --body "Hello"
  node ${name} calendar --create "Standup" --start 2024-03-15T09:00 --end 2024-03-15T09:30
  node ${name} teams --chats
  node ${name} onedrive --upload report.pdf --dest "Documents/report.pdf"
  node ${name} onenote --notebooks
  node ${name} onenote --sections NOTEBOOK_ID
  node ${name} onenote --pages SECTION_ID
  node ${name} onenote --read PAGE_ID
  node ${name} onenote --search "meeting notes"
  node ${name} onenote --create "My Note" --section SECTION_ID --body "Content here"
`);
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  const argv = process.argv.slice(2);
  if (!argv.length) { printHelp(); process.exit(0); }

  const command = argv[0];
  const args    = parseArgs(argv.slice(1));

  const COMMANDS = {
    login:      () => cmdLogin(),
    logout:     () => cmdLogout(),
    status:     () => cmdStatus(),
    me:         () => cmdMe(args),
    emails:     () => cmdEmails(args),
    calendar:   () => cmdCalendar(args),
    sharepoint: () => cmdSharepoint(args),
    teams:      () => cmdTeams(args),
    onedrive:   () => cmdOnedrive(args),
    people:     () => cmdPeople(args),
    org:        () => cmdOrg(args),
    onenote:    () => cmdOnenote(args),
    help:       () => { printHelp(); process.exit(0); },
  };

  if (!COMMANDS[command]) {
    console.error(`Unknown command: ${command}`);
    printHelp();
    process.exit(1);
  }

  try {
    await COMMANDS[command]();
  } catch (err) {
    if (err.statusCode === 401) {
      console.error(`Error: Authentication expired. Run: node ${path.basename(process.argv[1])} login`);
    } else if (err.statusCode === 403) {
      console.error(`Error: Permission denied (${err.responseUrl || ''})`);
      console.error('You may need additional OAuth scopes.');
    } else if (err.statusCode === 404) {
      console.error(`Error: Resource not found (${err.responseUrl || ''})`);
    } else if (err.statusCode) {
      console.error(`HTTP Error ${err.statusCode}: ${(err.responseBody || '').slice(0, 200)}`);
    } else {
      console.error(`Error: ${err.message}`);
    }
    process.exit(1);
  }
}

main().catch(err => {
  console.error(err.message);
  process.exit(1);
});
