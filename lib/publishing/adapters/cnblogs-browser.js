'use strict';

const { BaseAdapter, unavailable } = require('./base');

class CnblogsBrowserAdapter extends BaseAdapter {
  constructor(profile, dependencies) {
    super(profile, dependencies);
  }

  capability() {
    return {
      availability: 'unavailable',
      providerPath: 'cnblogs-browser',
      profile: null,
      draftSupported: false,
      autoSupported: false,
      supportedFields: [],
      reason: 'PROFILE_UNAVAILABLE',
    };
  }

  async preflight() { return unavailable(null, 'PROFILE_UNAVAILABLE'); }
  async prepare() { return unavailable(null, 'PROFILE_UNAVAILABLE'); }
}

module.exports = { CnblogsBrowserAdapter };
