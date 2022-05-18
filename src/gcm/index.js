const path = require('path');
const request = require('../utils/request');
const protobuf = require('protobufjs');
const Long = require('long');
const { waitFor } = require('../utils/timeout');
const { toBase64 } = require('../utils/base64');
const { promisify } = require('util');
const { randomBytes } = require('crypto');
const uuidv4 = require('uuid/v4');

// Hack to fix PHONE_REGISTRATION_ERROR #17 when bundled with webpack
// https://github.com/dcodeIO/protobuf.js#browserify-integration
protobuf.util.Long = Long;
protobuf.configure();

const REGISTER_URL = 'https://android.clients.google.com/c2dm/register3';
const CHECKIN_URL = 'https://android.clients.google.com/checkin';

let root;
let AndroidCheckinResponse;

module.exports = {
  register,
  checkIn,
};

async function createInstanceId() {
  // 8 random bytes, but first nibble is 0x7
  const instanceIdBuf = await promisify(randomBytes)(8);
  instanceIdBuf[0] &= 0x0f;
  instanceIdBuf[0] |= 0x70;
  return toBase64(instanceIdBuf);
}

function createAppId() {
  return `wp:texts.com#${uuidv4().slice(0, -3)}-V2`;
}

// takes in client info (or null), returns refreshed client info
async function checkIn(lastClientInfo) {
  const { androidId = null, securityToken = null, instanceId = null } =
    lastClientInfo || {};
  await loadProtoFile();
  const buffer = getCheckinRequest(androidId, securityToken);
  const body = await request({
    url     : CHECKIN_URL,
    method  : 'POST',
    headers : {
      'Content-Type' : 'application/x-protobuf',
    },
    body     : buffer,
    encoding : null,
  });
  const message = AndroidCheckinResponse.decode(body);
  const object = AndroidCheckinResponse.toObject(message, {
    longs : String,
    enums : String,
    bytes : String,
  });
  return {
    androidId     : object.androidId,
    securityToken : object.securityToken,
    instanceId    : instanceId || (await createInstanceId()),
  };
}

async function register(
  { androidId, securityToken, instanceId },
  authorizedEntity
) {
  const appId = createAppId();

  const options = {
    url     : REGISTER_URL,
    method  : 'POST',
    headers : {
      Authorization  : `AidLogin ${androidId}:${securityToken}`,
      'Content-Type' : 'application/x-www-form-urlencoded',
    },
    form : {
      scope       : 'GCM',
      'X-scope'   : 'GCM',
      sender      : authorizedEntity,
      appid       : instanceId,
      gmsv        : '101', // major chrome version
      ttl         : (90 * 24 * 60 * 60).toString(), // 90 days
      app         : 'com.texts.push',
      'X-subtype' : appId,
      device      : androidId,
    },
  };

  let response = null;
  const MAX_ATTEMPTS = 5;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; ++attempt) {
    const _response = await request(options);
    if (_response.includes('Error')) {
      console.warn(`Register request has failed with ${_response}`);
      if (attempt !== MAX_ATTEMPTS - 1) {
        console.warn(`Retry... ${attempt + 1}`);
        await waitFor(1000);
      }
    } else {
      response = _response;
      break;
    }
  }

  const token = response.split('=')[1];
  return { token, appId };
}

async function loadProtoFile() {
  if (root) {
    return;
  }
  root = await protobuf.load(path.join(__dirname, 'checkin.proto'));
  return root;
}

function getCheckinRequest(androidId, securityToken) {
  const AndroidCheckinRequest = root.lookupType(
    'checkin_proto.AndroidCheckinRequest'
  );
  AndroidCheckinResponse = root.lookupType(
    'checkin_proto.AndroidCheckinResponse'
  );
  const payload = {
    userSerialNumber : 0,
    checkin          : {
      type        : 3,
      chromeBuild : {
        platform      : 2,
        chromeVersion : '63.0.3234.0',
        channel       : 1,
      },
    },
    version       : 3,
    id            : androidId ? Long.fromString(androidId) : undefined,
    securityToken : securityToken
      ? Long.fromString(securityToken, true)
      : undefined,
  };
  const errMsg = AndroidCheckinRequest.verify(payload);
  if (errMsg) throw Error(errMsg);
  const message = AndroidCheckinRequest.create(payload);
  return AndroidCheckinRequest.encode(message).finish();
}
