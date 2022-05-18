const { readFile, writeFile } = require('fs/promises');
const { register, listen, checkIn } = require('../src');
const senderId = require('yargs').argv.senderId;

if (!senderId) {
  throw new Error('Missing senderId');
}

// twitter sender ID: BF5oEo0xDUpgylKDTlsd8pZmxQA1leYINiY-rSscWYK_3tWAkz4VMbtf1MLE_Yyd6iII6o-e3Q9TCN5vZMzVMEs

(async () => {
  const clientFile = __dirname + '/client.json';
  let existingClientInfo;
  try {
    existingClientInfo = JSON.parse((await readFile(clientFile)).toString());
  } catch (e) {
    existingClientInfo = null;
  }
  const clientInfo = await checkIn(existingClientInfo);
  await writeFile(clientFile, JSON.stringify(clientInfo));
  const registrationInfo = await register(clientInfo, senderId); // You should call register only once and then store the credentials somewhere
  const gcmToken = registrationInfo.token; // Token to use to send notifications
  console.log('Use this following token to send a notification', gcmToken);
  // persistentIds is the list of notification ids received to avoid receiving all already received notifications on start.
  const persistentIds = []; // get all previous persistentIds from somewhere (file, db, etc...)
  await listen({ ...clientInfo, persistentIds }, notification => {
    console.log('Notification received');
    console.log(notification);
  });
})();
