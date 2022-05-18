const { register, checkIn } = require('./gcm');
const Client = require('./client.js');

module.exports = {
  listen,
  register,
  checkIn,
};

async function listen(clientInfo, notificationCallback) {
  if (!clientInfo) {
    throw new Error('Missing clientInfo');
  }
  if (!clientInfo.androidId) {
    throw new Error('Missing androidId in clientInfo');
  }
  if (!clientInfo.securityToken) {
    throw new Error('Missing securityToken in clientInfo');
  }
  const client = new Client(clientInfo, clientInfo.persistentIds);
  client.on('ON_NOTIFICATION_RECEIVED', notificationCallback);
  client.connect();
  return client;
}
