'use strict';
const crypto = require('crypto');
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
    });
    const saved = await services.readDocument();
    if (saved.dirty || saved.content !== article) throw new Error('saved document was not available');
    services.markDirty('# Changed');
    if (!(await services.readDocument()).dirty) throw new Error('dirty editor content was accepted');
    const configText = fs.readFileSync(configPath, 'utf8');
    if (configText.includes('migration-value') || configText.includes('migration-cookie')) throw new Error('secret leaked to config');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
  console.log('✓ Electron publishing fixture');
})().catch(error => { console.error(error); process.exit(1); });
