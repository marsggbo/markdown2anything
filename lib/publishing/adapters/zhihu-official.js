'use strict';

const { BaseAdapter, unavailable } = require('./base');

class ZhihuOfficialAdapter extends BaseAdapter {
  capability() {
    return {
      availability: 'unavailable',
      providerPath: 'zhihu-official',
      profile: null,
      draftSupported: false,
      autoSupported: false,
      supportedFields: [],
      reason: 'OFFICIAL_ARTICLE_PROFILE_MISSING',
    };
  }

  async preflight() {
    return unavailable(null, 'OFFICIAL_ARTICLE_PROFILE_MISSING');
  }

  async prepare() {
    return unavailable(null, 'OFFICIAL_ARTICLE_PROFILE_MISSING');
  }
}

module.exports = { ZhihuOfficialAdapter };
