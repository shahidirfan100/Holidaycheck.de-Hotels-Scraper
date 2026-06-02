/* eslint import-x/no-default-export: "off" */
import prettier from 'eslint-config-prettier';

import apify from '@apify/eslint-config/js.js';

export default [{ ignores: ['**/dist', '**/storage'] }, ...apify, prettier];
