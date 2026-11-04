import { describe, expect, it } from 'vitest';

import {
  BootstrapInputError,
  cleanPaste,
  parseChannelLink,
  parseFolderUrl,
  validateFolderPath,
  validateSiteUrl
} from '../links.js';

const TEAM = '11111111-2222-3333-4444-555555555555';
const channelLink = (host = 'teams.microsoft.com'): string =>
  `https://${host}/l/channel/19%3aabcDEF123%40thread.tacv2/Analytics%20deliveries?groupId=${TEAM}&tenantId=66666666-7777-8888-9999-000000000000`;

const rejects = (fn: () => unknown, pattern: RegExp): void => {
  expect(fn).toThrow(BootstrapInputError);
  try {
    fn();
    throw new Error('expected fn to throw');
  } catch (error) {
    expect(error).toBeInstanceOf(BootstrapInputError);
    expect((error as Error).message).toMatch(pattern);
  }
};

describe('cleanPaste', () => {
  it('strips whitespace and one pair of quotes or angle brackets that pasting adds', () => {
    expect(cleanPaste('  https://x.test/a \n')).toBe('https://x.test/a');
    expect(cleanPaste('"https://x.test/a"')).toBe('https://x.test/a');
    expect(cleanPaste("'https://x.test/a'")).toBe('https://x.test/a');
    expect(cleanPaste('<https://x.test/a>')).toBe('https://x.test/a');
    expect(cleanPaste('"https://x.test/a>')).toBe('"https://x.test/a>');
  });

  it('strips typographic quotes too', () => {
    expect(cleanPaste('\u201Chttps://x\u201D')).toBe('https://x');
  });
});

describe('parseChannelLink', () => {
  it('reads team, channel and name from a channel link', () => {
    expect(parseChannelLink(channelLink())).toEqual({
      teamId: TEAM,
      channelId: '19:abcDEF123@thread.tacv2',
      channelName: 'Analytics deliveries'
    });
  });

  it('accepts the new Teams host and a link pasted with quotes and spaces', () => {
    expect(parseChannelLink(channelLink('teams.cloud.microsoft')).teamId).toBe(TEAM);
    expect(parseChannelLink(`  "${channelLink()}"  `).channelId).toBe('19:abcDEF123@thread.tacv2');
  });

  it('rejects a message link with advice', () => {
    rejects(
      () =>
        parseChannelLink(
          `https://teams.microsoft.com/l/message/19%3aabc%40thread.tacv2/1700000000000?groupId=${TEAM}`
        ),
      /points to a message/
    );
  });

  it('rejects a team link, a non-Teams address and plain text', () => {
    rejects(
      () =>
        parseChannelLink(
          `https://teams.microsoft.com/l/team/19%3aabc%40thread.tacv2/conversations?groupId=${TEAM}`
        ),
      /not a channel link/
    );
    rejects(() => parseChannelLink('https://contoso.sharepoint.com/sites/x'), /Teams link/);
    rejects(() => parseChannelLink('Analytics'), /not a link/);
  });

  it('rejects a channel link without its team or with a malformed channel ID', () => {
    rejects(() => parseChannelLink(channelLink().replace(/groupId=[^&]+&/, '')), /groupId/);
    rejects(
      () => parseChannelLink(channelLink().replace('19%3aabcDEF123%40thread.tacv2', 'General')),
      /channel ID/
    );
  });
});

describe('parseFolderUrl', () => {
  const LIBRARY = 'https://contoso.sharepoint.com/sites/Analytics/Shared%20Documents/Forms/AllItems.aspx';

  it('reads site and folder from a library view address, decoding spaces and non-ASCII names', () => {
    const id = encodeURIComponent('/sites/Analytics/Shared Documents/CodeMie/\u0410\u043d\u0430\u043b\u0456\u0442\u0438\u043a\u0430');
    expect(parseFolderUrl(`${LIBRARY}?id=${id}&viewid=abc`)).toEqual({
      siteUrl: 'https://contoso.sharepoint.com/sites/Analytics',
      folderPath: 'Shared Documents/CodeMie/\u0410\u043d\u0430\u043b\u0456\u0442\u0438\u043a\u0430'
    });
  });

  it('reads a direct folder address and a /teams/ site', () => {
    expect(parseFolderUrl('https://contoso.sharepoint.com/teams/Data/Shared%20Documents/CodeMie/')).toEqual({
      siteUrl: 'https://contoso.sharepoint.com/teams/Data',
      folderPath: 'Shared Documents/CodeMie'
    });
  });

  it('a library root view means the library itself', () => {
    expect(parseFolderUrl(LIBRARY)).toEqual({
      siteUrl: 'https://contoso.sharepoint.com/sites/Analytics',
      folderPath: 'Shared Documents'
    });
  });

  it('reads a classic view address, which carries the folder in RootFolder=', () => {
    expect(
      parseFolderUrl(
        `${LIBRARY}?RootFolder=%2Fsites%2FAnalytics%2FShared%20Documents%2FCodeMie&FolderCTID=0x012000`
      )
    ).toEqual({ siteUrl: 'https://contoso.sharepoint.com/sites/Analytics', folderPath: 'Shared Documents/CodeMie' });
  });

  it('reads a /:f:/r/ link, which carries the path', () => {
    expect(
      parseFolderUrl('https://contoso.sharepoint.com/:f:/r/sites/Analytics/Shared%20Documents/CodeMie?csf=1&web=1')
    ).toEqual({ siteUrl: 'https://contoso.sharepoint.com/sites/Analytics', folderPath: 'Shared Documents/CodeMie' });
  });

  it('refuses a sharing link, a page, a non-SharePoint address, and a path without a site', () => {
    rejects(() => parseFolderUrl('https://contoso.sharepoint.com/:f:/s/Analytics/EabcDEF123'), /sharing link/);
    rejects(
      () => parseFolderUrl('https://contoso.sharepoint.com/sites/Analytics/SitePages/Home.aspx'),
      /page, not a folder/
    );
    rejects(() => parseFolderUrl('https://drive.google.com/drive/folders/abc'), /SharePoint address/);
    rejects(() => parseFolderUrl('https://contoso.sharepoint.com/Shared%20Documents/CodeMie'), /site from the folder/);
  });
});

describe('validateSiteUrl / validateFolderPath', () => {
  it('manual entry: a site address of any depth, and a folder path', () => {
    expect(validateSiteUrl(' https://contoso.sharepoint.com/sites/Analytics/Sub/ ')).toBe(
      'https://contoso.sharepoint.com/sites/Analytics/Sub'
    );
    rejects(() => validateSiteUrl('https://contoso.sharepoint.com/sites/A?x=1'), /without anything after/);
    expect(validateFolderPath('/Shared Documents\\CodeMie/')).toBe('Shared Documents/CodeMie');
    rejects(() => validateFolderPath('  '), /folder path/);
  });
});
