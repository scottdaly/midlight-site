/**
 * Mobile Auth Contract Tests
 *
 * Run: node --test server/__tests__/mobileAuthContract.test.js
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { __private as authPrivate } from '../routes/auth.js';

describe('mobile auth contract', () => {
  it('detects native clients and captures telemetry headers', () => {
    const info = authPrivate.getClientInfo({
      headers: {
        'x-midlight-client': 'ios',
        'x-midlight-platform': 'ios',
        'x-midlight-app-version': '2.1.0',
        'x-midlight-build-channel': 'beta',
        'x-midlight-network-state': 'wifi',
        'user-agent': 'MidlightMobile/2.1.0',
      },
      body: {},
      ip: '127.0.0.1',
    });

    assert.equal(info.client, 'ios');
    assert.equal(info.platform, 'ios');
    assert.equal(info.appVersion, '2.1.0');
    assert.equal(info.buildChannel, 'beta');
    assert.equal(info.networkState, 'wifi');
    assert.equal(info.isNative, true);
  });

  it('supports refresh token resolution from request body for native clients', () => {
    const token = authPrivate.resolveRefreshToken({
      cookies: undefined,
      body: { refreshToken: 'refresh-native-123' },
    });

    assert.equal(token, 'refresh-native-123');
  });

  it('includes refresh token fields only for native auth responses', () => {
    const user = {
      id: 42,
      email: 'mobile@example.com',
      display_name: 'Mobile User',
      avatar_url: null,
    };

    const nativeResponse = authPrivate.authResponse(
      user,
      'access-native',
      900,
      'refresh-native',
      {
        client: 'ios',
        platform: 'ios',
        appVersion: '1.0.0',
        buildChannel: 'internal',
        networkState: 'cellular',
        isNative: true,
      },
    );

    assert.equal(nativeResponse.refreshToken, 'refresh-native');
    assert.equal(nativeResponse.refreshExpiresIn, 7 * 24 * 60 * 60);
    assert.equal(nativeResponse.client.networkState, 'cellular');

    const webResponse = authPrivate.authResponse(
      user,
      'access-web',
      900,
      'refresh-web',
      {
        client: 'web',
        platform: 'web',
        appVersion: null,
        buildChannel: null,
        networkState: null,
        isNative: false,
      },
    );

    assert.equal(webResponse.refreshToken, undefined);
    assert.equal(webResponse.refreshExpiresIn, undefined);
  });
});
