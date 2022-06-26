const path = require('path')
const { FileStore, CheckinClient, MCSClient, GCMRegistrar } = require('..')

// eslint-disable-next-line
const { senderId } = require('yargs').argv
if (!senderId) {
  throw new Error('Missing senderId')
}

// twitter sender ID: BF5oEo0xDUpgylKDTlsd8pZmxQA1leYINiY-rSscWYK_3tWAkz4VMbtf1MLE_Yyd6iII6o-e3Q9TCN5vZMzVMEs

(async () => {
  const store = await FileStore.create(path.join(__dirname, 'client.json'))
  const checkinClient = new CheckinClient(store)
  const mcsClient = new MCSClient(checkinClient, store)
  const registrar = new GCMRegistrar(checkinClient)

  mcsClient.startListening()

  const registrationInfo = await registrar.register(senderId)
  console.log(registrationInfo)

  mcsClient.on('message', async message => {
    console.log('Notification received')
    console.log(message)
    // console.log('deleting registration...')
    // await registrar.unregister(senderId, registrationInfo.app)
    // console.log('deleted!')
  })
})()
