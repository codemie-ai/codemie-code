/**
 * Reading what a client admin pastes into the setup wizard: a Teams channel link, a
 * SharePoint folder address.
 *
 * Each function returns clean values or throws BootstrapInputError with a message written
 * for the admin, saying what to copy instead.
 *
 * Ported from codemie-analytics-collector/src/links.js.
 */

export class BootstrapInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BootstrapInputError';
  }
}

export interface ChannelLink {
  teamId: string;
  channelId: string;
  channelName: string;
}

export interface FolderLink {
  siteUrl: string;
  folderPath: string;
}

const TEAMS_HOSTS = ['teams.microsoft.com', 'teams.cloud.microsoft'];
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CHANNEL_ID = /^19:[^@\s/]+@thread\.(tacv2|skype)$/;
const SHAREPOINT_HOST = /\.sharepoint\.com$/i;
const CLOSING: Record<string, string> = { '"': '"', "'": "'", '<': '>', '\u201C': '\u201D', '\u2018': '\u2019' };

/** Drops surrounding whitespace and one pair of quotes or angle brackets pasting adds. */
export function cleanPaste(raw: string): string {
  const value = String(raw ?? '').trim();
  const wrapped = /^(["'<\u201C\u2018])([\s\S]*)(["'>\u201D\u2019])$/.exec(value);
  return wrapped && CLOSING[wrapped[1]] === wrapped[3] ? wrapped[2].trim() : value;
}

function parseUrl(raw: string, message: string): URL {
  try {
    return new URL(cleanPaste(raw));
  } catch {
    throw new BootstrapInputError(message);
  }
}

function decodePath(path: string): string {
  try {
    return decodeURIComponent(path);
  } catch {
    throw new BootstrapInputError('That address has broken %-encoding. Copy it again.');
  }
}

export function parseChannelLink(raw: string): ChannelLink {
  const url = parseUrl(
    raw,
    'That is not a link. In Teams, on the channel: \u22EF \u2192 Get link to channel, then paste it here.'
  );
  if (!TEAMS_HOSTS.includes(url.hostname)) {
    throw new BootstrapInputError(`Expected a Teams link (${TEAMS_HOSTS.join(' or ')}), not ${url.hostname}.`);
  }
  if (url.pathname.startsWith('/l/message/')) {
    throw new BootstrapInputError('That link points to a message. Use \u22EF \u2192 Get link to channel on the channel itself.');
  }
  const match = /^\/l\/channel\/([^/]+)\/([^/]*)/.exec(url.pathname);
  if (!match) {
    throw new BootstrapInputError(
      'That is not a channel link. Use \u22EF \u2192 Get link to channel on the channel itself, not on the team.'
    );
  }

  const channelId = decodePath(match[1]);
  const channelName = decodePath(match[2]);
  const teamId = url.searchParams.get('groupId') ?? '';
  if (!CHANNEL_ID.test(channelId)) {
    throw new BootstrapInputError(
      `"${channelId}" does not look like a Teams channel ID (19:\u2026@thread.tacv2). Copy the link again.`
    );
  }
  if (!GUID.test(teamId)) {
    throw new BootstrapInputError('The link has no groupId, which identifies the team. Copy it again with \u22EF \u2192 Get link to channel.');
  }
  return { teamId, channelId, channelName };
}

function requireSharePoint(url: URL): void {
  if (url.protocol !== 'https:' || !SHAREPOINT_HOST.test(url.hostname)) {
    throw new BootstrapInputError(`Expected a SharePoint address like https://contoso.sharepoint.com/sites/\u2026, not ${url.origin}.`);
  }
}

/**
 * Site and folder from a folder's address bar: a library view (the folder is in its `id=`
 * parameter), a direct folder path, or a `/:f:/r/` link, which carries the path. The site
 * is the first two segments when they are /sites/<name> or /teams/<name>; anything else —
 * including a subsite — is for the admin to give separately.
 */
export function parseFolderUrl(raw: string): FolderLink {
  const url = parseUrl(raw, 'That is not a link. Open the folder in your browser and copy the whole address bar.');
  requireSharePoint(url);

  // A classic view carries the folder in RootFolder=, not id=; check it before falling
  // back to the address bar's own path, which for that view is just the Forms page.
  let serverPath = url.searchParams.get('id') || url.searchParams.get('RootFolder');
  if (!serverPath) {
    // /:f:/r/<path> carries the path; /:f:/s/… and /:f:/g/… sharing links are opaque.
    const shortcut = /^\/:[a-z]:\/([a-z])(\/.*)$/i.exec(url.pathname);
    if (shortcut && shortcut[1].toLowerCase() !== 'r') {
      throw new BootstrapInputError(
        'That is a sharing link, which does not say where the folder is. Open it in your browser, then copy the address bar instead.'
      );
    }
    serverPath = decodePath(shortcut ? shortcut[2] : url.pathname).replace(/\/Forms\/[^/]+\.aspx$/i, '');
  }

  const match = /^\/(sites|teams)\/([^/]+)\/(.+?)\/*$/.exec(serverPath);
  if (!match) {
    throw new BootstrapInputError(`Could not tell the site from the folder in ${serverPath}. Type "manual" to give them separately.`);
  }
  if (/\.aspx$/i.test(match[3])) {
    throw new BootstrapInputError('That address is a page, not a folder. Open the folder itself and copy the address bar.');
  }
  return { siteUrl: `${url.origin}/${match[1]}/${match[2]}`, folderPath: match[3] };
}

export function validateSiteUrl(raw: string): string {
  const url = parseUrl(raw, 'That is not a link. Give the site address, e.g. https://contoso.sharepoint.com/sites/Analytics');
  requireSharePoint(url);
  if (url.search || url.hash) {
    throw new BootstrapInputError('Give just the site address, without anything after "?" or "#".');
  }
  return `${url.origin}${decodePath(url.pathname)}`.replace(/\/+$/, '');
}

export function validateFolderPath(raw: string): string {
  const value = cleanPaste(raw).replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
  if (!value) throw new BootstrapInputError('Give the folder path inside the site, e.g. Shared Documents/CodeMie');
  if (/[?#]/.test(value)) throw new BootstrapInputError('Give a folder path, not an address: no "?" or "#".');
  return value;
}
