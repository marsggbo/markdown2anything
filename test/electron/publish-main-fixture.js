'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { sha256 } = require('../../lib/publishing/model');
const {
  createElectronSecretStore, migrateElectronSecrets, createElectronPublishingServices,
} = require('../../electron/app-bootstrap');

function fakeSafeStorage(backend) {
  return {
    isEncryptionAvailable: () => true,
    getSelectedStorageBackend: () => backend || 'os_crypt',
    encryptString: value => Buffer.from(`encrypted:${value}`, 'utf8'),
    decryptString: value => value.toString('utf8').replace(/^encrypted:/, ''),
  };
}

(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'm2a-electron-publish-'));
  try {
    const configPath = path.join(root, 'config.json');
    const cookiePath = path.join(root, 'zhihu-cookie.txt');
    fs.writeFileSync(configPath, JSON.stringify({ appid: 'app-id', appSecret: 'migration-value' }), 'utf8');
    fs.writeFileSync(cookiePath, 'z_c0=migration-cookie;', 'utf8');
    const secure = await migrateElectronSecrets({ userData: root, safeStorage: fakeSafeStorage(), configPath, cookiePath });
    if (!secure.available || !secure.migrated) throw new Error('secure migration did not complete');
    if (Object.prototype.hasOwnProperty.call(JSON.parse(fs.readFileSync(configPath, 'utf8')), 'appSecret')) throw new Error('plaintext secret remained in config');
    if (fs.existsSync(cookiePath)) throw new Error('legacy cookie file remained after readback');
    if (await secure.store.get('publishing.wechat.appSecret') !== 'migration-value') throw new Error('encrypted secret readback failed');
    if ((fs.statSync(secure.secretPath).mode & 0o077) !== 0) throw new Error('secret file is not private');
    const revision = await secure.store.getRevision('publishing.wechat.appSecret');
    const restarted = createElectronSecretStore({ userData: root, safeStorage: fakeSafeStorage() });
    if (await restarted.store.getRevision('publishing.wechat.appSecret') !== revision) throw new Error('credential revision did not survive restart');
    const changed = await restarted.store.set('publishing.wechat.appSecret', 'changed-value');
    if (changed.revision === revision || await createElectronSecretStore({ userData: root, safeStorage: fakeSafeStorage() }).store.getRevision('publishing.wechat.appSecret') !== changed.revision) throw new Error('changed credential revision did not persist');

    const unavailable = createElectronSecretStore({ userData: path.join(root, 'unavailable'), safeStorage: { isEncryptionAvailable: () => false } });
    if (unavailable.available) throw new Error('unavailable secure storage was accepted');
    const basic = createElectronSecretStore({ userData: path.join(root, 'basic'), safeStorage: fakeSafeStorage('basic_text') });
    if (basic.available) throw new Error('basic_text secure storage was accepted');

    const articlePath = path.join(root, 'article.md');
    const article = '# Saved\n\nBody';
    fs.writeFileSync(articlePath, article, 'utf8');
    const state = { currentFilePath: articlePath, documentDirty: false, savedDocumentHash: sha256(article), config: { appid: 'app-id' }, mainWindow: null };
    const services = createElectronPublishingServices({
      state, dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) }, shell: { openExternal: () => {} }, secure, configPath, userData: root,
      promptCredential: async slot => slot === 'publishing.cnblogs.username' ? 'user' : 'token',
      browserLogin: async () => JSON.stringify([{ name: 'z_c0', value: 'browser-cookie', domain: '.zhihu.com', path: '/', expires: -1 }]),
    });
    const saved = await services.readDocument();
    if (saved.dirty || saved.content !== article) throw new Error('saved document was not available');
    services.markDirty('# Changed');
    if (!(await services.readDocument()).dirty) throw new Error('dirty editor content was accepted');
    if (!(await services.requestCredentialEntry('publishing.cnblogs.username', 'publishRequestCredentialEntry')).available) throw new Error('host credential entry was unavailable');
    if (!(await services.requestCredentialEntry('publishing.zhihu.browserCookies', 'publishBeginBrowserLogin')).available) throw new Error('host browser login enrollment was unavailable');
    if (await secure.store.get('publishing.cnblogs.username') !== 'user') throw new Error('host credential was not securely stored');
    const configText = fs.readFileSync(configPath, 'utf8');
    if (configText.includes('migration-value') || configText.includes('migration-cookie') || configText.includes('browser-cookie')) throw new Error('secret leaked to config');

    const blockedRoot = path.join(root, 'blocked-migration');
    fs.mkdirSync(blockedRoot);
    const blockedConfigPath = path.join(blockedRoot, 'config.json');
    const blockedCookiePath = path.join(blockedRoot, 'zhihu-cookie.txt');
    fs.writeFileSync(blockedConfigPath, '{}', 'utf8');
    fs.writeFileSync(blockedCookiePath, 'not-a-valid-cookie', 'utf8');
    const blockedSecure = await migrateElectronSecrets({ userData: blockedRoot, safeStorage: fakeSafeStorage(), configPath: blockedConfigPath, cookiePath: blockedCookiePath });
    if (!blockedSecure.migrationBlockedSlots.includes('publishing.zhihu.browserCookies')) throw new Error('unrepresentable legacy cookie did not block Zhihu publishing');
    if (!fs.existsSync(blockedCookiePath)) throw new Error('unrepresentable legacy cookie was deleted');
    const blockedState = { currentFilePath: articlePath, documentDirty: false, savedDocumentHash: sha256(article), config: {}, mainWindow: null };
    const blockedServices = createElectronPublishingServices({
      state: blockedState, dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) }, shell: { openExternal: () => {} }, secure: blockedSecure, configPath: blockedConfigPath, userData: blockedRoot,
      browserLogin: async () => JSON.stringify([{ name: 'z_c0', value: 'replacement-cookie', domain: '.zhihu.com', path: '/', expires: -1 }]),
    });
    if (!(await blockedServices.getTargetContext('zhihu')).migrationBlocked) throw new Error('blocked legacy cookie still enabled the Zhihu target');
    if (!(await blockedServices.requestCredentialEntry('publishing.zhihu.browserCookies', 'publishBeginBrowserLogin')).available) throw new Error('Zhihu re-enrollment was unavailable');
    if (fs.existsSync(blockedCookiePath) || (await blockedServices.getTargetContext('zhihu')).migrationBlocked) throw new Error('verified Zhihu re-enrollment did not resolve the migration block');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
  console.log('✓ Electron publishing fixture');
})().catch(error => { console.error(error); process.exit(1); });
