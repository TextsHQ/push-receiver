const Client = require('../src');
const senderId = require('yargs').argv.senderId;

if (!senderId) {
  throw new Error('Missing senderId');
}

// twitter sender ID: BF5oEo0xDUpgylKDTlsd8pZmxQA1leYINiY-rSscWYK_3tWAkz4VMbtf1MLE_Yyd6iII6o-e3Q9TCN5vZMzVMEs

(async () => {
  const client = new Client(__dirname + '/client.json');
  client.startListening();
  client.on('notification', notification => {
    console.log('Notification received');
    console.log(notification);
  });
  const registrationInfo = await client.register('web', senderId);
  console.log(registrationInfo);
})();
