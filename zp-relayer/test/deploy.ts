import path from 'path'
import compose from 'docker-compose'
import Web3 from 'web3'

const web3 = new Web3('http://127.0.0.1:8545')

function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

async function waitForNode() {
  let isRunning = false
  do {
    try {
      await web3.eth.getChainId()
      isRunning = true
    } catch (e) {}
    await sleep(100)
  } while (!isRunning)
}

async function waitForContracts() {
  let bytecode = '0x'
  do {
    try {
    bytecode = await web3.eth.getCode('0xe982E462b094850F12AF94d21D470e21bE9D0E9C')
    await sleep(200)
    } catch(e) {}
  } while (bytecode === '0x')
}

export async function newDeploy() {
  const cwd = path.join(__dirname)
  console.log('Removing previous deployment...')
  await compose.down({ cwd, commandOptions: ['-v'], log: false })
  console.log('Starting new deployment...')
  await compose.upOne('anvil', { cwd, log: false })
  console.log('Waiting for RPC node...')
  await waitForNode()
  await compose.upAll({ cwd, log: false })
  console.log('Waiting for contracts...')
  await waitForContracts()
}

newDeploy()
