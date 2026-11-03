'use strict';
const assert = require('assert');
const { loadBundledProfiles, validateProfile, profileAvailability } = require('../../lib/publishing/profiles');
const profiles = loadBundledProfiles();
const wechat = profiles.find(item => item.profile.id === 'wechat-official-core');
const cnblogs = profiles.find(item => item.profile.id === 'cnblogs-metaweblog-v1');
assert.ok(wechat.validation.valid); assert.strictEqual(profileAvailability(cnblogs.profile).availability, 'unavailable'); assert.strictEqual(profileAvailability(cnblogs.profile).reason, 'NO_REVIEWABLE_PREPARE_PATH');
const incomplete = JSON.parse(JSON.stringify(wechat.profile)); delete incomplete.routes.accessToken.timeoutMs; assert.ok(!validateProfile(incomplete).valid);
console.log('✓ publishing profiles');
