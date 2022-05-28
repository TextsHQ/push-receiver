const Client = require('..').default
const { senderId } = require('yargs').argv

if (!senderId) {
  throw new Error('Missing senderId')
}

// twitter sender ID: BF5oEo0xDUpgylKDTlsd8pZmxQA1leYINiY-rSscWYK_3tWAkz4VMbtf1MLE_Yyd6iII6o-e3Q9TCN5vZMzVMEs

(async () => {
  const client = new Client(__dirname + '/client.json')
  client.startListening()
  const registrationInfo = await client.register(senderId)
  console.log(registrationInfo)
  client.on('message', async message => {
    console.log('Notification received')
    console.log(message)
    console.log('deleting registration...')
    await client.unregister(senderId, registrationInfo.app)
    console.log('deleted!')
  })
})()
