'use strict';

const { app } = require('electron');

if (process.env.M2A_PUBLISH_TEST_USER_DATA) app.setPath('userData', process.env.M2A_PUBLISH_TEST_USER_DATA);
process.env.M2A_PUBLISH_BRIDGE_FIXTURE = '1';
require('../../electron/app-bootstrap').bootElectronApp();
