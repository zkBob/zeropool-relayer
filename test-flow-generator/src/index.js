const puppeteer = require('puppeteer')
const fs = require('fs')
const { createServer } = require('http-server')
const FLOW = require('../flow.json')
const { Proof, Params } = require('libzkbob-rs-node')

const FLOWS_DIR = 'flows/'
const PARAMS = Params.fromFile(process.env.PARAMS_PATH || '../zp-relayer/params/transfer_params.bin')

if (!fs.existsSync(FLOWS_DIR)) {
  fs.mkdirSync(FLOWS_DIR, { recursive: true })
}

function proveTx(pub, sec) {
  return Proof.tx(PARAMS, pub, sec)
}

async function generateFlow() {
  const browser = await puppeteer.launch()
  try {
    const page = await browser.newPage()
    page.on('console', async msg => {
      const msgArgs = msg.args()
      for (let i = 0; i < msgArgs.length; ++i) {
        console.log(msgArgs[i].toString())
      }
    })
    await page.goto('http://127.0.0.1:8080/')
    const res = await page.evaluate(async flow => {
      await init()
      const acc = await newAccount()
      const flowOutput = await createFlow(acc, flow)
      return flowOutput
    }, FLOW)

    for (let tx of res) {
      const proof = proveTx(tx.transactionData.public, tx.transactionData.secret)
      tx.proof = proof
    }

    fs.writeFileSync(`${FLOWS_DIR}/test_flow.json`, JSON.stringify(res, null, 2))
  } finally {
    await browser.close()
  }
}

async function main() {
  const server = createServer({
    root: '.',
    cors: true,
  })
  server.listen(8080, async () => {
    try {
      await generateFlow()
    } catch (err) {
      console.log(err.toString())
    } finally {
      server.close()
    }
  })
}

main()
